// src/renderer/src/components/sidebar/ContentSearchPanel.tsx
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Loader2, FileText, FileSearch, ChevronRight, ChevronDown, FolderOpen } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import type { ContentSearchMatch, ContentSearchResult } from '@shared/types'

const DEBOUNCE_MS = 220

interface Props {
  query: string
}

/** Highlight occurrences of the first plain (non-wildcard) term in a line. */
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

export default function ContentSearchPanel({ query }: Props) {
  const tabs = useStore((s) => s.tabs.tabs)
  const activeTabId = useStore((s) => s.tabs.activeTabId)
  const defaultWorkingDirectory = useStore((s) => s.config.defaultWorkingDirectory)
  const homedir = useStore((s) => s.config.homedir)

  const [result, setResult] = useState<ContentSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const searchIdRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const scope = activeTab?.cwd ?? defaultWorkingDirectory ?? homedir ?? ''

  useEffect(() => {
    const q = query.trim()
    if (!q || !scope) {
      // Idle is DERIVED from the query (idle branch renders first) — no
      // synchronous setState here. Invalidate any in-flight run so a stale
      // result can never land after the query was cleared.
      searchIdRef.current++
      return
    }

    const timer = setTimeout(async () => {
      const id = ++searchIdRef.current
      setSearching(true)
      try {
        const res = await window.pi.search.content({ cwd: scope, query: q })
        if (id !== searchIdRef.current) return // stale run — a newer query won
        setResult(res)
        setError(null)
        setSelectedIdx(0)
        setCollapsed(new Set())
      } catch (err) {
        if (id !== searchIdRef.current) return
        setError(err instanceof Error ? err.message : 'Search failed')
        setResult(null)
      } finally {
        if (id === searchIdRef.current) setSearching(false)
      }
    }, DEBOUNCE_MS)

    timerRef.current = timer
    return () => {
      clearTimeout(timer)
    }
  }, [query, scope])

  const groups = useMemo(() => {
    const map = new Map<string, ContentSearchMatch[]>()
    for (const m of result?.matches ?? []) {
      const list = map.get(m.relPath)
      if (list) list.push(m)
      else map.set(m.relPath, [m])
    }
    return Array.from(map.entries())
  }, [result])

  const flatMatches = useMemo(() => groups.flatMap(([, ms]) => ms), [groups])

  function openMatch(m: ContentSearchMatch) {
    void window.pi.shell.openPath(m.path)
  }

  function handleKeyDown(e: ReactKeyboardEvent) {
    if (!flatMatches.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, flatMatches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openMatch(flatMatches[selectedIdx])
    }
  }

  // ── Idle states ────────────────────────────────────────────────────────────
  if (!query.trim()) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <FileSearch size={18} className="text-zinc-700" />
        <p className="text-xs text-zinc-600">Content search</p>
        <p className="text-[10px] leading-relaxed text-zinc-700">
          Type to search inside project files.
          <br />
          Use the ? button for smart syntax.
        </p>
      </div>
    )
  }

  let runningIdx = -1

  return (
    <div
      data-testid="content-search-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex flex-1 flex-col overflow-hidden outline-none"
    >
      {/* Scope + stats */}
      <div className="flex items-center gap-1.5 border-b border-zinc-900 px-3 py-1.5">
        <button
          onClick={() => scope && window.pi.shell.openPath(scope)}
          dir="ltr"
          title={scope}
          className="flex min-w-0 items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
        >
          <FolderOpen size={10} className="shrink-0" />
          <span className="truncate">{scope ? scope.split(/[\\/]/).pop() : '—'}</span>
        </button>
        <span className="ms-auto shrink-0 text-[10px] text-zinc-600">
          {searching ? (
            <span className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> searching…
            </span>
          ) : result ? (
            <>
              {result.matchCount} match{result.matchCount === 1 ? '' : 'es'} · {result.fileCount}{' '}
              files · {result.durationMs}ms
              {result.truncated ? ' · capped' : ''}
            </>
          ) : null}
        </span>
      </div>

      {/* Results */}
      <div data-testid="content-search-results" className="flex-1 overflow-y-auto py-1">
        {error && <p className="px-3 py-2 text-xs text-red-400">{error}</p>}
        {!error && !searching && flatMatches.length === 0 && result && (
          <p className="px-3 py-4 text-center text-xs text-zinc-700">
            No matches for &ldquo;{query}&rdquo;
          </p>
        )}

        {groups.map(([relPath, ms]) => {
          const isCollapsed = collapsed.has(relPath)
          return (
            <div key={relPath} className="mb-0.5">
              <button
                data-testid={`content-search-file-${relPath}`}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(relPath)) next.delete(relPath)
                    else next.add(relPath)
                    return next
                  })
                }
                title={ms[0]?.path}
                className="flex w-full items-center gap-1 px-2 py-1 text-start hover:bg-zinc-900"
              >
                {isCollapsed ? (
                  <ChevronRight size={10} className="shrink-0 text-zinc-600 rtl:rotate-180" />
                ) : (
                  <ChevronDown size={10} className="shrink-0 text-zinc-600" />
                )}
                <FileText size={10} className="shrink-0 text-zinc-500" />
                <span dir="ltr" className="truncate font-mono text-[10px] text-zinc-400">
                  {relPath}
                </span>
                <span className="ms-auto shrink-0 rounded-full bg-zinc-800 px-1.5 text-[9px] text-zinc-500">
                  {ms.length}
                </span>
              </button>

              {!isCollapsed &&
                ms.map((m) => {
                  runningIdx++
                  const selected = runningIdx === selectedIdx
                  const myIdx = runningIdx
                  return (
                    <button
                      key={`${m.path}:${m.line}:${m.column}`}
                      data-testid={`content-search-match-${myIdx}`}
                      onClick={() => openMatch(m)}
                      className={cn(
                        'flex w-full items-baseline gap-1.5 py-0.5 pe-2 ps-6 text-start',
                        selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                      )}
                    >
                      <span dir="ltr" className="shrink-0 font-mono text-[9px] text-zinc-600">
                        {m.line}
                      </span>
                      <span dir="auto" className="truncate font-mono text-[10px] text-zinc-400">
                        <HighlightedLine text={m.lineText} term={m.term} />
                      </span>
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
