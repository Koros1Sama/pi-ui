// @vitest-environment node
// src/main/session-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionService } from './session-service'

// --- RpcProcess mock: records written commands, shared configurable responder ---
const rpcMock = vi.hoisted(() => {
  type Cmd = Record<string, unknown>

  // Shared per-test responder so tests can also steer requests made by
  // internally-spawned instances (e.g. resumeSession's switch_session).
  const shared = {
    responder: async (_cmd: Cmd): Promise<unknown> => undefined,
  }

  class FakeRpcProcess {
    static instances: Array<FakeRpcProcess> = []
    handlers = new Map<string, Array<(payload: unknown) => void>>()
    written: Cmd[] = []
    disposed = false
    exited = false
    booted: Promise<void> = Promise.resolve()

    constructor(public readonly opts: { cwd: string; args?: string[] }) {
      FakeRpcProcess.instances.push(this)
    }

    start(): void {}

    on(event: string, fn: (payload: unknown) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(fn)
      this.handlers.set(event, list)
      return this
    }

    emitCustom(event: string, payload: unknown): void {
      for (const fn of this.handlers.get(event) ?? []) fn(payload)
    }

    async request<T = unknown>(cmd: Cmd): Promise<T> {
      this.written.push(cmd)
      return (await shared.responder(cmd)) as T
    }

    writeUiResponse(payload: Cmd): void {
      this.written.push(payload)
    }

    async dispose(): Promise<void> {
      this.disposed = true
      this.exited = true
    }
  }
  return { FakeRpcProcess, shared }
})

vi.mock('./rpc-process', () => ({
  RpcProcess: rpcMock.FakeRpcProcess,
  DIALOG_UI_METHODS: new Set(['select', 'confirm', 'input', 'editor']),
}))

vi.mock('./command-args', () => ({
  withArgSpec: (cmd: { name: string }) => ({
    ...cmd,
    ...(cmd.name === 'workflow' ? { argChoices: ['tdd', 'pipeline'], argHint: 'workflow id' } : {}),
  }),
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: unknown) => {
    if (p === '/sessions/stored.jsonl') {
      return '{"type":"session","version":3,"id":"abc-123","timestamp":"2026-08-29T00:00:00.000Z","cwd":"D:\\\\proj"}\n'
    }
    throw new Error(`ENOENT: ${String(p)}`)
  }),
}))

type FakeRpc = InstanceType<typeof rpcMock.FakeRpcProcess>
const { FakeRpcProcess } = rpcMock

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function defaultHandler(cmd: Record<string, unknown>): Promise<unknown> {
  switch (cmd['type']) {
    case 'get_state':
      return Promise.resolve({
        sessionId: 'sdk-1',
        sessionFile: '/sessions/live.jsonl',
        isStreaming: false,
        thinkingLevel: 'low',
        model: { id: 'glm-5.3', provider: 'zai', name: 'GLM 5.3' },
      })
    case 'get_available_models':
      return Promise.resolve({
        models: [
          { id: 'glm-5.3', provider: 'zai', name: 'GLM 5.3' },
          { id: 'glm-5.3-flash', provider: 'zai', name: 'GLM 5.3 Flash' },
          { id: 'claude-sonnet-4-5', provider: 'anthropic', name: 'Claude Sonnet 4.5' },
        ],
      })
    case 'get_available_thinking_levels':
      return Promise.resolve({ levels: ['off', 'low', 'high', 'max'] })
    case 'get_commands':
      return Promise.resolve({
        commands: [
          { name: 'skill:brave-search', description: 'Web search via Brave API', source: 'skill' },
          { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
          { name: 'session-name', description: 'Set or clear session name', source: 'extension' },
          {
            name: 'workflow',
            description: 'List or run a predefined workflow',
            source: 'extension',
          },
        ],
      })
    case 'get_messages':
      return Promise.resolve({
        messages: [
          { role: 'user', content: 'rebuild me', timestamp: 1 },
          { role: 'assistant', content: [{ type: 'text', text: 'fork reply' }] },
        ],
      })
    case 'switch_session':
      return Promise.resolve({ cancelled: false })
    case 'compact':
      return Promise.resolve({
        summary: 'Summarized the chat',
        tokensBefore: 150000,
        estimatedTokensAfter: 32000,
      })
    case 'get_session_stats':
      return Promise.resolve({
        totalMessages: 10,
        userMessages: 5,
        assistantMessages: 5,
        toolCalls: 12,
        tokens: { total: 105000 },
        cost: 0.45,
        contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
      })
    case 'get_tree':
      return Promise.resolve({
        tree: [
          {
            entry: {
              id: 'e1',
              type: 'message',
              message: { role: 'user', content: 'hello tree' },
            },
            children: [
              {
                entry: {
                  id: 'e2',
                  type: 'message',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hi' }],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      })
    case 'export_html':
      return Promise.resolve({ path: '/tmp/session.html' })
    default:
      return Promise.resolve(undefined)
  }
}

describe('SessionService (RPC engine)', () => {
  let service: SessionService
  const onEvent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    FakeRpcProcess.instances.length = 0
    rpcMock.shared.responder = defaultHandler
    service = new SessionService()
  })

  function lastRpc(): FakeRpc {
    return FakeRpcProcess.instances[FakeRpcProcess.instances.length - 1]
  }

  async function createSession(
    opts: Partial<Parameters<SessionService['createSession']>[0]> = {}
  ): Promise<string> {
    const { sessionId } = await service.createSession(
      {
        cwd: '/tmp/project',
        model: 'glm-5.3',
        provider: 'zai',
        thinkingLevel: 'high',
        ...opts,
      },
      onEvent
    )
    return sessionId
  }

  describe('createSession', () => {
    it('returns a sessionId and spawns an RPC subprocess in the project cwd', async () => {
      const sessionId = await createSession()
      expect(typeof sessionId).toBe('string')
      expect(sessionId.length).toBeGreaterThan(0)
      const rpc = lastRpc()
      expect(rpc.opts.cwd).toBe('/tmp/project')
      expect(rpc.disposed).toBe(false)
    })

    it('passes provider, model+thinking and name as CLI args', async () => {
      await createSession({ name: 'My Session' })
      const args = lastRpc().opts.args ?? []
      expect(args).toContain('--provider')
      expect(args[args.indexOf('--provider') + 1]).toBe('zai')
      expect(args).toContain('--model')
      expect(args[args.indexOf('--model') + 1]).toBe('zai/glm-5.3:high')
      expect(args).toContain('--name')
      expect(args[args.indexOf('--name') + 1]).toBe('My Session')
    })

    it('omits provider/model flags when unset', async () => {
      await createSession({ provider: '', model: '' })
      const args = lastRpc().opts.args ?? []
      expect(args).not.toContain('--provider')
      expect(args).not.toContain('--model')
    })
  })

  describe('send', () => {
    it('writes a prompt command', async () => {
      const sessionId = await createSession()
      await service.send(sessionId, 'hello')
      const prompt = lastRpc()
        .written.filter((c) => c['type'] === 'prompt')
        .find((c) => c['message'] === 'hello')
      expect(prompt).toBeDefined()
      expect(prompt!['streamingBehavior']).toBeUndefined()
    })

    it('retries with streamingBehavior=steer when the agent is already streaming', async () => {
      const sessionId = await createSession()
      const rpc = lastRpc()
      let prompts = 0
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'prompt') {
          prompts++
          if (prompts === 1) {
            throw new Error('Agent is streaming; prompt requires streamingBehavior')
          }
          return undefined
        }
        if (cmd['type'] === 'get_state') {
          return { sessionId: 'sdk-1', sessionFile: '/sessions/live.jsonl', isStreaming: true }
        }
        return defaultHandler(cmd)
      }
      await service.send(sessionId, 'new instruction')
      const steered = rpc.written.filter((c) => c['type'] === 'prompt')[1]
      expect(steered['streamingBehavior']).toBe('steer')
    })

    it('throws for an unknown sessionId', async () => {
      await expect(service.send('bad-id', 'hi')).rejects.toThrow('Session not found: bad-id')
    })
  })

  describe('steer', () => {
    it('writes a steer command when the agent is streaming', async () => {
      const sessionId = await createSession()
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'get_state') {
          return { sessionId: 'sdk-1', sessionFile: '/sessions/live.jsonl', isStreaming: true }
        }
        return defaultHandler(cmd)
      }
      await service.steer(sessionId, 'please stop')
      expect(
        lastRpc().written.find((c) => c['type'] === 'steer' && c['message'] === 'please stop')
      ).toBeDefined()
    })

    it('falls back to a plain prompt when the agent already settled', async () => {
      const sessionId = await createSession()
      const rpc = lastRpc()
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'steer') throw new Error('Cannot steer while idle')
        return defaultHandler(cmd)
      }
      await service.steer(sessionId, 'actually a new message')
      expect(
        rpc.written.find((c) => c['type'] === 'prompt' && c['message'] === 'actually a new message')
      ).toBeDefined()
    })

    it('throws for unknown sessionId', async () => {
      await expect(service.steer('no-such-id', 'msg')).rejects.toThrow('Session not found')
    })
  })

  describe('abort', () => {
    it('writes an abort command and emits pi:idle', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      await service.abort(sessionId, onEvent)
      expect(lastRpc().written.some((c) => c['type'] === 'abort')).toBe(true)
      expect(onEvent).toHaveBeenCalledWith('pi:idle', { sessionId })
    })
  })

  describe('setModel', () => {
    it('writes a set_model command with provider and modelId', async () => {
      const sessionId = await createSession()
      await service.setModel(sessionId, 'zai', 'glm-5.3')
      expect(
        lastRpc().written.find(
          (c) => c['type'] === 'set_model' && c['provider'] === 'zai' && c['modelId'] === 'glm-5.3'
        )
      ).toBeDefined()
    })
  })

  describe('listCommands', () => {
    it('maps RPC get_commands entries to SlashCommand shape', async () => {
      const sessionId = await createSession()
      const cmds = await service.listCommands(sessionId)
      const names = cmds.map((c) => c.name)
      expect(names).toContain('skill:brave-search')
      expect(names).toContain('fix-tests')
      expect(names).toContain('session-name')
      const skill = cmds.find((c) => c.source === 'skill')!
      expect(skill.insertText).toBe('/skill:brave-search')
      expect(skill.description).toBe('Web search via Brave API')
      const extension = cmds.find((c) => c.source === 'extension')!
      expect(extension.insertText).toBe('/session-name')
    })

    it('caches the result — a second call does not re-request', async () => {
      const sessionId = await createSession()
      const rpc = lastRpc()
      await flush() // let warmup settle
      const before = rpc.written.filter((c) => c['type'] === 'get_commands').length
      await service.listCommands(sessionId)
      await service.listCommands(sessionId)
      const after = rpc.written.filter((c) => c['type'] === 'get_commands').length
      expect(after).toBe(before)
    })

    it('rejects for unknown sessionId', async () => {
      await expect(service.listCommands('no-such-id')).rejects.toThrow('Session not found')
    })
  })

  describe('event forwarding', () => {
    it('maps message_update text_delta to pi:token', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('agent-event', {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
      })
      expect(onEvent).toHaveBeenCalledWith('pi:token', { sessionId, delta: 'hello' })
    })

    it('maps tool_execution_start / tool_execution_end to pi:tool-start / pi:tool-end', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      const rpc = lastRpc()
      rpc.emitCustom('agent-event', {
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'ls' },
      })
      expect(onEvent).toHaveBeenCalledWith('pi:tool-start', {
        sessionId,
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'ls' },
      })

      rpc.emitCustom('agent-event', {
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'bash',
        result: {
          content: [
            { type: 'text', text: 'total 0' },
            { type: 'text', text: '\ndone' },
          ],
          details: { truncation: null, fullOutputPath: null },
        },
        isError: false,
      })
      expect(onEvent).toHaveBeenCalledWith(
        'pi:tool-end',
        expect.objectContaining({
          sessionId,
          toolCallId: 'call_1',
          toolName: 'bash',
          result: 'total 0\ndone',
          details: { truncation: null, fullOutputPath: null },
          isError: false,
        })
      )
    })

    it('stringifies a string tool result directly', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('agent-event', {
        type: 'tool_execution_end',
        toolCallId: 'call_2',
        toolName: 'read',
        result: 'plain text',
        isError: true,
      })
      expect(onEvent).toHaveBeenCalledWith(
        'pi:tool-end',
        expect.objectContaining({ sessionId, result: 'plain text', isError: true, details: null })
      )
    })

    it('maps turn_end to pi:turn-end', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('agent-event', { type: 'turn_end' })
      expect(onEvent).toHaveBeenCalledWith('pi:turn-end', { sessionId })
    })

    it('maps agent_settled (not agent_end) to pi:idle', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('agent-event', { type: 'agent_end' })
      expect(onEvent).not.toHaveBeenCalledWith('pi:idle', expect.anything())
      lastRpc().emitCustom('agent-event', { type: 'agent_settled' })
      expect(onEvent).toHaveBeenCalledWith('pi:idle', { sessionId })
      expect(onEvent).toHaveBeenCalledTimes(1)
    })

    it('emits pi:booting when the subprocess spawns', async () => {
      onEvent.mockClear()
      await createSession()
      expect(onEvent).toHaveBeenCalledWith('pi:booting', {
        sessionId: expect.any(String),
      })
    })

    it('maps extension_error to pi:error', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('agent-event', {
        type: 'extension_error',
        extensionPath: '/ext.ts',
        event: 'tool_call',
        error: 'boom',
      })
      expect(onEvent).toHaveBeenCalledWith('pi:error', { sessionId, message: 'boom' })
    })
  })

  describe('closeSession', () => {
    it('disposes the subprocess and removes the session', async () => {
      const sessionId = await createSession()
      const rpc = lastRpc()
      service.closeSession(sessionId)
      expect(rpc.disposed).toBe(true)
      await expect(service.send(sessionId, 'hi')).rejects.toThrow('Session not found')
    })
  })

  describe('unexpected exit', () => {
    it('emits pi:error and drops the session when no session file is known', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      const rpc = lastRpc()
      rpc.exited = true
      rpc.emitCustom('exit', new Error('crashed'))
      expect(onEvent).toHaveBeenCalledWith('pi:error', expect.objectContaining({ sessionId }))
      await expect(service.send(sessionId, 'hi')).rejects.toThrow('Session not found')
    })
  })

  describe('resumeSession', () => {
    it('spawns at the stored cwd, switches onto the session file and reports the sdk id', async () => {
      const { sessionId, sdkSessionId } = await service.resumeSession(
        '/sessions/stored.jsonl',
        onEvent
      )
      expect(typeof sessionId).toBe('string')
      expect(sdkSessionId).toBe('sdk-1')
      const rpc = lastRpc()
      expect(rpc.opts.cwd).toBe('D:\\proj')
      expect(
        rpc.written.find(
          (c) => c['type'] === 'switch_session' && c['sessionPath'] === '/sessions/stored.jsonl'
        )
      ).toBeDefined()
    })

    it('throws when an extension cancels the switch', async () => {
      rpcMock.shared.responder = async (cmd) =>
        cmd['type'] === 'switch_session' ? { cancelled: true } : defaultHandler(cmd)
      await expect(service.resumeSession('/sessions/stored.jsonl', onEvent)).rejects.toThrow(
        'cancelled'
      )
    })
  })

  describe('getSharedRpc', () => {
    it('exposes a live session subprocess for the model service', async () => {
      expect(service.getSharedRpc()).toBeNull()
      await createSession()
      expect(service.getSharedRpc()).toBeInstanceOf(FakeRpcProcess)
      const sessionId = service.getActiveSessionIds()[0] ?? ''
      service.closeSession(sessionId)
      expect(service.getSharedRpc()).toBeNull()
    })
  })

  describe('built-in slash commands (RPC equivalents)', () => {
    it('routes /compact to the RPC compact command and renders a summary', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      await service.send(sessionId, '/compact')
      const rpc = lastRpc()
      expect(rpc.written.some((c) => c['type'] === 'compact')).toBe(true)
      expect(rpc.written.some((c) => c['type'] === 'prompt')).toBe(false)
      expect(onEvent).toHaveBeenCalledWith(
        'pi:token',
        expect.objectContaining({
          sessionId,
          delta: expect.stringContaining('Compacted'),
        })
      )
      expect(onEvent).toHaveBeenCalledWith('pi:idle', { sessionId })
    })

    it('routes /name <title> to set_session_name and emits session-ready', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      await service.send(sessionId, '/name My Session')
      expect(
        lastRpc().written.find(
          (c) => c['type'] === 'set_session_name' && c['name'] === 'My Session'
        )
      ).toBeDefined()
      expect(onEvent).toHaveBeenCalledWith(
        'pi:session-ready',
        expect.objectContaining({ sessionId })
      )
    })

    it('routes /tree to get_tree and renders the tree text', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      await service.send(sessionId, '/tree')
      expect(lastRpc().written.some((c) => c['type'] === 'get_tree')).toBe(true)
      expect(onEvent).toHaveBeenCalledWith(
        'pi:token',
        expect.objectContaining({
          sessionId,
          delta: expect.stringContaining('Session tree'),
        })
      )
    })

    it('routes /stats and /export to their RPC commands', async () => {
      const sessionId = await createSession()
      await service.send(sessionId, '/stats')
      expect(lastRpc().written.some((c) => c['type'] === 'get_session_stats')).toBe(true)
      await service.send(sessionId, '/export')
      expect(lastRpc().written.some((c) => c['type'] === 'export_html')).toBe(true)
    })

    it('does not intercept non-builtin slash commands like /workflow', async () => {
      const sessionId = await createSession()
      await service.send(sessionId, '/workflow tdd')
      expect(
        lastRpc().written.find((c) => c['type'] === 'prompt' && c['message'] === '/workflow tdd')
      ).toBeDefined()
    })

    it('emits pi:error when a builtin command fails', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'compact') throw new Error('compaction failed')
        return defaultHandler(cmd)
      }
      await service.send(sessionId, '/compact')
      expect(onEvent).toHaveBeenCalledWith(
        'pi:error',
        expect.objectContaining({
          sessionId,
          message: expect.stringContaining('compaction failed'),
        })
      )
    })

    it('includes builtins in listCommands output', async () => {
      const sessionId = await createSession()
      const cmds = await service.listCommands(sessionId)
      const names = cmds.map((c) => c.name)
      expect(names).toContain('compact')
      expect(names).toContain('tree')
      expect(names).toContain('stats')
      expect(names).toContain('name')
      expect(names).toContain('export')
      expect(cmds.find((c) => c.name === 'tree')!.source).toBe('builtin')
    })
  })

  describe('extension UI bridging', () => {
    it('forwards dialog ui-requests as pi:ui-request', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('ui-request', {
        type: 'extension_ui_request',
        id: 'req-1',
        method: 'select',
        title: 'Pick one',
        options: ['a', 'b'],
      })
      expect(onEvent).toHaveBeenCalledWith(
        'pi:ui-request',
        expect.objectContaining({
          sessionId,
          requestId: 'req-1',
          method: 'select',
          title: 'Pick one',
          options: ['a', 'b'],
        })
      )
    })

    it('ignores fire-and-forget ui-requests (notify)', async () => {
      await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('ui-request', {
        type: 'extension_ui_request',
        id: 'req-2',
        method: 'notify',
        message: 'hi',
      })
      expect(onEvent).not.toHaveBeenCalledWith('pi:ui-request', expect.anything())
    })

    it('answers dialogs via uiRespond → extension_ui_response', async () => {
      const sessionId = await createSession()
      await service.uiRespond(sessionId, 'req-1', { value: 'a' })
      const resp = lastRpc().written.find((c) => c['type'] === 'extension_ui_response')
      expect(resp).toBeDefined()
      expect(resp!['id']).toBe('req-1')
      expect(resp!['value']).toBe('a')
    })
  })

  describe('session-ready', () => {
    it('emits pi:session-ready with the sdk id after warmup', async () => {
      onEvent.mockClear()
      await createSession()
      await flush()
      await flush()
      expect(onEvent).toHaveBeenCalledWith('pi:session-ready', {
        sessionId: expect.any(String),
        sdkSessionId: 'sdk-1',
      })
    })

    it('exposes live sessions with sdk ids for sidebar highlighting', async () => {
      await createSession()
      await flush()
      await flush()
      const live = service.getActiveSessionsWithSdk()
      expect(live).toHaveLength(1)
      expect(live[0].sdkSessionId).toBe('sdk-1')
    })
  })

  describe('argument enrichment', () => {
    it('attaches workflow arg choices from the catalog', async () => {
      const sessionId = await createSession()
      const cmds = await service.listCommands(sessionId)
      const wf = cmds.find((c) => c.name === 'workflow')
      expect(wf?.argChoices).toEqual(['tdd', 'pipeline'])
      expect(wf?.argHint).toBe('workflow id')
    })
  })

  describe('tree picker + fork', () => {
    it('emits pi:tree-picker with clickable user nodes on /tree', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      await service.send(sessionId, '/tree')
      expect(onEvent).toHaveBeenCalledWith(
        'pi:tree-picker',
        expect.objectContaining({
          sessionId,
          nodes: expect.arrayContaining([
            expect.objectContaining({ role: 'user', clickable: true, text: 'hello tree' }),
            expect.objectContaining({ role: 'assistant', clickable: false }),
          ]),
        })
      )
    })

    it('forkFrom writes fork + get_messages and returns the rebuilt chat', async () => {
      const sessionId = await createSession()
      const { messages } = await service.forkFrom(sessionId, 'entry-1')
      const rpc = lastRpc()
      expect(
        rpc.written.find((c) => c['type'] === 'fork' && c['entryId'] === 'entry-1')
      ).toBeDefined()
      expect(rpc.written.some((c) => c['type'] === 'get_messages')).toBe(true)
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(messages[1]!.content).toBe('fork reply')
    })

    it('throws when an extension cancels the fork', async () => {
      const sessionId = await createSession()
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'fork') return { cancelled: true }
        return defaultHandler(cmd)
      }
      await expect(service.forkFrom(sessionId, 'e1')).rejects.toThrow('cancelled')
    })
  })

  describe('notify forwarding', () => {
    it('surfaces extension notify requests as pi:notify', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('ui-request', {
        type: 'extension_ui_request',
        id: 'n1',
        method: 'notify',
        message: 'requires interactive TUI mode',
        notifyType: 'error',
      })
      expect(onEvent).toHaveBeenCalledWith('pi:notify', {
        sessionId,
        message: 'requires interactive TUI mode',
        level: 'error',
      })
    })

    it('surfaces setWidget as pi:widget (and null clears)', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('ui-request', {
        type: 'extension_ui_request',
        id: 'w1',
        method: 'setWidget',
        widgetKey: 'contacts',
        widgetLines: ['Alice: 123', 'Bob: 456'],
      })
      expect(onEvent).toHaveBeenCalledWith('pi:widget', {
        sessionId,
        widgetKey: 'contacts',
        lines: ['Alice: 123', 'Bob: 456'],
        placement: 'aboveEditor',
      })
      lastRpc().emitCustom('ui-request', {
        type: 'extension_ui_request',
        id: 'w2',
        method: 'setWidget',
        widgetKey: 'contacts',
      })
      expect(onEvent).toHaveBeenLastCalledWith('pi:widget', {
        sessionId,
        widgetKey: 'contacts',
        lines: null,
        placement: 'aboveEditor',
      })
    })

    it('surfaces setStatus as pi:status', async () => {
      const sessionId = await createSession()
      onEvent.mockClear()
      lastRpc().emitCustom('ui-request', {
        type: 'extension_ui_request',
        id: 's1',
        method: 'setStatus',
        statusKey: 'my-ext',
        statusText: 'Turn 3 running…',
      })
      expect(onEvent).toHaveBeenCalledWith('pi:status', {
        sessionId,
        statusKey: 'my-ext',
        text: 'Turn 3 running…',
      })
    })
  })

  describe('model + thinking cycling (shortcuts)', () => {
    it('cycleModel with favorites stays inside the favorite pool', async () => {
      const sessionId = await createSession()
      const next = await service.cycleModel(sessionId, ['anthropic/claude-sonnet-4-5'], false)
      expect(next).toEqual({
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
      })
      expect(
        lastRpc().written.find(
          (c) =>
            c['type'] === 'set_model' &&
            c['provider'] === 'anthropic' &&
            c['modelId'] === 'claude-sonnet-4-5'
        )
      ).toBeDefined()
    })

    it('cycleModel without favorites walks all models and wraps backward', async () => {
      const sessionId = await createSession()
      // current = zai/glm-5.3 (index 0) → backward wraps to the last entry
      const next = await service.cycleModel(sessionId, [], true)
      expect(next.modelId).toBe('claude-sonnet-4-5')
      const forward = await service.cycleModel(sessionId, [], false)
      expect(forward.modelId).toBe('glm-5.3-flash')
    })

    it('cycleModel returns the current model without switching when it is the only favorite', async () => {
      const sessionId = await createSession()
      const rpc = lastRpc()
      const next = await service.cycleModel(sessionId, ['zai/glm-5.3'], false)
      expect(next.modelId).toBe('glm-5.3')
      expect(rpc.written.some((c) => c['type'] === 'set_model')).toBe(false)
    })

    it('cycleThinking advances through the model-supported levels', async () => {
      const sessionId = await createSession()
      const res = await service.cycleThinking(sessionId)
      // defaultHandler state: thinkingLevel 'low' → next is 'high'
      expect(res.level).toBe('high')
      expect(res.levels).toEqual(['off', 'low', 'high', 'max'])
      expect(
        lastRpc().written.find((c) => c['type'] === 'set_thinking_level' && c['level'] === 'high')
      ).toBeDefined()
    })

    it('setThinking writes the exact level', async () => {
      const sessionId = await createSession()
      await service.setThinking(sessionId, 'max')
      expect(
        lastRpc().written.find((c) => c['type'] === 'set_thinking_level' && c['level'] === 'max')
      ).toBeDefined()
    })
  })
})
