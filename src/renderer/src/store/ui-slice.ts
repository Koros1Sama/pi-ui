// src/renderer/src/store/ui-slice.ts

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up-to-date'
  | 'error'

export type SessionViewMode = 'grouped' | 'recent'

/** A blocking extension dialog forwarded from the pi subprocess. */
export interface ExtensionDialog {
  sessionId: string
  requestId: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title?: string
  message?: string
  placeholder?: string
  prefill?: string
  options?: string[]
}

/** Interactive session-tree picker state (fork points from /tree). */
export interface TreePickerState {
  sessionId: string
  nodes: import('@shared/types').TreePickerNode[]
}

/** A transient extension notification (toast). */
export interface ToastState {
  message: string
  level: string
}

/** Extension widgets + statuses, keyed by sessionId (ctx.ui.setWidget/setStatus). */
export interface ExtensionWidgetsState {
  widgets: Record<string, Record<string, string[]>>
  statuses: Record<string, Record<string, string>>
}

export interface UiState {
  settingsOpen: boolean
  newSessionOpen: boolean
  updateStatus: UpdateStatus
  updateVersion: string | null
  updateProgress: number | null
  updateError: string | null
  sessionViewMode: SessionViewMode
  /** FIFO queue — a second request must never silently replace (and strand) the first. */
  extensionDialogs: ExtensionDialog[]
  treePicker: TreePickerState | null
  toast: ToastState | null
  extensionWidgets: ExtensionWidgetsState
}

export interface UiActions {
  openSettings(): void
  closeSettings(): void
  openNewSession(): void
  closeNewSession(): void
  setUpdateStatus(
    status: UpdateStatus,
    version?: string | null,
    progress?: number | null,
    error?: string | null
  ): void
  setSessionViewMode(mode: SessionViewMode): void
  pushExtensionDialog(dialog: ExtensionDialog): void
  shiftExtensionDialog(): void
  setTreePicker(picker: TreePickerState | null): void
  setToast(toast: ToastState | null): void
  setExtensionWidget(sessionId: string, key: string, lines: string[] | null): void
  setExtensionStatus(sessionId: string, key: string, text: string | null): void
}

export const initialUiState: UiState = {
  settingsOpen: false,
  newSessionOpen: false,
  updateStatus: 'idle',
  updateVersion: null,
  updateProgress: null,
  updateError: null,
  sessionViewMode: 'grouped',
  extensionDialogs: [],
  treePicker: null,
  toast: null,
  extensionWidgets: { widgets: {}, statuses: {} },
}

export const createUiSlice = (set: (fn: (s: { ui: UiState }) => void) => void): UiActions => ({
  openSettings: () =>
    set((s) => {
      s.ui.settingsOpen = true
    }),
  closeSettings: () =>
    set((s) => {
      s.ui.settingsOpen = false
    }),
  openNewSession: () =>
    set((s) => {
      s.ui.newSessionOpen = true
    }),
  closeNewSession: () =>
    set((s) => {
      s.ui.newSessionOpen = false
    }),
  setUpdateStatus: (status, version = null, progress = null, error = null) =>
    set((s) => {
      s.ui.updateStatus = status
      if (version !== undefined) s.ui.updateVersion = version
      if (progress !== undefined) s.ui.updateProgress = progress
      if (error !== undefined) s.ui.updateError = error
    }),
  setSessionViewMode: (mode) =>
    set((s) => {
      s.ui.sessionViewMode = mode
    }),
  pushExtensionDialog: (dialog) =>
    set((s) => {
      s.ui.extensionDialogs.push(dialog)
    }),
  shiftExtensionDialog: () =>
    set((s) => {
      s.ui.extensionDialogs.shift()
    }),
  setTreePicker: (picker) =>
    set((s) => {
      s.ui.treePicker = picker
    }),
  setToast: (toast) =>
    set((s) => {
      s.ui.toast = toast
    }),
  setExtensionWidget: (sessionId, key, lines) =>
    set((s) => {
      const bySession = s.ui.extensionWidgets.widgets[sessionId] ?? {}
      if (lines === null) {
        delete bySession[key]
      } else {
        bySession[key] = lines
      }
      if (Object.keys(bySession).length === 0) {
        delete s.ui.extensionWidgets.widgets[sessionId]
      } else {
        s.ui.extensionWidgets.widgets[sessionId] = bySession
      }
    }),
  setExtensionStatus: (sessionId, key, text) =>
    set((s) => {
      const bySession = s.ui.extensionWidgets.statuses[sessionId] ?? {}
      if (text === null) {
        delete bySession[key]
      } else {
        bySession[key] = text
      }
      if (Object.keys(bySession).length === 0) {
        delete s.ui.extensionWidgets.statuses[sessionId]
      } else {
        s.ui.extensionWidgets.statuses[sessionId] = bySession
      }
    }),
})
