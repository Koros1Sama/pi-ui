// @vitest-environment node
// src/main/model-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelService } from './model-service'
import type { RpcModelsHost } from './model-service'

const rpcMock = vi.hoisted(() => {
  type Cmd = Record<string, unknown>

  const shared = {
    responder: async (_cmd: Cmd): Promise<unknown> => undefined,
  }

  class FakeRpcProcess {
    static instances: Array<FakeRpcProcess> = []
    written: Cmd[] = []
    disposed = false
    exited = false
    booted: Promise<void> = Promise.resolve()

    constructor(public readonly opts: { cwd: string; args?: string[] }) {
      FakeRpcProcess.instances.push(this)
    }

    start(): void {}

    on(_event: string, _fn: (payload: unknown) => void): this {
      return this
    }

    async request<T = unknown>(cmd: Cmd): Promise<T> {
      this.written.push(cmd)
      return (await shared.responder(cmd)) as T
    }

    async dispose(): Promise<void> {
      this.disposed = true
      this.exited = true
    }
  }
  return { FakeRpcProcess, shared }
})

vi.mock('./rpc-process', () => ({ RpcProcess: rpcMock.FakeRpcProcess }))

type FakeRpc = InstanceType<typeof rpcMock.FakeRpcProcess>
const { FakeRpcProcess } = rpcMock

/** The fake is structurally partial — cast it into the host interface slot. */
function asRpcHost(rpc: FakeRpc): RpcModelsHost {
  return { getSharedRpc: () => rpc as unknown as ReturnType<RpcModelsHost['getSharedRpc']> }
}

const MODELS_RESPONSE = {
  models: [
    { id: 'glm-5.3', name: 'GLM 5.3', provider: 'zai', reasoning: true },
    { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', reasoning: false },
  ],
}

describe('ModelService (RPC engine)', () => {
  let service: ModelService

  beforeEach(() => {
    vi.clearAllMocks()
    FakeRpcProcess.instances.length = 0
    rpcMock.shared.responder = async (cmd) => {
      if (cmd['type'] === 'get_available_models') return MODELS_RESPONSE
      return undefined
    }
    service = new ModelService()
  })

  describe('listAvailable', () => {
    it('spawns a hub and maps RPC models to ModelEntry shape', async () => {
      const models = await service.listAvailable()

      expect(models).toEqual([
        {
          provider: 'zai',
          modelId: 'glm-5.3',
          displayName: 'GLM 5.3',
          supportsThinking: true,
        },
        {
          provider: 'openai',
          modelId: 'gpt-5.2',
          displayName: 'GPT-5.2',
          supportsThinking: false,
        },
      ])
      expect(FakeRpcProcess.instances).toHaveLength(1)
      expect(FakeRpcProcess.instances[0].opts.args).toContain('--no-session')
    })

    it('reuses the hub across calls', async () => {
      await service.listAvailable()
      await service.listAvailable()
      expect(FakeRpcProcess.instances).toHaveLength(1)
      const hub = FakeRpcProcess.instances[0]
      expect(hub.written.filter((c) => c['type'] === 'get_available_models')).toHaveLength(2)
    })

    it('prefers a shared session rpc when one is live', async () => {
      const shared = new FakeRpcProcess({ cwd: '/tmp/project' })
      const sessionService = new ModelService(asRpcHost(shared))

      const models = await sessionService.listAvailable()

      expect(models.map((m) => m.modelId)).toEqual(['glm-5.3', 'gpt-5.2'])
      expect(shared.written.some((c) => c['type'] === 'get_available_models')).toBe(true)
      // No hub was spawned: the only constructed instance is the shared one.
      expect(FakeRpcProcess.instances).toHaveLength(1)
    })

    it('falls back to the hub when the shared rpc fails', async () => {
      const shared = new FakeRpcProcess({ cwd: '/tmp/project' })
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'get_available_models') throw new Error('rpc died')
        return undefined
      }
      const host = asRpcHost(shared)
      const serviceWithHost = new ModelService(host)

      // The shared rpc fails on the first call (instance #1)…
      await expect(serviceWithHost.listAvailable()).rejects.toThrow('rpc died')
      // …then it "exits" and a fresh hub is spawned for the retry.
      shared.exited = true
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'get_available_models') return MODELS_RESPONSE
        return undefined
      }
      const models = await serviceWithHost.listAvailable()
      expect(models.map((m) => m.modelId)).toEqual(['glm-5.3', 'gpt-5.2'])
      expect(FakeRpcProcess.instances.length).toBeGreaterThanOrEqual(2)
    })

    it('returns empty array when no models are available', async () => {
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'get_available_models') return { models: [] }
        return undefined
      }
      expect(await service.listAvailable()).toEqual([])
    })

    it('skips malformed model entries', async () => {
      rpcMock.shared.responder = async (cmd) => {
        if (cmd['type'] === 'get_available_models') {
          return { models: [{ id: 'x', provider: 'zai' }, { provider: 'no-id' }] }
        }
        return undefined
      }
      expect(await service.listAvailable()).toEqual([
        { provider: 'zai', modelId: 'x', displayName: 'x', supportsThinking: false },
      ])
    })
  })

  describe('prewarm', () => {
    it('boots the hub in the background', async () => {
      service.prewarm()
      expect(FakeRpcProcess.instances).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(FakeRpcProcess.instances[0].opts.args).toContain('--no-session')
    })
  })
})
