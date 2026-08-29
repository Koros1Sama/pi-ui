// src/renderer/src/components/sidebar/SessionList.tsx
import { useState, useMemo } from 'react'
import { Clock, Layers, RefreshCw } from 'lucide-react'
import { useStore } from '@/store'
import { formatTimestamp } from './SessionEntry'
import CwdGroup from './CwdGroup'
import SessionEntry from './SessionEntry'
import SessionSearch from './SessionSearch'
import type { SessionSummary } from '@shared/types'

function cwdBasename(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
}

export default function SessionList() {
  const sessions = useStore((s) => s.history.sessions)
  const expandedCwds = useStore((s) => s.history.expandedCwds)
  const toggleCwdExpanded = useStore((s) => s.toggleCwdExpanded)
  const setSessions = useStore((s) => s.setSessions)
  const tabs = useStore((s) => s.tabs.tabs)
  const activeTabId = useStore((s) => s.tabs.activeTabId)
  const createTab = useStore((s) => s.createTab)
  const models = useStore((s) => s.config.models)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const setTabMessages = useStore((s) => s.setTabMessages)
  const setTabMode = useStore((s) => s.setTabMode)
  const viewMode = useStore((s) => s.ui.sessionViewMode)
  const setSessionViewMode = useStore((s) => s.setSessionViewMode)

  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  // The session the ACTIVE top tab points at: live sessions are matched via
  // liveSessionId (the tab id), past-session tabs via the sdk id.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const selectedLiveId = activeTab?.mode === 'active' ? activeTab.sessionId : null
  const selectedSdkId = activeTab?.readonlySessionId ?? null

  function isSelected(session: SessionSummary): boolean {
    return (
      (selectedLiveId != null && session.liveSessionId === selectedLiveId) ||
      (selectedSdkId != null && session.id === selectedSdkId)
    )
  }

  const groups = useMemo(() => {
    const map = new Map<string, { cwd: string; slug: string; sessions: SessionSummary[] }>()
    for (const s of sessions) {
      if (!map.has(s.cwdSlug)) {
        map.set(s.cwdSlug, { cwd: s.cwd, slug: s.cwdSlug, sessions: [] })
      }
      map.get(s.cwdSlug)!.sessions.push(s)
    }
    return Array.from(map.values()).sort((a, b) => {
      const aMax = Math.max(...a.sessions.map((s) => s.lastActiveAt))
      const bMax = Math.max(...b.sessions.map((s) => s.lastActiveAt))
      return bMax - aMax
    })
  }, [sessions])

  const filteredGroups = useMemo(() => {
    if (!query.trim()) return groups
    const q = query.toLowerCase()
    return groups
      .map((g) => ({
        ...g,
        sessions: g.sessions.filter((s) => {
          const label = (s.name ?? formatTimestamp(s.lastActiveAt)).toLowerCase()
          return label.includes(q) || g.cwd.toLowerCase().includes(q)
        }),
      }))
      .filter((g) => g.sessions.length > 0)
  }, [groups, query])

  /** Flat "recent first" list — same sessions without project grouping. */
  const filteredFlat = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? sessions.filter((s) => {
          const label = (s.name ?? formatTimestamp(s.lastActiveAt)).toLowerCase()
          return label.includes(q) || s.cwd.toLowerCase().includes(q)
        })
      : sessions
    return [...list].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.lastActiveAt - a.lastActiveAt
    })
  }, [sessions, query])

  function isExpanded(slug: string): boolean {
    if (query.trim()) return true
    return expandedCwds.includes(slug)
  }

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const updated = await window.pi.sessions.list()
      setSessions(updated)
    } catch (err) {
      console.error('[sessions:refresh]', err)
    } finally {
      setRefreshing(false)
    }
  }

  async function handleSelectSession(session: SessionSummary) {
    // Deduplication: if a tab already has this session open, just focus it
    const existing = tabs.find(
      (t) => t.readonlySessionId === session.id || t.sessionId === session.id
    )
    if (existing) {
      setActiveTab(existing.id)
      return
    }

    // Create a loading tab
    const tabId = crypto.randomUUID()
    const resolvedModel = session.model ?? ''
    const resolvedProvider = models.find((m) => m.modelId === resolvedModel)?.provider ?? ''
    createTab({
      id: tabId,
      sessionId: tabId,
      cwd: session.cwd,
      model: resolvedModel,
      provider: resolvedProvider,
      thinkingLevel: 'off',
      status: 'idle',
      messages: [],
      currentStreamingContent: '',
      mode: 'loading',
      readonlySessionId: session.id,
      diffPaneOpen: false,
      currentDiff: null,
      diffComments: [],
    })

    try {
      const messages = await window.pi.sessions.load(session.path)
      setTabMessages(tabId, messages)
      setTabMode(tabId, 'readonly')
    } catch {
      setTabMode(tabId, 'error')
    }
  }

  async function handleRename(session: SessionSummary, name: string) {
    if (!name.trim()) return
    try {
      await window.pi.sessions.setName(session.id, name.trim())
    } catch (err) {
      console.error('[rename:setName]', err)
    }
    const updated = await window.pi.sessions.list()
    setSessions(updated)
  }

  async function handleTogglePin(session: SessionSummary) {
    await window.pi.sessions.updateMeta(session.id, { pinned: !session.pinned })
    const updated = await window.pi.sessions.list()
    setSessions(updated)
  }

  async function handleDelete(session: SessionSummary) {
    await window.pi.sessions.delete(session.id)
    const updated = await window.pi.sessions.list()
    setSessions(updated)
  }

  const noMatches =
    query && (viewMode === 'grouped' ? filteredGroups.length === 0 : filteredFlat.length === 0)

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 pb-0.5 pt-1.5">
        <div className="flex items-center gap-1">
          <button
            data-testid="view-grouped-btn"
            title="Group by project"
            aria-label="Group sessions by project"
            onClick={() => setSessionViewMode('grouped')}
            className={`rounded p-1 transition-colors ${
              viewMode === 'grouped'
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-600 hover:text-zinc-400'
            }`}
          >
            <Layers size={12} />
          </button>
          <button
            data-testid="view-recent-btn"
            title="Recent first — all sessions, no project grouping"
            aria-label="Sort sessions by recent activity"
            onClick={() => setSessionViewMode('recent')}
            className={`rounded p-1 transition-colors ${
              viewMode === 'recent'
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-600 hover:text-zinc-400'
            }`}
          >
            <Clock size={12} />
          </button>
        </div>
        <button
          data-testid="sessions-refresh-btn"
          title="Refresh sessions (pick up CLI changes)"
          aria-label="Refresh sessions"
          onClick={() => void handleRefresh()}
          className="rounded p-1 text-zinc-600 transition-colors hover:text-zinc-400"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <SessionSearch value={query} onChange={setQuery} />

      {sessions.length > 0 && (
        <div data-testid="session-list" className="flex-1 space-y-1 overflow-y-auto px-2 py-1">
          {viewMode === 'grouped'
            ? filteredGroups.map((g) => (
                <CwdGroup
                  key={g.slug}
                  cwdSlug={g.slug}
                  cwd={g.cwd}
                  sessions={g.sessions}
                  expanded={isExpanded(g.slug)}
                  selectedLiveId={selectedLiveId}
                  selectedSdkId={selectedSdkId}
                  onToggle={() => toggleCwdExpanded(g.slug)}
                  onSelectSession={handleSelectSession}
                  onRenameSession={handleRename}
                  onTogglePinSession={handleTogglePin}
                  onDeleteSession={handleDelete}
                />
              ))
            : filteredFlat.map((session) => (
                <div key={session.id} className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <SessionEntry
                      session={session}
                      isSelected={isSelected(session)}
                      onClick={() => handleSelectSession(session)}
                      onRename={(name) => handleRename(session, name)}
                      onTogglePin={() => handleTogglePin(session)}
                      onDelete={() => handleDelete(session)}
                    />
                  </div>
                  <span
                    className="shrink-0 max-w-[70px] truncate text-[10px] text-zinc-700"
                    title={session.cwd}
                  >
                    {cwdBasename(session.cwd)}
                  </span>
                </div>
              ))}
          {noMatches && (
            <p className="py-4 text-center text-xs text-zinc-700">
              No sessions match &ldquo;{query}&rdquo;
            </p>
          )}
        </div>
      )}

      {sessions.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-zinc-700">
          No sessions yet.
          <br />
          Start one with +
        </div>
      )}
    </div>
  )
}
