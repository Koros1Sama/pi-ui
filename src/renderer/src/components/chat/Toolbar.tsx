// src/renderer/src/components/chat/Toolbar.tsx
// patchTab accepts thinkingLevels via the widened Pick in tabs-slice.
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import { useActiveTab } from '@/hooks/useActiveTab'
import { useAvailableModels } from '@/hooks/useAvailableModels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AppThinkingLevel } from '@shared/types'

export default function Toolbar() {
  const tab = useActiveTab()
  const availableModels = useAvailableModels()
  const patchTab = useStore((s) => s.patchTab)
  const toggleDiffPane = useStore((s) => s.toggleDiffPane)
  /** Sessions whose thinking info was already fetched (per model). */
  const thinkingFetchedFor = useRef('')

  const tabId = tab?.id
  const sessionId = tab?.sessionId
  const mode = tab?.mode
  const status = tab?.status

  // Mirror the session's real thinking state: levels come from the model the
  // chat is actually running — fetched once per session once the RPC is up.
  // Failed attempts (still booting) retry on the next status flip.
  useEffect(() => {
    if (!tabId || !sessionId || mode !== 'active' || status === 'booting') return
    if (thinkingFetchedFor.current === sessionId) return
    let cancelled = false
    void (async () => {
      try {
        const info = await window.pi.session.getThinking(sessionId)
        if (cancelled) return
        thinkingFetchedFor.current = sessionId
        patchTab(tabId, { thinkingLevel: info.level, thinkingLevels: info.levels })
      } catch {
        // RPC not ready yet — the effect re-runs when the status changes
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tabId, sessionId, mode, status, patchTab])

  if (!tab) return null

  async function handleModelChange(val: string) {
    if (!tab) return
    const [p, ...rest] = val.split('/')
    const m = rest.join('/')
    try {
      // Real RPC set_model — the TUI-only "/model" text command does not
      // execute through the RPC prompt path.
      await window.pi.session.setModel(tab.sessionId, p, m)
      // patchTab avoids clobbering streaming state with a stale snapshot.
      patchTab(tab.id, { model: m, provider: p })
      // New model → new supported thinking levels; refetch and mirror them.
      const info = await window.pi.session.getThinking(tab.sessionId)
      thinkingFetchedFor.current = tab.sessionId
      patchTab(tab.id, { thinkingLevel: info.level, thinkingLevels: info.levels })
    } catch (err) {
      console.error(err)
    }
  }

  async function handleThinkingChange(level: AppThinkingLevel) {
    if (!tab) return
    try {
      await window.pi.session.setThinking(tab.sessionId, level)
      // Confirm from the session before reflecting: the UI mirrors what the
      // chat actually applied, not what we asked for.
      const info = await window.pi.session.getThinking(tab.sessionId)
      patchTab(tab.id, { thinkingLevel: info.level, thinkingLevels: info.levels })
      // Persist as the default so new sessions start at the chosen effort.
      await window.pi.config.setDefaults({ defaultThinkingLevel: info.level })
    } catch (err) {
      console.error(err)
    }
  }

  // Readonly / loading tabs: show plain text, no dropdowns
  if (tab.mode !== 'active') {
    return (
      <div
        data-testid="chat-toolbar"
        className="flex items-center gap-3 border-b border-[var(--pi-border-subtle)] bg-[var(--pi-sidebar-bg)] px-3 py-2"
      >
        <span className="text-xs text-zinc-500">{tab.model || '—'}</span>
        <span className="ms-auto max-w-[200px] truncate text-xs text-zinc-600">{tab.cwd}</span>
      </div>
    )
  }

  return (
    <div
      data-testid="chat-toolbar"
      className="flex items-center gap-3 border-b border-[var(--pi-border-subtle)] bg-[var(--pi-sidebar-bg)] px-3 py-2"
    >
      <Select value={`${tab.provider}/${tab.model}`} onValueChange={handleModelChange}>
        <SelectTrigger className="h-7 w-48 border-zinc-800 bg-zinc-900 text-zinc-400">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          className="max-h-60 overflow-y-auto border-zinc-800 bg-zinc-900"
        >
          {availableModels.map((m) => (
            <SelectItem
              key={`${m.provider}/${m.modelId}`}
              value={`${m.provider}/${m.modelId}`}
              className="text-xs text-zinc-300"
            >
              {m.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Effort levels driven by the session's CURRENT model — fetched live
          over RPC. Hidden while unknown (booting) and for models without
          reasoning levels. */}
      {tab.thinkingLevels && tab.thinkingLevels.length > 1 && (
        <div
          data-testid="thinking-levels"
          className="flex overflow-hidden rounded border border-zinc-800"
        >
          {tab.thinkingLevels.map((level) => (
            <button
              key={level}
              title={`Set thinking level (${level}) — Shift+Tab cycles`}
              onClick={() => void handleThinkingChange(level as AppThinkingLevel)}
              className={cn(
                'px-2 py-0.5 text-[11px] capitalize transition-colors',
                tab.thinkingLevel === level
                  ? 'bg-[var(--pi-tool-success-bg)] text-[var(--pi-accent)]'
                  : 'text-zinc-600 hover:text-zinc-400'
              )}
            >
              {level === 'minimal' ? 'mini' : level}
            </button>
          ))}
        </div>
      )}

      {/* Diff pane toggle */}
      {tab.currentDiff && (
        <button
          data-testid="diff-pane-toggle-btn"
          onClick={() => toggleDiffPane(tab.id)}
          title={tab.diffPaneOpen ? 'Hide diff pane' : 'Show diff pane'}
          className={cn(
            'rounded border px-2 py-0.5 text-xs transition-colors',
            tab.diffPaneOpen
              ? 'border-[var(--pi-accent)] text-[var(--pi-accent)]'
              : 'border-zinc-800 text-zinc-600 hover:text-zinc-400'
          )}
        >
          ⊞
        </button>
      )}

      <button
        onClick={() => tab.cwd && window.pi.shell.openPath(tab.cwd)}
        className="ms-auto max-w-[200px] truncate text-zinc-600 transition-colors hover:text-zinc-400"
      >
        {tab.cwd}
      </button>
    </div>
  )
}
