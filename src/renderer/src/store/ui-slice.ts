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

export interface UiState {
  settingsOpen: boolean
  newSessionOpen: boolean
  updateStatus: UpdateStatus
  updateVersion: string | null
  updateProgress: number | null
  updateError: string | null
  sessionViewMode: SessionViewMode
  extensionDialog: ExtensionDialog | null
  treePicker: TreePickerState | null
  toast: ToastState | null
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
  setExtensionDialog(dialog: ExtensionDialog | null): void
  setTreePicker(picker: TreePickerState | null): void
  setToast(toast: ToastState | null): void
}

export const initialUiState: UiState = {
  settingsOpen: false,
  newSessionOpen: false,
  updateStatus: 'idle',
  updateVersion: null,
  updateProgress: null,
  updateError: null,
  sessionViewMode: 'grouped',
  extensionDialog: null,
  treePicker: null,
  toast: null,
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
  setExtensionDialog: (dialog) =>
    set((s) => {
      s.ui.extensionDialog = dialog
    }),
  setTreePicker: (picker) =>
    set((s) => {
      s.ui.treePicker = picker
    }),
  setToast: (toast) =>
    set((s) => {
      s.ui.toast = toast
    }),
})
