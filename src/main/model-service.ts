// src/main/model-service.ts
//
// Model listing backed by the real pi CLI (`get_available_models` over RPC)
// instead of the stale bundled ModelRegistry. When a live session exists its
// subprocess is reused (already booted, and it sees project-level provider
// config); otherwise a long-lived "hub" subprocess is spawned at the home
// directory and shared by all callers.
import { homedir } from 'os'
import { RpcProcess } from './rpc-process'
import type { ModelEntry } from '@shared/types'

/** Anything that can hand us an already-running RPC subprocess. */
export interface RpcModelsHost {
  getSharedRpc(): RpcProcess | null
}

interface RpcModel {
  id?: string
  name?: string
  provider?: string
  reasoning?: boolean
}

export class ModelService {
  private hub: RpcProcess | null = null

  constructor(private readonly sessions?: RpcModelsHost) {}

  /** Kick off the hub subprocess early so the first models:list is warm. */
  prewarm(): void {
    void this.ensureHub().catch((err) => {
      console.error('[model-service] hub prewarm failed:', err)
    })
  }

  async listAvailable(): Promise<ModelEntry[]> {
    // Prefer a live session subprocess: booted, and project-scoped providers apply.
    const shared = this.sessions?.getSharedRpc()
    if (shared) {
      try {
        return await this.fetchModels(shared)
      } catch (err) {
        console.error('[model-service] shared session rpc failed, falling back to hub:', err)
      }
    }
    const hub = await this.ensureHub()
    return this.fetchModels(hub)
  }

  private async fetchModels(rpc: RpcProcess): Promise<ModelEntry[]> {
    const data = await rpc.request<{ models?: RpcModel[] }>({ type: 'get_available_models' })
    return (data?.models ?? [])
      .filter((m) => typeof m.id === 'string' && typeof m.provider === 'string')
      .map((m) => ({
        provider: m.provider as string,
        modelId: m.id as string,
        displayName: typeof m.name === 'string' ? m.name : (m.id as string),
        supportsThinking: m.reasoning === true,
      }))
  }

  private async ensureHub(): Promise<RpcProcess> {
    if (this.hub && !this.hub.exited) return this.hub
    const hub = new RpcProcess({
      cwd: homedir(),
      args: ['--no-session'],
    })
    hub.on('exit', () => {
      if (this.hub === hub) this.hub = null
    })
    // EventEmitter 'error' with no listener crashes the main process.
    hub.on('error', (err) => {
      console.error('[model-service] hub spawn error:', err)
      if (this.hub === hub) this.hub = null
    })
    hub.start()
    this.hub = hub
    try {
      await hub.booted
    } catch (err) {
      if (this.hub === hub) this.hub = null
      await hub.dispose()
      throw err
    }
    return hub
  }

  /** Kill the shared hub (app shutdown). */
  dispose(): void {
    const hub = this.hub
    this.hub = null
    if (hub) void hub.dispose()
  }
}
