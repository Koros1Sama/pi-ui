// src/main/session-service.ts
//
// Session engine backed by `pi --mode rpc` subprocesses — one per tab.
// Replaces the old in-process SDK engine: the subprocess runs the exact CLI
// binary the user uses day-to-day, so models, slash commands, skills, prompt
// templates and extension commands are always current, and Arabic text flows
// through the UI untouched (no terminal involved).
//
// Public surface intentionally mirrors the old engine (createSession / send /
// steer / abort / listCommands / closeSession / getActiveSessionIds) plus
// resumeSession/setModel which replace the old in-process resume path.
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { RpcProcess } from './rpc-process'
import type { PiEventName, PiEventPayloads, SlashCommand, ToolResultDetails } from '@shared/types'
import type { AppThinkingLevel } from '@shared/types'

type EventCallback = <E extends PiEventName>(event: E, payload: PiEventPayloads[E]) => void

export interface CreateSessionOpts {
  cwd: string
  model: string
  provider: string
  thinkingLevel: AppThinkingLevel
  name?: string
}

/** Command entry returned by the RPC `get_commands` response. */
interface RpcCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
}

interface ActiveSession {
  rpc: RpcProcess
  onEvent: EventCallback
  cwd: string
  /** CLI args used at spawn — kept for crash restart. */
  spawnArgs: string[]
  /** Last known session file (from get_state) — used to recover after a crash. */
  sessionFile: string | null
  /** Session id inside the pi subprocess (the JSONL header id). */
  sdkSessionId: string | null
  commandsCache: SlashCommand[] | null
  restartAttempts: number
  /** toolCallId → start timestamp, for durationMs on pi:tool-end. */
  toolStarts: Map<string, number>
}

export class SessionService {
  private readonly sessions = new Map<string, ActiveSession>()

  /**
   * A live, booted RPC subprocess other services may reuse (e.g. the model
   * service asking for get_available_models without paying for a hub boot).
   */
  getSharedRpc(): RpcProcess | null {
    for (const entry of this.sessions.values()) {
      if (!entry.rpc.exited) return entry.rpc
    }
    return null
  }

  async createSession(
    opts: CreateSessionOpts,
    onEvent: EventCallback
  ): Promise<{ sessionId: string }> {
    const args: string[] = []
    if (opts.provider) args.push('--provider', opts.provider)
    if (opts.model) {
      // --model accepts "provider/id" plus an optional ":thinking" suffix
      const modelRef = opts.model.includes('/')
        ? opts.model
        : opts.provider
          ? `${opts.provider}/${opts.model}`
          : opts.model
      args.push('--model', `${modelRef}:${opts.thinkingLevel}`)
    }
    if (opts.name) args.push('--name', opts.name)
    return this.attachAndRegister(opts.cwd, args, onEvent)
  }

  async send(sessionId: string, message: string): Promise<void> {
    const entry = this.getOrThrow(sessionId)
    try {
      await entry.rpc.request({ type: 'prompt', message })
    } catch (err) {
      // The RPC protocol rejects a bare `prompt` while the agent is already
      // streaming. If that is what happened, queue it as a steering message.
      const state = await this.quietGetState(entry)
      if (state?.isStreaming) {
        await entry.rpc.request({ type: 'prompt', message, streamingBehavior: 'steer' })
        return
      }
      throw err
    }
  }

  async steer(sessionId: string, text: string): Promise<void> {
    const entry = this.getOrThrow(sessionId)
    try {
      await entry.rpc.request({ type: 'steer', message: text })
    } catch (err) {
      // `steer` only makes sense mid-stream; if the agent already settled,
      // fall back to a regular prompt so the message is not lost.
      const state = await this.quietGetState(entry)
      if (state && !state.isStreaming) {
        await entry.rpc.request({ type: 'prompt', message: text })
        return
      }
      throw err
    }
  }

  async abort(sessionId: string, onEvent: EventCallback): Promise<void> {
    const entry = this.getOrThrow(sessionId)
    await entry.rpc.request({ type: 'abort' })
    onEvent('pi:idle', { sessionId })
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    const entry = this.getOrThrow(sessionId)
    await entry.rpc.request({ type: 'set_model', provider, modelId })
  }

  async listCommands(sessionId: string): Promise<SlashCommand[]> {
    const entry = this.getOrThrow(sessionId)
    if (entry.commandsCache) return entry.commandsCache
    const data = await entry.rpc.request<{ commands?: RpcCommand[] }>({ type: 'get_commands' })
    const commands = (data?.commands ?? []).map((c) => ({
      name: c.name,
      description: c.description ?? '',
      source: c.source,
      insertText: `/${c.name}`,
    }))
    entry.commandsCache = commands
    return commands
  }

  /**
   * Resume a stored session file: spawn an RPC subprocess at the session's
   * original cwd, then `switch_session` onto the existing JSONL so history
   * and model choice carry over.
   */
  async resumeSession(
    sessionPath: string,
    onEvent: EventCallback
  ): Promise<{ sessionId: string; sdkSessionId: string }> {
    const cwd = await readCwdFromSessionFile(sessionPath)
    const { sessionId, entry } = this.attachAndRegister(cwd, [], onEvent)
    const result = await entry.rpc.request<{ cancelled?: boolean }>({
      type: 'switch_session',
      sessionPath,
    })
    if (result?.cancelled) {
      this.closeSession(sessionId)
      throw new Error('Session switch cancelled by an extension')
    }
    await this.captureState(entry).catch(() => undefined)
    return { sessionId, sdkSessionId: entry.sdkSessionId ?? sessionId }
  }

  closeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    void entry.rpc.dispose()
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys())
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private attachAndRegister(
    cwd: string,
    spawnArgs: string[],
    onEvent: EventCallback
  ): { sessionId: string; entry: ActiveSession } {
    const rpc = new RpcProcess({ cwd, args: spawnArgs })
    const sessionId = randomUUID()
    const entry: ActiveSession = {
      rpc,
      onEvent,
      cwd,
      spawnArgs,
      sessionFile: null,
      sdkSessionId: null,
      commandsCache: null,
      restartAttempts: 0,
      toolStarts: new Map(),
    }
    this.sessions.set(sessionId, entry)
    this.attachRpc(sessionId, entry, rpc)
    rpc.start() // throws synchronously if the pi CLI cannot be located
    this.warmup(entry)
    return { sessionId, entry }
  }

  private attachRpc(sessionId: string, entry: ActiveSession, rpc: RpcProcess): void {
    rpc.on('agent-event', (ev: Record<string, unknown>) => {
      this.handleRpcEvent(sessionId, entry, ev)
    })
    rpc.on('exit', () => {
      this.handleUnexpectedExit(sessionId, entry)
    })
  }

  /** Fetch sessionFile/sdkSessionId and prime the slash-command cache in the background. */
  private warmup(entry: ActiveSession): void {
    entry.rpc.booted
      .then(async () => {
        await this.captureState(entry).catch(() => undefined)
        if (!entry.commandsCache) {
          await entry.rpc
            .request<{ commands?: RpcCommand[] }>({ type: 'get_commands' })
            .then((data) => {
              entry.commandsCache = (data?.commands ?? []).map((c) => ({
                name: c.name,
                description: c.description ?? '',
                source: c.source,
                insertText: `/${c.name}`,
              }))
            })
            .catch(() => undefined)
        }
      })
      .catch(() => undefined)
  }

  private async captureState(entry: ActiveSession): Promise<void> {
    const state = await entry.rpc.request<{
      sessionFile?: string
      sessionId?: string
    }>({ type: 'get_state' })
    if (state?.sessionFile) entry.sessionFile = state.sessionFile
    if (state?.sessionId) entry.sdkSessionId = state.sessionId
  }

  private async quietGetState(entry: ActiveSession): Promise<{ isStreaming?: boolean } | null> {
    try {
      return await entry.rpc.request<{ isStreaming?: boolean }>({ type: 'get_state' })
    } catch {
      return null
    }
  }

  private handleRpcEvent(
    sessionId: string,
    entry: ActiveSession,
    ev: Record<string, unknown>
  ): void {
    switch (ev['type']) {
      case 'message_update': {
        const delta = ev['assistantMessageEvent'] as { type?: string; delta?: string } | undefined
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
          entry.onEvent('pi:token', { sessionId, delta: delta.delta })
        }
        break
      }
      case 'tool_execution_start': {
        const toolCallId = String(ev['toolCallId'] ?? '')
        entry.toolStarts.set(toolCallId, Date.now())
        entry.onEvent('pi:tool-start', {
          sessionId,
          toolCallId,
          toolName: String(ev['toolName'] ?? ''),
          args: (ev['args'] as Record<string, unknown> | undefined) ?? {},
        })
        break
      }
      case 'tool_execution_end': {
        const toolCallId = String(ev['toolCallId'] ?? '')
        const started = entry.toolStarts.get(toolCallId)
        entry.toolStarts.delete(toolCallId)
        const { resultText, details } = convertToolResult(ev['result'])
        entry.onEvent('pi:tool-end', {
          sessionId,
          toolCallId,
          toolName: String(ev['toolName'] ?? ''),
          result: resultText,
          details,
          isError: ev['isError'] === true,
          durationMs: started ? Date.now() - started : 0,
        })
        break
      }
      case 'turn_end':
        entry.onEvent('pi:turn-end', { sessionId })
        break
      case 'agent_end':
      case 'agent_settled':
        entry.onEvent('pi:idle', { sessionId })
        break
      case 'extension_error':
        entry.onEvent('pi:error', {
          sessionId,
          message: String(ev['error'] ?? 'extension error'),
        })
        break
      default:
        break
    }
  }

  private handleUnexpectedExit(sessionId: string, entry: ActiveSession): void {
    if (this.sessions.get(sessionId) !== entry) return
    entry.onEvent('pi:error', {
      sessionId,
      message: 'The pi process exited unexpectedly. Attempting to recover…',
    })
    if (entry.restartAttempts >= 1 || !entry.sessionFile) {
      this.sessions.delete(sessionId)
      return
    }
    entry.restartAttempts++
    entry.commandsCache = null
    entry.toolStarts.clear()
    try {
      const rpc = new RpcProcess({ cwd: entry.cwd, args: [] })
      entry.rpc = rpc
      this.attachRpc(sessionId, entry, rpc)
      rpc.start()
      rpc.booted
        .then(() => rpc.request({ type: 'switch_session', sessionPath: entry.sessionFile }))
        .then(() => this.warmup(entry))
        .catch(() => {
          if (this.sessions.get(sessionId) === entry) {
            entry.onEvent('pi:error', {
              sessionId,
              message: 'The pi process could not be restarted.',
            })
            this.sessions.delete(sessionId)
          }
        })
    } catch {
      this.sessions.delete(sessionId)
    }
  }

  private getOrThrow(sessionId: string): ActiveSession {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      throw new Error(
        `Session not found: ${sessionId}. Known: ${[...this.sessions.keys()].join(',')}`
      )
    }
    return entry
  }
}

/** Normalize an RPC tool result into the flat shape the renderer expects. */
function convertToolResult(raw: unknown): {
  resultText: string
  details: ToolResultDetails | null
} {
  const rawResult = raw as
    | {
        content?: Array<{ type: string; text?: string }>
        details?: { truncation?: unknown; fullOutputPath?: string }
      }
    | string
    | null
  if (typeof rawResult === 'string') {
    return { resultText: rawResult, details: null }
  }
  if (rawResult && Array.isArray(rawResult.content)) {
    const resultText = rawResult.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    let details: ToolResultDetails | null = null
    if (rawResult.details) {
      details = {
        truncation: rawResult.details.truncation as never,
        fullOutputPath: rawResult.details.fullOutputPath,
      }
    }
    return { resultText, details }
  }
  return { resultText: JSON.stringify(rawResult ?? ''), details: null }
}

/** Read the cwd recorded in a session JSONL header (first line). */
async function readCwdFromSessionFile(sessionPath: string): Promise<string> {
  try {
    const content = await readFile(sessionPath, 'utf8')
    const newlineIndex = content.indexOf('\n')
    const headerLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex)
    const header = JSON.parse(headerLine) as { type?: string; cwd?: string }
    if (header.type === 'session' && typeof header.cwd === 'string' && header.cwd) {
      return header.cwd
    }
  } catch (err) {
    console.error('[session-service] failed to read session header:', err)
  }
  return homedir()
}
