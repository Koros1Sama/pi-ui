// src/renderer/src/App.tsx
import { useEffect, useCallback, useRef } from 'react'
import { useStore } from './store'
import type { SessionSummary } from '@shared/types'
import { usePiEvents } from './hooks/usePiEvents'
import { useUpdateEvents } from './hooks/useUpdateEvents'
import { useResolvedDirection } from './hooks/useResolvedDirection'
import { useTabShortcuts } from './hooks/useTabShortcuts'
import Sidebar from './components/sidebar/Sidebar'
import TabBar from './components/tabs/TabBar'
import ChatPane from './components/chat/ChatPane'
import UpdateBanner from './components/UpdateBanner'
import DiffPane from './components/diff/DiffPane'
import NewSessionDialog from './components/modals/NewSessionDialog'
import SettingsModal from './components/modals/SettingsModal'
import ExtensionUIDialog from './components/modals/ExtensionUIDialog'
import TreePickerDialog from './components/modals/TreePickerDialog'
import Toast from './components/Toast'

export default function App() {
  const setConfig = useStore((s) => s.setConfig)
  const setModels = useStore((s) => s.setModels)
  const openSettings = useStore((s) => s.openSettings)
  const setSessions = useStore((s) => s.setSessions)
  const pushExtensionDialog = useStore((s) => s.pushExtensionDialog)
  const setTreePicker = useStore((s) => s.setTreePicker)
  const setToast = useStore((s) => s.setToast)
  const tabCount = useStore((s) => s.tabs.tabs.length)
  const tabs = useStore((s) => s.tabs.tabs)
  const createTab = useStore((s) => s.createTab)
  const setTabMessages = useStore((s) => s.setTabMessages)
  const setTabMode = useStore((s) => s.setTabMode)
  /** Set once the boot-restore attempt ran — persistence waits for it so the
   *  saved list is never overwritten with the empty pre-restore state. */
  const restoredRef = useRef(false)

  // Register global pi event listeners (routes to correct tab by sessionId)
  usePiEvents()
  useUpdateEvents()
  // RTL/LTR shell direction (auto-detects from OS locale unless overridden)
  useResolvedDirection()
  // Ctrl+Tab (MRU) / Ctrl+PageUp/Down (positional) tab navigation
  useTabShortcuts()

  const loadSessions = useCallback(async () => {
    try {
      const sessions = await window.pi.sessions.list()
      setSessions(sessions)
    } catch (err) {
      console.error('Failed to load sessions:', err)
    }
  }, [setSessions])

  /** Reopen persisted tabs after sleep/crash: readonly tabs as they were,
   *  previously-live tabs as a readonly view of the newest session in their
   *  cwd — one click on Resume goes live again. Never spawns processes. */
  const restoreTabs = useCallback(async () => {
    if (restoredRef.current) return
    restoredRef.current = true
    try {
      const saved = await window.pi.prefs.getOpenTabs()
      if (!saved.length) return
      if (useStore.getState().tabs.tabs.length > 0) return
      const sessions = useStore.getState().history.sessions
      for (const p of saved) {
        let target: SessionSummary | undefined
        if (p.mode === 'readonly' && p.readonlySessionId) {
          target = sessions.find((s) => s.id === p.readonlySessionId)
        }
        if (!target && p.cwd) {
          // Newest session in the same project (list is sorted newest-first)
          target = sessions.find((s) => s.cwd === p.cwd)
        }
        if (!target) continue

        const tabId = crypto.randomUUID()
        createTab({
          id: tabId,
          sessionId: tabId,
          cwd: target.cwd,
          model: p.model || target.model || '',
          provider: p.provider || '',
          thinkingLevel: p.thinkingLevel,
          status: 'idle',
          messages: [],
          currentStreamingContent: '',
          mode: 'loading',
          readonlySessionId: target.id,
          diffPaneOpen: false,
          currentDiff: null,
          diffComments: [],
        })
        try {
          const messages = await window.pi.sessions.load(target.path)
          setTabMessages(tabId, messages)
          setTabMode(tabId, 'readonly')
        } catch {
          setTabMode(tabId, 'error')
        }
      }
    } catch (err) {
      console.error('[restoreTabs]', err)
    }
  }, [createTab, setTabMessages, setTabMode])

  useEffect(() => {
    // Config arrives instantly; the model list may wait out the pi RPC hub
    // boot (user extensions) — don't block the UI shell on it.
    window.pi.config
      .get()
      .then((config) => setConfig(config))
      .catch(console.error)
    window.pi.models
      .list()
      .then(setModels)
      .catch((err) => console.error('[models:list]', err))

    loadSessions().then(() => void restoreTabs())
  }, [setConfig, setModels, loadSessions, restoreTabs])

  // Persist open tabs (debounced) after the boot restore completed —
  // survives sleep/crash/restart with the workspace layout intact.
  useEffect(() => {
    if (!restoredRef.current) return
    const timer = setTimeout(() => {
      const persisted = useStore.getState().tabs.tabs.map((tab) => ({
        cwd: tab.cwd,
        model: tab.model,
        provider: tab.provider,
        thinkingLevel: tab.thinkingLevel,
        mode: tab.mode === 'readonly' ? ('readonly' as const) : ('active' as const),
        readonlySessionId: tab.readonlySessionId,
      }))
      window.pi.prefs.saveTabs(persisted).catch((err) => console.error('[saveTabs]', err))
    }, 800)
    return () => clearTimeout(timer)
  }, [tabs])

  // Refresh sessions list whenever a tab is opened or closed
  useEffect(() => {
    loadSessions()
  }, [tabCount, loadSessions])

  // Live sessions report their sdk id once booted — refresh so the sidebar
  // highlight and isActive flags become accurate without polling.
  useEffect(() => {
    const offReady = window.pi.on('pi:session-ready', () => {
      void loadSessions()
    })
    const offUi = window.pi.on('pi:ui-request', (payload) => {
      pushExtensionDialog(payload)
    })
    const offTree = window.pi.on('pi:tree-picker', (payload) => {
      setTreePicker(payload)
    })
    const offNotify = window.pi.on('pi:notify', (payload) => {
      setToast({ message: payload.message, level: payload.level })
    })
    const offWidget = window.pi.on('pi:widget', ({ sessionId, widgetKey, lines }) => {
      useStore.getState().setExtensionWidget(sessionId, widgetKey, lines)
    })
    const offStatus = window.pi.on('pi:status', ({ sessionId, statusKey, text }) => {
      useStore.getState().setExtensionStatus(sessionId, statusKey, text)
    })
    return () => {
      offReady()
      offUi()
      offTree()
      offNotify()
      offWidget()
      offStatus()
    }
  }, [loadSessions, pushExtensionDialog, setTreePicker, setToast])

  useEffect(() => {
    async function cycleModel(backward: boolean) {
      const state = useStore.getState()
      const tab = state.tabs.tabs.find((t) => t.id === state.tabs.activeTabId)
      if (!tab || tab.mode !== 'active') return
      try {
        const next = await window.pi.session.cycleModel(tab.sessionId, backward)
        // patchTab mutates only these fields — a whole-tab replace here could
        // revert tokens/status that streamed in during the RPC round trip.
        state.patchTab(tab.id, { provider: next.provider, model: next.modelId })
        state.setToast({ message: `⇄ ${next.displayName}`, level: 'info' })
      } catch (err) {
        console.error('[cycleModel]', err)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.code === 'Comma') {
        e.preventDefault()
        openSettings()
        return
      }
      // Ctrl+P cycles models; Ctrl+Shift+P / Alt+P go backward (pi TUI bindings).
      // e.code is layout-independent, so Arabic keyboard layouts work too.
      if (e.code === 'KeyP' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void cycleModel(e.shiftKey || e.altKey)
        return
      }
      if (e.code === 'KeyP' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        void cycleModel(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings])

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TabBar />
        <UpdateBanner />
        <div className="flex flex-1 overflow-hidden">
          <ChatPane />
          <DiffPane />
        </div>
      </div>
      <NewSessionDialog />
      <SettingsModal />
      <ExtensionUIDialog />
      <TreePickerDialog />
      <Toast />
    </div>
  )
}
