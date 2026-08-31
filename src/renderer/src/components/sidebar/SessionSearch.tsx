// src/renderer/src/components/sidebar/SessionSearch.tsx
import { useRef, useState, type KeyboardEvent } from 'react'
import { Search, X, FileSearch, CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  value: string
  onChange(query: string): void
  /** Content-search mode: search INSIDE project files (like VS Code Ctrl+Shift+F) */
  contentMode: boolean
  onToggleContentMode(): void
}

const SYNTAX_ROWS: [string, string][] = [
  ['word', 'contains — all terms must match'],
  ['"exact text"', 'literal phrase'],
  ['-word', 'exclude lines containing it'],
  ['path:src', 'only files under paths containing src'],
  ['-path:test', 'exclude paths'],
  ['ext:ts,tsx', 'only these extensions'],
  ['-ext:json', 'exclude extension'],
  ['foo*bar', 'wildcard — * matches anything'],
  ['case:on', 'case-sensitive matching'],
]

export default function SessionSearch({
  value,
  onChange,
  contentMode,
  onToggleContentMode,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (contentMode) {
        onToggleContentMode()
      } else {
        onChange('')
      }
      inputRef.current?.blur()
    }
  }

  return (
    <div className="relative px-2 py-1.5" data-testid="session-search-root">
      <Search size={11} className="absolute start-4 top-1/2 -translate-y-1/2 text-zinc-600" />
      <input
        ref={inputRef}
        dir="auto"
        data-testid="session-search"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={contentMode ? 'Search in project files…' : 'Search sessions…'}
        className={cn(
          'w-full rounded bg-zinc-900 py-1 ps-6 pe-14 text-zinc-300 placeholder-zinc-600 outline-none focus:ring-1',
          contentMode
            ? 'ring-1 ring-[var(--pi-accent)] focus:ring-[var(--pi-accent)]'
            : 'focus:ring-zinc-700'
        )}
      />
      <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        {contentMode && (
          <button
            data-testid="search-help-btn"
            aria-label="Search syntax help"
            title="Search syntax help"
            onClick={() => setHelpOpen((v) => !v)}
            className={cn(
              'rounded p-1 transition-colors',
              helpOpen ? 'text-zinc-300' : 'text-zinc-600 hover:text-zinc-400'
            )}
          >
            <CircleHelp size={11} />
          </button>
        )}
        {value && !contentMode && (
          <button
            onClick={() => onChange('')}
            aria-label="Clear"
            className="p-1 text-zinc-600 hover:text-zinc-400"
          >
            <X size={11} />
          </button>
        )}
        <button
          data-testid="content-search-toggle"
          aria-label={contentMode ? 'Switch to session search' : 'Search inside project files'}
          title={
            contentMode
              ? 'Content search is ON — click to search sessions instead'
              : 'Search inside project files (Ctrl+Shift+F style)'
          }
          onClick={onToggleContentMode}
          className={cn(
            'rounded p-1 transition-colors',
            contentMode ? 'text-[var(--pi-accent)]' : 'text-zinc-600 hover:text-zinc-300'
          )}
        >
          <FileSearch size={12} />
        </button>
      </div>

      {helpOpen && contentMode && (
        <div
          data-testid="search-help-popover"
          className="absolute end-2 top-full z-40 mt-1 w-[248px] rounded-lg border border-zinc-800 bg-[#161616] p-3 text-[11px] shadow-xl"
        >
          <p className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">
            Smart search syntax
          </p>
          <div className="space-y-1">
            {SYNTAX_ROWS.map(([syntax, desc]) => (
              <div key={syntax} className="flex gap-2">
                <code dir="ltr" className="shrink-0 font-mono text-[var(--pi-accent)]">
                  {syntax}
                </code>
                <span className="text-zinc-500">{desc}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 border-t border-zinc-800 pt-2 text-zinc-600">
            Combine freely: <code dir="ltr">{'"api key" TODO -test path:src ext:ts'}</code>
          </p>
        </div>
      )}
    </div>
  )
}
