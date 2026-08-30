// src/renderer/src/App.tsx
import { useEffect, useCallback } from 'react'
import { useStore } from './store'
import { usePiEvents } from './hooks/usePiEvents'
import { useUpdateEvents } from './hooks/useUpdateEvents'
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
  const setExtensionDialog = useStore((s) => s.setExtensionDialog)
  const setTreePicker = useStore((s) => s.setTreePicker)
  const setToast = useStore((s) => s.setToast)
  const tabCount = useStore((s) => s.tabs.tabs.length)

  // Register global pi event listeners (routes to correct tab by sessionId)
  usePiEvents()
  useUpdateEvents()

  const loadSessions = useCallback(async () => {
    try {
      const sessions = await window.pi.sessions.list()
      setSessions(sessions)
    } catch (err) {
      console.error('Failed to load sessions:', err)
    }
  }, [setSessions])

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

    loadSessions()
  }, [setConfig, setModels, loadSessions])

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
      setExtensionDialog(payload)
    })
    const offTree = window.pi.on('pi:tree-picker', (payload) => {
      setTreePicker(payload)
    })
    const offNotify = window.pi.on('pi:notify', (payload) => {
      setToast({ message: payload.message, level: payload.level })
    })
    return () => {
      offReady()
      offUi()
      offTree()
      offNotify()
    }
  }, [loadSessions, setExtensionDialog, setTreePicker, setToast])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        openSettings()
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
