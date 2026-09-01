// src/renderer/src/components/sidebar/ConversationSearchPanel.tsx
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, MessagesSquare } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { formatTimestamp } from './SessionEntry'
import type {
  ConversationSearchMatch,
  ConversationSearchResult,
  SessionSummary,
} from '@shared/types'

const DEBOUNCE_MS = 220

interface Props {
  query: string
  onSelectSession(session: SessionSummary): void
}

/** Highlight occurrences of the first plain (non-wildcard) term in a snippet. */
function HighlightedLine({ text, term }: { text: string; term: string }) {
  const plain = term.includes('*') ? '' : term
  if (!plain) return <>{text}</>

  const parts: ReactNode[] = []
  const hay = text.toLowerCase()
  const needle = plain.toLowerCase()
  let idx = 0
  let found = 0
  for (;;) {
    const at = hay.indexOf(needle, idx)
    if (at === -1 || found > 20) break
    if (at > idx) parts.push(text.slice(idx, at))
    parts.push(
      <mark key={at} className="rounded bg-[var(--pi-accent)]/30 px-0.5 text-[var(--pi-accent)]">
        {text.slice(at, at + needle.length)}
      </mark>
    )
    idx = at + needle.length
    found++
  }
  if (idx < text.length) parts.push(text.slice(idx))
  return <>{parts}</>
}

export default function ConversationSearchPanel({ query, onSelectSession }: Props) {
  const sessions = useStore((s) => s.history.sessions)

  const [result, setResult] = useState<ConversationSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const searchIdRef = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      // Idle is DERIVED from the query (idle branch renders first) — no
      // synchronous setState; invalidate any in-flight run instead.
      searchIdRef.current++
      return
    }

    const timer = setTimeout(async () => {
      const id = ++searchIdRef.current
      setSearching(true)
      try {
        const res = await window.pi.search.conversations(q)
        if (id !== searchIdRef.current) return // stale run — a newer query won
        setResult(res)
        setError(null)
        setCollapsed(new Set())
      } catch (err) {
        if (id !== searchIdRef.current) return
        setError(err instanceof Error ? err.message : 'Search failed')
        setResult(null)
      } finally {
        if (id === searchIdRef.current) setSearching(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [query])

  /** Group matches by transcript file, joined with sidebar session info. */
  const groups = useMemo(() => {
    const byPath = new Map<string, ConversationSearchMatch[]>()
    for (const m of result?.matches ?? []) {
      const list = byPath.get(m.path)
      if (list) list.push(m)
      else byPath.set(m.path, [m])
    }
    const sessionByPath = new Map(sessions.map((s) => [s.path, s]))
    return Array.from(byPath.entries()).map(([path, matches]) => {
      const session = sessionByPath.get(path) ?? null
      const cwdBasename = matches[0]?.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '—'
      // Pure derivation: session name > match timestamp > folder name.
      const label =
        session?.name ??
        (matches[0]?.timestamp ? formatTimestamp(matches[0].timestamp) : cwdBasename)
      return { path, matches, session, cwdBasename, label }
    })
  }, [result, sessions])

  // ── Idle state ────────────────────────────────────────────────────────────
  if (!query.trim()) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <MessagesSquare size={18} className="text-zinc-700" />
        <p className="text-xs text-zinc-600">Conversation search · بحث المحادثات</p>
        <p dir="rtl" className="text-[10px] leading-relaxed text-zinc-700">
          اكتب جملة من أي محادثة لإيجادها
        </p>
        <p className="text-[10px] leading-relaxed text-zinc-700">
          Type a phrase from any chat to find it. Use ? for syntax.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="conversation-search-panel" className="flex flex-1 flex-col overflow-hidden">
      {/* Stats */}
      <div className="flex items-center gap-1.5 border-b border-zinc-900 px-3 py-1.5">
        <span className="text-[10px] text-zinc-500">all conversations</span>
        <span className="ms-auto shrink-0 text-[10px] text-zinc-600">
          {searching ? (
            <span className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> searching…
            </span>
          ) : result ? (
            <>
              {result.matchCount} in {groups.length} chat{groups.length === 1 ? '' : 's'} ·{' '}
              {result.fileCount} files · {result.durationMs}ms
              {result.truncated ? ' · capped' : ''}
            </>
          ) : null}
        </span>
      </div>

      {/* Results */}
      <div data-testid="conversation-search-results" className="flex-1 overflow-y-auto py-1">
        {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
        {!error && !searching && groups.length === 0 && result && (
          <p className="px-3 py-4 text-center text-xs text-zinc-700">
            No conversations match &ldquo;{query}&rdquo;
            <br />
            <span dir="rtl" className="text-[10px]">
              لا توجد محادثات مطابقة
            </span>
          </p>
        )}

        {groups.map(({ path, matches, session, cwdBasename, label }) => {
          const isCollapsed = collapsed.has(path)
          return (
            <div key={path} className="mb-0.5">
              <button
                data-testid={`conversation-search-file-${cwdBasename}`}
                onClick={() => {
                  if (isCollapsed || !session) {
                    // Expand (or expand-only when the session isn't joinable)
                    setCollapsed((prev) => {
                      const next = new Set(prev)
                      if (next.has(path)) next.delete(path)
                      else next.add(path)
                      return next
                    })
                    return
                  }
                  onSelectSession(session)
                }}
                title={session ? `Open: ${session.name ?? path}` : path}
                className="flex w-full items-center gap-1 px-2 py-1 text-start hover:bg-zinc-900"
              >
                <MessagesSquare size={10} className="shrink-0 text-zinc-500" />
                <span dir="auto" className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                  {label}
                </span>
                <span dir="ltr" className="shrink-0 text-[9px] text-zinc-600">
                  {cwdBasename}
                </span>
                <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[9px] text-zinc-500">
                  {matches.length}
                </span>
              </button>

              {!isCollapsed &&
                matches.map((m, i) => (
                  <button
                    key={`${m.path}:${m.timestamp}:${i}`}
                    data-testid={`conversation-search-match-${i}`}
                    onClick={() => session && onSelectSession(session)}
                    title={session ? `Open conversation · فتح المحادثة` : m.path}
                    className="flex w-full items-baseline gap-1.5 py-0.5 pe-2 ps-5 text-start hover:bg-zinc-900"
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 text-[9px] uppercase',
                        m.role === 'user'
                          ? 'bg-[var(--pi-accent)]/15 text-[var(--pi-accent)]'
                          : 'bg-zinc-800 text-zinc-500'
                      )}
                    >
                      {m.role === 'user' ? 'you' : 'ai'}
                    </span>
                    <span
                      dir="auto"
                      className="line-clamp-2 text-[10px] leading-snug text-zinc-400"
                    >
                      <HighlightedLine text={m.snippet} term={m.term} />
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
