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
import { RpcProcess, DIALOG_UI_METHODS } from './rpc-process'
import { withArgSpec } from './command-args'
import { convertAgentMessages } from './agent-messages'
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

/**
 * TUI built-ins that have direct RPC equivalents. They are not part of
 * get_commands (TUI-only list), so we surface and route them ourselves.
 */
const RPC_BUILTINS: SlashCommand[] = [
  {
    name: 'compact',
    description: 'Compress the conversation context',
    source: 'builtin',
    insertText: '/compact',
  },
  {
    name: 'export',
    description: 'Export the session to an HTML file',
    source: 'builtin',
    insertText: '/export',
  },
  {
    name: 'name',
    description: 'Set the session display name — /name <title>',
    source: 'builtin',
    insertText: '/name ',
  },
  {
    name: 'stats',
    description: 'Show token usage, cost and context stats',
    source: 'builtin',
    insertText: '/stats',
  },
  {
    name: 'tree',
    description: 'Show the session branch tree',
    source: 'builtin',
    insertText: '/tree',
  },
]

const BUILTIN_PATTERN = /^\/(compact|export|name|stats|tree)(?:\s+([\s\S]*))?$/

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
    const builtin = BUILTIN_PATTERN.exec(message.trim())
    if (builtin) {
      await this.runBuiltin(sessionId, entry, builtin[1], (builtin[2] ?? '').trim())
      return
    }
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
    // Builtins work regardless of streaming state.
    const builtin = BUILTIN_PATTERN.exec(text.trim())
    if (builtin) {
      await this.runBuiltin(sessionId, entry, builtin[1], (builtin[2] ?? '').trim())
      return
    }
    // pi's steer never rejects when idle — it silently queues the text for
    // the NEXT run. Check state first so a stale 'thinking' status in the
    // renderer doesn't swallow the message into the wrong place.
    const state = await this.quietGetState(entry)
    if (state && !state.isStreaming) {
      await entry.rpc.request({ type: 'prompt', message: text })
      return
    }
    await entry.rpc.request({ type: 'steer', message: text })
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
    const commands = this.enrichCommands(entry, data?.commands ?? [])
    entry.commandsCache = commands
    return commands
  }

  /** Merge builtins + arg specs (workflow ids etc.) onto the RPC command list. */
  private enrichCommands(entry: ActiveSession, rpcCommands: RpcCommand[]): SlashCommand[] {
    return RPC_BUILTINS.concat(
      rpcCommands.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        source: c.source,
        insertText: `/${c.name}`,
      }))
    ).map((c) => withArgSpec(c, entry.cwd))
  }

  /** Fork the session from a previous user message; returns the rebuilt chat. */
  async forkFrom(
    sessionId: string,
    entryId: string
  ): Promise<{ messages: import('@shared/types').Message[] }> {
    const entry = this.getOrThrow(sessionId)
    const result = await entry.rpc.request<{ cancelled?: boolean }>({ type: 'fork', entryId })
    if (result?.cancelled) throw new Error('Fork cancelled by an extension')
    const data = await entry.rpc.request<{ messages?: unknown[] }>({ type: 'get_messages' })
    entry.onEvent('pi:session-ready', {
      sessionId,
      sdkSessionId: entry.sdkSessionId,
    })
    return { messages: convertAgentMessages(data?.messages ?? []) }
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
    let result: { cancelled?: boolean }
    try {
      result = await entry.rpc.request<{ cancelled?: boolean }>({
        type: 'switch_session',
        sessionPath,
      })
    } catch (err) {
      // Corrupt file / missing file / protocol failure — don't leak the
      // spawned subprocess and phantom session entry on every retry.
      this.closeSession(sessionId)
      throw err
    }
    if (result?.cancelled) {
      this.closeSession(sessionId)
      throw new Error('Session switch cancelled by an extension')
    }
    await this.captureState(entry).catch(() => undefined)
    entry.onEvent('pi:session-ready', {
      sessionId,
      sdkSessionId: entry.sdkSessionId,
    })
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

  /** Live sessions with their in-subprocess (JSONL) ids, for sidebar highlighting. */
  getActiveSessionsWithSdk(): Array<{ sessionId: string; sdkSessionId: string | null }> {
    return Array.from(this.sessions.entries()).map(([sessionId, entry]) => ({
      sessionId,
      sdkSessionId: entry.sdkSessionId,
    }))
  }

  /** Dispose every session subprocess (app shutdown). */
  disposeAll(): void {
    for (const entry of this.sessions.values()) {
      void entry.rpc.dispose()
    }
    this.sessions.clear()
  }

  /** Answer a forwarded extension UI dialog (select/confirm/input/editor). */
  async uiRespond(
    sessionId: string,
    requestId: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): Promise<void> {
    const entry = this.getOrThrow(sessionId)
    entry.rpc.writeUiResponse({ type: 'extension_ui_response', id: requestId, ...response })
  }

  /**
   * Cycle to the next model (Ctrl+P). When favorites ("provider/modelId")
   * are configured the pool is limited to them; otherwise all available
   * models are cycled.
   */
  async cycleModel(
    sessionId: string,
    favorites: string[],
    backward = false
  ): Promise<{ provider: string; modelId: string; displayName: string }> {
    const entry = this.getOrThrow(sessionId)
    const state = await entry.rpc.request<{
      model?: { id?: string; provider?: string; name?: string } | null
    }>({ type: 'get_state' })
    const data = await entry.rpc.request<{
      models?: Array<{ id: string; provider: string; name?: string }>
    }>({ type: 'get_available_models' })
    const all = (data?.models ?? []).filter(
      (m) => typeof m.id === 'string' && typeof m.provider === 'string'
    )
    const favSet = new Set(favorites)
    const pool = favorites.length > 0 ? all.filter((m) => favSet.has(`${m.provider}/${m.id}`)) : all
    if (pool.length === 0) throw new Error('No models available to cycle')
    const currentKey = state?.model ? `${state.model.provider}/${state.model.id}` : ''
    const currentIndex = pool.findIndex((m) => `${m.provider}/${m.id}` === currentKey)
    const step = backward ? -1 : 1
    const nextIndex = ((currentIndex === -1 ? 0 : currentIndex + step) + pool.length) % pool.length
    const next = pool[nextIndex]!
    if (currentIndex !== -1 && `${next.provider}/${next.id}` === currentKey) {
      // Already the only model in the pool — nothing to switch
      return { provider: next.provider, modelId: next.id, displayName: next.name ?? next.id }
    }
    await entry.rpc.request({ type: 'set_model', provider: next.provider, modelId: next.id })
    return { provider: next.provider, modelId: next.id, displayName: next.name ?? next.id }
  }

  /** Set an exact thinking level (Toolbar level buttons). */
  async setThinking(sessionId: string, level: AppThinkingLevel): Promise<void> {
    const entry = this.getOrThrow(sessionId)
    await entry.rpc.request({ type: 'set_thinking_level', level })
  }

  /** Cycle to the next thinking level the current model supports (Shift+Tab). */
  async cycleThinking(sessionId: string): Promise<{ level: AppThinkingLevel; levels: string[] }> {
    const entry = this.getOrThrow(sessionId)
    const state = await entry.rpc.request<{ thinkingLevel?: string }>({ type: 'get_state' })
    const data = await entry.rpc.request<{ levels?: string[] }>({
      type: 'get_available_thinking_levels',
    })
    const levels = data?.levels?.length ? data.levels : ['off']
    const currentIndex = levels.indexOf(String(state?.thinkingLevel ?? 'off'))
    const nextIndex = ((currentIndex === -1 ? 0 : currentIndex + 1) + levels.length) % levels.length
    const level = levels[nextIndex]! as AppThinkingLevel
    await entry.rpc.request({ type: 'set_thinking_level', level })
    return { level, levels }
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
    try {
      rpc.start() // throws synchronously if the pi CLI cannot be located
    } catch (err) {
      this.sessions.delete(sessionId) // don't leak a phantom never-started entry
      throw err
    }
    // Let the tab show a distinct "booting" state until the first stdout line.
    entry.onEvent('pi:booting', { sessionId })
    this.warmup(entry)
    return { sessionId, entry }
  }

  private attachRpc(sessionId: string, entry: ActiveSession, rpc: RpcProcess): void {
    rpc.on('agent-event', (ev: Record<string, unknown>) => {
      this.handleRpcEvent(sessionId, entry, ev)
    })
    rpc.on('ui-request', (req: Record<string, unknown>) => {
      this.handleUiRequest(sessionId, entry, req)
    })
    // EventEmitter 'error' with zero listeners throws and would kill the
    // whole main process on spawn failure — always route it to recovery.
    rpc.on('error', (err: Error) => {
      console.error('[session-service] rpc error:', err)
      this.handleUnexpectedExit(sessionId, entry)
    })
    rpc.on('exit', () => {
      this.handleUnexpectedExit(sessionId, entry)
    })
  }

  /** Forward a blocking extension dialog to the host UI as a pi:ui-request event. */
  private handleUiRequest(
    sessionId: string,
    entry: ActiveSession,
    req: Record<string, unknown>
  ): void {
    const method = String(req['method'] ?? '')
    const requestId = req['id']
    if (typeof requestId !== 'string') return
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    if (method === 'notify') {
      // Fire-and-forget notifications surface as a toast so extension errors
      // (e.g. TUI-only commands like /btw) are not swallowed silently.
      entry.onEvent('pi:notify', {
        sessionId,
        message: str(req['message']) ?? '',
        level: str(req['notifyType']) ?? 'info',
      })
      return
    }
    if (method === 'setWidget') {
      // Extension info panels (contacts, model info, …) — lines, or clear.
      entry.onEvent('pi:widget', {
        sessionId,
        widgetKey: str(req['widgetKey']) ?? '',
        lines: Array.isArray(req['widgetLines']) ? (req['widgetLines'] as string[]) : null,
        placement: str(req['widgetPlacement']) ?? 'aboveEditor',
      })
      return
    }
    if (method === 'setStatus') {
      // Footer status entries — text, or clear.
      entry.onEvent('pi:status', {
        sessionId,
        statusKey: str(req['statusKey']) ?? '',
        text: str(req['statusText']) ?? null,
      })
      return
    }
    if (!DIALOG_UI_METHODS.has(method)) return
    entry.onEvent('pi:ui-request', {
      sessionId,
      requestId,
      method: method as 'select' | 'confirm' | 'input' | 'editor',
      title: str(req['title']),
      message: str(req['message']),
      placeholder: str(req['placeholder']),
      prefill: str(req['prefill']),
      options: Array.isArray(req['options']) ? (req['options'] as string[]) : undefined,
    })
  }

  /** Execute a TUI built-in via its direct RPC equivalent and render the result in chat. */
  private async runBuiltin(
    sessionId: string,
    entry: ActiveSession,
    name: string,
    args: string
  ): Promise<void> {
    try {
      switch (name) {
        case 'compact': {
          const r = await entry.rpc.request<{
            summary?: string
            estimatedTokensAfter?: number
            tokensBefore?: number
          }>({ type: 'compact', customInstructions: args || undefined })
          const from =
            typeof r?.tokensBefore === 'number'
              ? ` (~${Math.round(r.tokensBefore / 1000)}k tokens)`
              : ''
          const to =
            typeof r?.estimatedTokensAfter === 'number'
              ? ` → ~${Math.round(r.estimatedTokensAfter / 1000)}k`
              : ''
          this.emitAssistantText(
            sessionId,
            entry,
            `**Compacted.**${from}${to}${r?.summary ? `\n\n${r.summary}` : ''}`
          )
          break
        }
        case 'name': {
          if (!args) {
            this.emitAssistantText(sessionId, entry, 'Usage: `/name <title>`')
            break
          }
          await entry.rpc.request({ type: 'set_session_name', name: args })
          this.emitAssistantText(sessionId, entry, `Session name set to **${args}**.`)
          // Let the sidebar pick up the new name immediately.
          entry.onEvent('pi:session-ready', {
            sessionId,
            sdkSessionId: entry.sdkSessionId,
          })
          break
        }
        case 'stats': {
          const s = await entry.rpc.request<{
            userMessages?: number
            assistantMessages?: number
            toolCalls?: number
            totalMessages?: number
            tokens?: { total?: number }
            cost?: number
            contextUsage?: {
              tokens?: number | null
              contextWindow?: number
              percent?: number | null
            }
          }>({ type: 'get_session_stats' })
          const ctx =
            s?.contextUsage && s.contextUsage.tokens != null && s.contextUsage.percent != null
              ? `\n- Context: ~${Math.round(s.contextUsage.tokens / 1000)}k / ${Math.round((s.contextUsage.contextWindow ?? 0) / 1000)}k tokens (${s.contextUsage.percent}%)`
              : ''
          this.emitAssistantText(
            sessionId,
            entry,
            `**Session stats**\n- Messages: ${s?.totalMessages ?? 0} (${s?.userMessages ?? 0} user, ${s?.assistantMessages ?? 0} assistant)\n- Tool calls: ${s?.toolCalls ?? 0}\n- Tokens: ~${Math.round((s?.tokens?.total ?? 0) / 1000)}k\n- Cost: $${(s?.cost ?? 0).toFixed(3)}${ctx}`
          )
          break
        }
        case 'tree': {
          const t = await entry.rpc.request<{ tree?: TreeNode[] }>({ type: 'get_tree' })
          this.emitAssistantText(
            sessionId,
            entry,
            `**Session tree**\n\n\`\`\`\n${renderTreeText(t?.tree ?? [])}\n\`\`\``
          )
          // Interactive branch picker: user-message nodes are fork points.
          entry.onEvent('pi:tree-picker', {
            sessionId,
            nodes: flattenTree(t?.tree ?? []),
          })
          break
        }
        case 'export': {
          const e = await entry.rpc.request<{ path?: string }>({
            type: 'export_html',
            outputPath: args || undefined,
          })
          this.emitAssistantText(
            sessionId,
            entry,
            e?.path ? `Session exported to:\n\`${e.path}\`` : 'Export failed — no path returned.'
          )
          break
        }
      }
    } catch (err) {
      entry.onEvent('pi:error', { sessionId, message: String(err) })
    }
  }

  /** Render text as a one-shot assistant message (token + idle events). */
  private emitAssistantText(sessionId: string, entry: ActiveSession, text: string): void {
    entry.onEvent('pi:token', { sessionId, delta: text })
    entry.onEvent('pi:idle', { sessionId })
  }

  /** Fetch sessionFile/sdkSessionId and prime the slash-command cache in the background. */
  private warmup(entry: ActiveSession): void {
    const sessionId = Array.from(this.sessions.entries()).find(([, e]) => e === entry)?.[0] ?? ''
    entry.rpc.booted
      .then(async () => {
        await this.captureState(entry).catch(() => undefined)
        entry.onEvent('pi:session-ready', {
          sessionId,
          sdkSessionId: entry.sdkSessionId,
        })
        if (!entry.commandsCache) {
          await entry.rpc
            .request<{ commands?: RpcCommand[] }>({ type: 'get_commands' })
            .then((data) => {
              entry.commandsCache = this.enrichCommands(entry, data?.commands ?? [])
            })
            .catch(() => undefined)
        }
      })
      .catch((err) => {
        // Boot watchdog fired (dispose() suppresses the exit event) — without
        // this the tab would sit in 'booting' forever with the input disabled.
        entry.onEvent('pi:error', {
          sessionId,
          message: `pi failed to boot: ${err instanceof Error ? err.message : String(err)}`,
        })
      })
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
      // Only the settled event means the run is truly over (retries,
      // compaction and queued follow-ups included). Mapping agent_end too
      // re-enabled the input mid-run and caused send-race fallbacks.
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
    if (entry.restartAttempts >= 1 || !entry.sessionFile) {
      // No recovery possible — tell the tab it's terminal instead of the
      // misleading "Attempting to recover…" followed by silence.
      entry.onEvent('pi:error', {
        sessionId,
        message: 'The pi process exited and could not be recovered. Please start a new session.',
      })
      this.sessions.delete(sessionId)
      return
    }
    entry.onEvent('pi:error', {
      sessionId,
      message: 'The pi process exited unexpectedly. Attempting to recover…',
    })
    entry.restartAttempts++
    entry.commandsCache = null
    entry.toolStarts.clear()
    try {
      const rpc = new RpcProcess({ cwd: entry.cwd, args: entry.spawnArgs })
      entry.rpc = rpc
      this.attachRpc(sessionId, entry, rpc)
      rpc.start()
      entry.onEvent('pi:booting', { sessionId })
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

/** Minimal shape of a get_tree response node. */
interface TreeNode {
  entry?: { id?: string; type?: string; message?: { role?: string; content?: unknown } }
  label?: string
  children?: TreeNode[]
}

/** Flatten the tree for the interactive picker; user messages are fork points. */
function flattenTree(nodes: TreeNode[]): Array<{
  id: string
  role: string
  text: string
  label?: string
  depth: number
  clickable: boolean
}> {
  const result: Array<{
    id: string
    role: string
    text: string
    label?: string
    depth: number
    clickable: boolean
  }> = []
  // Iterative DFS — pi nests linearly (one entry per level), so long
  // sessions overflow the call stack with naive recursion.
  const stack: Array<{ node: TreeNode; depth: number }> = []
  for (let i = nodes.length - 1; i >= 0; i--) {
    stack.push({ node: nodes[i]!, depth: 0 })
  }
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    const msg = node.entry?.message
    const role = msg?.role ?? node.entry?.type ?? ''
    const text =
      typeof msg?.content === 'string'
        ? msg.content
        : Array.isArray(msg?.content)
          ? (msg.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text')
              .map((c) => c.text ?? '')
              .join('')
          : ''
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 90)
    const id = node.entry?.id ?? ''
    if (id) {
      result.push({
        id,
        role,
        text: snippet,
        label: node.label,
        depth,
        clickable: msg?.role === 'user',
      })
    }
    if (node.children?.length) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i]!, depth: depth + 1 })
      }
    }
  }
  return result
}

/** Render the session entry tree as readable indented text. */
function renderTreeText(nodes: TreeNode[], depth = 0): string {
  const lines: string[] = []
  for (const node of nodes) {
    const label = node.label ? ` [${node.label}]` : ''
    const msg = node.entry?.message
    let summary = node.entry?.type ?? '?'
    if (msg?.role) {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('')
            : ''
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 48)
      summary = msg.role === 'user' ? `user: ${snippet}` : `assistant: ${snippet}`
    } else if (node.entry?.type === 'model_change') {
      summary = 'model change'
    }
    lines.push(`${'  '.repeat(depth)}• ${summary}${label}`)
    if (node.children?.length) {
      lines.push(...renderTreeText(node.children, depth + 1))
    }
  }
  return lines.join('\n')
}
