// src/main/session-store.ts
//
// Session history listing / metadata / message replay — pure file operations
// over the pi session JSONL files. Live session execution (create/resume)
// moved to SessionService's RPC subprocess engine.
//
// LISTING IS LIGHTWEIGHT BY DESIGN: instead of reading every transcript in
// full (266MB+ on a busy machine froze the whole laptop at startup), the
// scanner stats each file and reads only a HEAD slice (session header +
// first user message) and a TAIL slice (latest model_change / session_info).
// Expensive facts for huge files fall back to the .meta.json cache.
import { SessionManager } from '@mariozechner/pi-coding-agent'
import * as fs from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { SessionSummary, SessionMeta, Message } from '@shared/types'
import { convertAgentMessages } from './agent-messages'

export type FsLike = Pick<
  typeof fs,
  | 'existsSync'
  | 'readFileSync'
  | 'writeFileSync'
  | 'mkdirSync'
  | 'unlinkSync'
  | 'readdirSync'
  | 'statSync'
  | 'openSync'
  | 'readSync'
  | 'closeSync'
>

interface SessionFacts {
  sessionId: string | null
  cwd: string | null
  modelId: string | null
  firstUserSnippet: string | null
  name: string | null
}

export class SessionStore {
  /** Head slice: session header + first user message live at the top. */
  private static readonly HEAD_BYTES = 64 * 1024
  /** Tail slice: latest model_change / session_info entries live at the end. */
  private static readonly TAIL_BYTES = 256 * 1024

  private readonly pathById = new Map<string, string>()
  private readonly jsonlPathById = new Map<string, string>()

  constructor(private readonly fsImpl: FsLike = fs) {}

  private sessionsRoot(): string {
    return process.env['PI_SESSIONS_DIR'] ?? join(homedir(), '.pi', 'agent', 'sessions')
  }

  async list(activeSessionIds: string[]): Promise<SessionSummary[]> {
    const root = this.sessionsRoot()
    const out: SessionSummary[] = []

    let slugEntries: fs.Dirent[]
    try {
      slugEntries = this.fsImpl.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }

    for (const slugEntry of slugEntries) {
      if (!slugEntry.isDirectory() && !slugEntry.isSymbolicLink()) continue
      const dirPath = join(root, slugEntry.name)
      const meta = this.readMeta(dirPath)

      let files: fs.Dirent[]
      try {
        files = this.fsImpl.readdirSync(dirPath, { withFileTypes: true })
      } catch {
        continue
      }

      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
        const path = join(dirPath, f.name)
        let mtimeMs = 0
        try {
          mtimeMs = this.fsImpl.statSync(path).mtimeMs
        } catch {
          // vanished between readdir and stat — skip timing, keep entry
        }

        const { head, tail } = this.readSlices(path)
        const facts = this.parseFacts(head, tail)
        const sessionMeta = meta[facts.sessionId ?? '']
        const id = facts.sessionId ?? f.name.replace(/\.jsonl$/, '')

        this.pathById.set(id, dirPath)
        this.jsonlPathById.set(id, path)

        out.push({
          id,
          path,
          cwd: facts.cwd ?? '',
          cwdSlug: slugEntry.name,
          lastActiveAt: mtimeMs,
          model: facts.modelId ?? sessionMeta?.model ?? null,
          pinned: sessionMeta?.pinned ?? false,
          tags: sessionMeta?.tags ?? [],
          // Prefer an explicit name (slice scan, then the meta cache), then
          // the first user message snippet — matches what the CLI shows.
          name: facts.name ?? sessionMeta?.name ?? facts.firstUserSnippet,
          isActive: activeSessionIds.includes(id),
        })
      }
    }

    out.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return out
  }

  /** Read only the head and tail slices of a transcript (never the middle). */
  private readSlices(path: string): { head: string; tail: string } {
    try {
      const size = this.fsImpl.statSync(path).size
      if (size === 0) return { head: '', tail: '' }
      if (size <= SessionStore.HEAD_BYTES + SessionStore.TAIL_BYTES) {
        const all = this.fsImpl.readFileSync(path, 'utf-8')
        return { head: all, tail: all }
      }
      const head = this.readRange(path, 0, SessionStore.HEAD_BYTES)
      const tail = this.readRange(path, size - SessionStore.TAIL_BYTES, SessionStore.TAIL_BYTES)
      return { head, tail }
    } catch {
      return { head: '', tail: '' }
    }
  }

  private readRange(path: string, start: number, length: number): string {
    const fd = this.fsImpl.openSync(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      // fs.readSync returns the byte count directly (not {bytesRead}).
      const bytesRead = this.fsImpl.readSync(fd, buf, 0, length, start)
      return buf.subarray(0, bytesRead).toString('utf-8')
    } finally {
      this.fsImpl.closeSync(fd)
    }
  }

  /** Extract sidebar facts from the slices. Tail is scanned LAST so its
   *  (newer) model_change / session_info entries win. Lines cut at slice
   *  boundaries simply fail JSON.parse and are skipped. */
  private parseFacts(head: string, tail: string): SessionFacts {
    let sessionId: string | null = null
    let cwd: string | null = null
    let modelId: string | null = null
    let firstUserSnippet: string | null = null
    let name: string | null = null

    const scan = (text: string): void => {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let entry: {
          type?: string
          id?: string
          cwd?: string
          modelId?: string
          name?: string
          message?: { role?: string; content?: unknown }
        }
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry.type === 'session') {
          // Header carries the authoritative id + cwd — must match the ids
          // live sessions report via get_state for sidebar dedup.
          if (sessionId === null && typeof entry.id === 'string') sessionId = entry.id
          if (cwd === null && typeof entry.cwd === 'string') cwd = entry.cwd
        } else if (entry.type === 'model_change' && entry.modelId) {
          // keep scanning — the LAST one is the current model
          modelId = entry.modelId
        } else if (entry.type === 'session_info') {
          const n = (entry.name ?? '').trim()
          name = n || null
        } else if (
          entry.type === 'message' &&
          entry.message?.role === 'user' &&
          firstUserSnippet === null
        ) {
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
          if (snippet) firstUserSnippet = snippet
        }
      }
    }

    scan(head)
    scan(tail)
    return { sessionId, cwd, modelId, firstUserSnippet, name }
  }

  async updateMeta(
    cwdDir: string,
    sessionId: string,
    patch: Partial<{ tags: string[]; pinned: boolean }>
  ): Promise<void> {
    const meta = this.readMeta(cwdDir)
    const prev = meta[sessionId]
    meta[sessionId] = {
      ...prev,
      tags: patch.tags ?? prev?.tags ?? [],
      pinned: patch.pinned ?? prev?.pinned ?? false,
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

  /** Actually delete a stored session: the JSONL file plus its meta entry. */
  async deleteSessionFile(sessionId: string): Promise<void> {
    const jsonl = this.jsonlPathById.get(sessionId)
    const cwdDir = this.pathById.get(sessionId)
    if (cwdDir) {
      await this.deleteMeta(cwdDir, sessionId).catch(() => undefined)
    }
    if (jsonl) {
      try {
        this.fsImpl.unlinkSync(jsonl)
      } catch {
        // already gone — treat as deleted
      }
      this.jsonlPathById.delete(sessionId)
      this.pathById.delete(sessionId)
    } else if (!cwdDir) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
  }

  async setNameById(sdkSessionId: string, name: string): Promise<void> {
    const jsonlPath = this.jsonlPathById.get(sdkSessionId)
    if (!jsonlPath) throw new Error(`Unknown session: ${sdkSessionId}`)
    const manager = SessionManager.open(jsonlPath)
    manager.appendSessionInfo(name)
    // Cache the name so the lightweight scanner never needs a full re-read
    // of a huge transcript to recover it.
    const cwdDir = this.pathById.get(sdkSessionId)
    if (cwdDir) {
      const meta = this.readMeta(cwdDir)
      const prev = meta[sdkSessionId]
      meta[sdkSessionId] = { ...prev, tags: prev?.tags ?? [], pinned: prev?.pinned ?? false, name }
      this.writeMeta(cwdDir, meta)
    }
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
