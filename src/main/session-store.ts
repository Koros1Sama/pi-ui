// src/main/session-store.ts
//
// Session history listing / metadata / message replay — pure file operations
// over the pi session JSONL files. Live session execution (create/resume)
// moved to SessionService's RPC subprocess engine.
import { SessionManager } from '@mariozechner/pi-coding-agent'
import * as fs from 'fs'
import { dirname, basename, join } from 'path'
import type { SessionSummary, SessionMeta, Message } from '@shared/types'
import { convertAgentMessages } from './agent-messages'

export type FsLike = Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>

export class SessionStore {
  private readonly pathById = new Map<string, string>()
  private readonly jsonlPathById = new Map<string, string>()

  constructor(private readonly fsImpl: FsLike = fs) {}

  /** One pass over the JSONL: latest model_change + first user message snippet. */
  private readSessionFacts(sessionPath: string): {
    modelId: string | null
    firstUserSnippet: string | null
  } {
    let modelId: string | null = null
    try {
      const content = this.fsImpl.readFileSync(sessionPath, 'utf-8') as string
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        let entry: {
          type?: string
          modelId?: string
          message?: { role?: string; content?: unknown }
        }
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.type === 'model_change' && entry.modelId) {
          modelId = entry.modelId
        } else if (entry.type === 'message' && entry.message?.role === 'user') {
          const c = entry.message.content
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? (c as Array<{ type: string; text?: string }>)
                    .filter((p) => p.type === 'text')
                    .map((p) => p.text ?? '')
                    .join('')
                : ''
          const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 60)
          return { modelId, firstUserSnippet: snippet || null }
        }
      }
    } catch {
      // ignore
    }
    return { modelId, firstUserSnippet: null }
  }

  async list(activeSessionIds: string[]): Promise<SessionSummary[]> {
    const infos = await SessionManager.listAll()

    return infos.map((info) => {
      const cwdSlug = basename(dirname(info.path))
      const cwdDir = dirname(info.path)
      const meta = this.readMeta(cwdDir)
      const sessionMeta = meta[info.id]
      const facts = this.readSessionFacts(info.path)

      this.pathById.set(info.id, cwdDir)
      this.jsonlPathById.set(info.id, info.path)

      return {
        id: info.id,
        path: info.path,
        cwd: info.cwd,
        cwdSlug,
        lastActiveAt: info.modified.getTime(),
        model: facts.modelId,
        pinned: sessionMeta?.pinned ?? false,
        tags: sessionMeta?.tags ?? [],
        // Prefer an explicit name; fall back to the first user message snippet
        // (matches what the CLI shows for unnamed sessions).
        name: info.name ?? facts.firstUserSnippet,
        isActive: activeSessionIds.includes(info.id),
      }
    })
  }

  async updateMeta(
    cwdDir: string,
    sessionId: string,
    patch: Partial<{ tags: string[]; pinned: boolean }>
  ): Promise<void> {
    const meta = this.readMeta(cwdDir)
    meta[sessionId] = {
      tags: patch.tags ?? meta[sessionId]?.tags ?? [],
      pinned: patch.pinned ?? meta[sessionId]?.pinned ?? false,
    }
    this.writeMeta(cwdDir, meta)
  }

  async updateMetaById(
    sessionId: string,
    patch: Partial<{ tags: string[]; pinned: boolean }>
  ): Promise<void> {
    const cwdDir = this.pathById.get(sessionId)
    if (!cwdDir) throw new Error(`Unknown session: ${sessionId}`)
    await this.updateMeta(cwdDir, sessionId, patch)
  }

  async deleteMeta(cwdDir: string, sessionId: string): Promise<void> {
    const meta = this.readMeta(cwdDir)
    delete meta[sessionId]
    this.writeMeta(cwdDir, meta)
  }

  async deleteMetaById(sessionId: string): Promise<void> {
    const cwdDir = this.pathById.get(sessionId)
    if (!cwdDir) throw new Error(`Unknown session: ${sessionId}`)
    await this.deleteMeta(cwdDir, sessionId)
  }

  async setNameById(sdkSessionId: string, name: string): Promise<void> {
    const jsonlPath = this.jsonlPathById.get(sdkSessionId)
    if (!jsonlPath) throw new Error(`Unknown session: ${sdkSessionId}`)
    const manager = SessionManager.open(jsonlPath)
    manager.appendSessionInfo(name)
  }

  async load(sessionPath: string): Promise<Message[]> {
    const manager = SessionManager.open(sessionPath)
    const context = manager.buildSessionContext()
    return convertAgentMessages(context.messages)
  }

  private metaPath(cwdDir: string): string {
    return join(cwdDir, '.meta.json')
  }

  private readMeta(cwdDir: string): SessionMeta {
    const metaFile = this.metaPath(cwdDir)
    if (!this.fsImpl.existsSync(metaFile)) return {}
    try {
      return JSON.parse(this.fsImpl.readFileSync(metaFile, 'utf-8') as string) as SessionMeta
    } catch {
      return {}
    }
  }

  private writeMeta(cwdDir: string, meta: SessionMeta): void {
    const metaFile = this.metaPath(cwdDir)
    this.fsImpl.mkdirSync(dirname(metaFile), { recursive: true })
    this.fsImpl.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
  }
}
