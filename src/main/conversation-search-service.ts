// src/main/conversation-search-service.ts
import { readFile, readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { ConversationSearchMatch, ConversationSearchResult } from '@shared/types'
import { parseQuery, matchText } from './content-search-service'

const MAX_FILE_BYTES = 8 * 1024 * 1024 // skip transcripts > 8MB
const MAX_MATCHES = 500
const TIME_BUDGET_MS = 10_000
const YIELD_EVERY_FILES = 25
const SNIPPET_MAX = 300

type RoleFilter = 'user' | 'assistant' | null

/** Pull `from:` tokens out of the raw query (from:user|me / from:ai|assistant). */
function extractRoleFilter(query: string): { role: RoleFilter; rest: string } {
  let role: RoleFilter = null
  const rest = query
    .split(/(\s+)/)
    .filter((token) => {
      const m = /^from:(\S+)$/i.exec(token)
      if (!m) return true
      const v = m[1]!.toLowerCase()
      if (v === 'user' || v === 'me') role = 'user'
      else if (v === 'ai' || v === 'assistant') role = 'assistant'
      else if (v === 'all') role = null
      return false // consumed either way
    })
    .join('')
  return { role, rest }
}

interface MessageLike {
  role?: string
  content?: Array<{ type?: string; text?: unknown }>
  timestamp?: number
}

/** Extract the searchable plain text of a JSONL message entry. */
function messageText(msg: MessageLike | undefined): string {
  if (!msg || !Array.isArray(msg.content)) return ''
  const parts: string[] = []
  for (const part of msg.content) {
    // Only user/AI text is searched — thinking blocks and tool calls are noise.
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join(' ')
}

export class ConversationSearchService {
  constructor(
    private readonly sessionsRoot: string = join(homedir(), '.pi', 'agent', 'sessions')
  ) {}

  async search(query: string): Promise<ConversationSearchResult> {
    const started = Date.now()
    const { role, rest } = extractRoleFilter(query)
    const parsed = parseQuery(rest)

    const empty: ConversationSearchResult = {
      matches: [],
      truncated: false,
      fileCount: 0,
      matchCount: 0,
      durationMs: Date.now() - started,
    }
    if (parsed.includes.length === 0) return empty

    const files: string[] = []
    try {
      await this.collect(this.sessionsRoot, files, 0)
    } catch {
      return empty
    }

    const matches: ConversationSearchMatch[] = []
    let truncated = false
    let scanned = 0

    for (const file of files) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true
        break
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        truncated = true
        break
      }
      if (++scanned % YIELD_EVERY_FILES === 0) await new Promise((r) => setImmediate(r))

      let content: string
      try {
        const { stat } = await import('fs/promises')
        const st = await stat(file)
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue
        content = await readFile(file, 'utf-8')
      } catch {
        continue
      }

      let cwd = ''
      let perFile = 0
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        if (matches.length >= MAX_MATCHES) {
          truncated = true
          break
        }
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (entry['type'] === 'session') {
          cwd = String(entry['cwd'] ?? '')
          continue
        }
        if (entry['type'] !== 'message') continue

        const msg = entry['message'] as MessageLike | undefined
        const msgRole =
          msg?.role === 'assistant' ? 'assistant' : msg?.role === 'user' ? 'user' : null
        if (!msgRole) continue
        if (role && msgRole !== role) continue

        const text = messageText(msg)
        if (!text) continue
        if (!matchText(parsed, text)) continue

        matches.push({
          path: file,
          cwd,
          role: msgRole,
          timestamp: typeof msg?.timestamp === 'number' ? msg.timestamp : 0,
          snippet: text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) : text,
          term: parsed.includes[0]?.raw ?? '',
        })
        if (++perFile >= 20) break // keep results spread across conversations
      }
    }

    return {
      matches,
      truncated,
      fileCount: files.length,
      matchCount: matches.length,
      durationMs: Date.now() - started,
    }
  }

  /** Collect every session .jsonl under the root (cwd-slug dirs). */
  private async collect(dir: string, out: string[], depth: number): Promise<void> {
    if (depth > 4 || out.length > 20_000) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await this.collect(abs, out, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(abs)
    }
  }
}
