// src/renderer/src/store/tabs-slice.ts
import type { Message, ToolCall, AppThinkingLevel, DiffComment, TabDiff } from '@shared/types'

const uuid = () => crypto.randomUUID()

export type TabMode = 'active' | 'readonly' | 'loading' | 'error'

export interface Tab {
  id: string // tabId == sessionId passed to IPC
  sessionId: string // explicit alias of id for call-site clarity
  cwd: string
  model: string
  provider: string
  thinkingLevel: AppThinkingLevel
  /** Thinking levels the session's current model supports (fetched live per model). Undefined = not fetched yet. */
  thinkingLevels?: string[]
  status: 'idle' | 'booting' | 'thinking' | 'error'
  messages: Message[]
  currentStreamingContent: string
  mode: TabMode
  readonlySessionId?: string // past session id for readonly/loading/error tabs
  diffPaneOpen: boolean
  currentDiff: TabDiff | null
  diffComments: DiffComment[]
}

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  /** Most-recently-used tab ids (front = current). Drives Ctrl+Tab MRU
   *  switching, Firefox/Alt+Tab style. */
  mru: string[]
  /** Tab highlighted by an in-progress Ctrl+Tab walk — activated on keyup. */
  previewTabId: string | null
}

/** Next tab when cycling MRU order (delta 1 = toward older, -1 = reverse). */
export function mruTarget(mru: string[], currentId: string | null, delta: 1 | -1): string | null {
  if (mru.length < 2 || !currentId) return null
  const i = mru.indexOf(currentId)
  if (i === -1) return mru[0] ?? null
  return mru[(i + delta + mru.length) % mru.length] ?? null
}

/** Next tab when cycling tab-bar POSITION (delta 1 = right, -1 = left). */
export function positionalTarget(
  tabs: Tab[],
  currentId: string | null,
  delta: 1 | -1
): string | null {
  if (tabs.length < 2 || !currentId) return null
  const i = tabs.findIndex((t) => t.id === currentId)
  if (i === -1) return tabs[0]?.id ?? null
  return tabs[(i + delta + tabs.length) % tabs.length]?.id ?? null
}

export interface TabsActions {
  createTab(tab: Tab): void
  closeTab(tabId: string): void
  setActiveTab(tabId: string): void
  /** Highlight a tab during a Ctrl+Tab walk (activated on Control keyup). */
  setTabPreview(tabId: string | null): void
  setTabStatus(tabId: string, status: Tab['status']): void
  setTabMode(tabId: string, mode: TabMode): void
  setTabMessages(tabId: string, messages: Message[]): void
  addUserMessage(tabId: string, content: string, pending?: boolean): void
  /** Remove a message (e.g. user cancels a queued steer). */
  removeUserMessage(tabId: string, messageId: string): void
  /** The session confirmed delivery of the oldest pending (steered) message. */
  confirmPendingUserMessage(tabId: string): void
  /** Flush all pending markers (activity resumed / turn settled). */
  clearPendingUserMessages(tabId: string): void
  appendToken(tabId: string, delta: string): void
  finalizeAssistantMessage(tabId: string): void
  addToolCall(
    tabId: string,
    call: { toolCallId: string; toolName: string; args: Record<string, unknown> }
  ): void
  resolveToolCall(
    tabId: string,
    result: {
      toolCallId: string
      result: string
      details?: import('@shared/types').ToolResultDetails | null
      isError: boolean
      durationMs: number
    }
  ): void
  replaceTab(tabId: string, newTab: Tab): void
  /** Narrow field update — unlike replaceTab it can't clobber concurrent
   *  streaming state (tokens/status) with a stale render-time snapshot. */
  patchTab(
    tabId: string,
    patch: Partial<Pick<Tab, 'model' | 'provider' | 'thinkingLevel' | 'thinkingLevels'>>
  ): void
  setTabDiff(tabId: string, diff: TabDiff): void
  toggleDiffPane(tabId: string): void
  addDiffComment(tabId: string, comment: DiffComment): void
  removeDiffComment(tabId: string, commentId: string): void
  clearDiffComments(tabId: string): void
}

export const initialTabsState: TabsState = {
  tabs: [],
  activeTabId: null,
  mru: [],
  previewTabId: null,
}

export const createTabsSlice = (
  set: (fn: (s: { tabs: TabsState }) => void) => void
): TabsActions => ({
  createTab: (tab) =>
    set((s) => {
      s.tabs.tabs.push(tab)
      s.tabs.activeTabId = tab.id
      s.tabs.mru = [tab.id, ...s.tabs.mru.filter((id) => id !== tab.id)]
    }),

  closeTab: (tabId) =>
    set((s) => {
      const idx = s.tabs.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return
      s.tabs.tabs.splice(idx, 1)
      s.tabs.mru = s.tabs.mru.filter((id) => id !== tabId)
      if (s.tabs.previewTabId === tabId) s.tabs.previewTabId = null
      if (s.tabs.activeTabId === tabId) {
        const next = s.tabs.tabs[idx - 1] ?? s.tabs.tabs[idx] ?? null
        s.tabs.activeTabId = next?.id ?? null
      }
    }),

  setActiveTab: (tabId) =>
    set((s) => {
      s.tabs.activeTabId = tabId
      // Recency order only changes on USER-driven focus, not programmatic
      // tab bookkeeping — safe to record on every activation.
      s.tabs.mru = [tabId, ...s.tabs.mru.filter((id) => id !== tabId)]
    }),

  setTabPreview: (tabId) =>
    set((s) => {
      s.tabs.previewTabId = tabId
    }),

  setTabStatus: (tabId, status) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.status = status
    }),

  setTabMode: (tabId, mode) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.mode = mode
    }),

  setTabMessages: (tabId, messages) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.messages = messages
    }),

  addUserMessage: (tabId, content, pending) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      tab.messages.push({
        id: uuid(),
        role: 'user',
        content,
        toolCalls: [],
        createdAt: Date.now(),
        pending,
      })
    }),

  removeUserMessage: (tabId, messageId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      tab.messages = tab.messages.filter((m) => m.id !== messageId)
    }),

  confirmPendingUserMessage: (tabId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      const first = tab.messages.find((m) => m.pending)
      if (first) first.pending = false
    }),

  clearPendingUserMessages: (tabId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      for (const m of tab.messages) if (m.pending) m.pending = false
    }),

  appendToken: (tabId, delta) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.currentStreamingContent += delta
    }),

  finalizeAssistantMessage: (tabId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab || !tab.currentStreamingContent) return
      tab.messages.push({
        id: uuid(),
        role: 'assistant',
        content: tab.currentStreamingContent,
        toolCalls: [],
        createdAt: Date.now(),
      })
      tab.currentStreamingContent = ''
    }),

  addToolCall: (tabId, { toolCallId, toolName, args }) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      // Flush any streaming text into a real assistant message first so the
      // tool call attaches to the message it actually follows — otherwise it
      // lands on the previous turn (or a user message) and the chronology
      // scrambles. Post-tool text streams into a fresh bubble.
      if (tab.currentStreamingContent) {
        tab.messages.push({
          id: uuid(),
          role: 'assistant',
          content: tab.currentStreamingContent,
          toolCalls: [],
          createdAt: Date.now(),
        })
        tab.currentStreamingContent = ''
      }
      let target = tab.messages[tab.messages.length - 1]
      if (!target || target.role !== 'assistant') {
        // Tool call before any assistant text — create a carrier message.
        target = {
          id: uuid(),
          role: 'assistant',
          content: '',
          toolCalls: [],
          createdAt: Date.now(),
        }
        tab.messages.push(target)
      }
      const call: ToolCall = {
        id: toolCallId,
        toolName,
        args,
        result: null,
        details: null,
        isError: false,
        durationMs: null,
        status: 'pending',
      }
      target.toolCalls.push(call)
    }),

  resolveToolCall: (tabId, { toolCallId, result, details, isError, durationMs }) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      for (const msg of tab.messages) {
        const call = msg.toolCalls.find((c) => c.id === toolCallId)
        if (call) {
          call.result = result
          call.details = details ?? null
          call.isError = isError
          call.durationMs = durationMs
          call.status = 'done'
          break
        }
      }
    }),

  replaceTab: (tabId, newTab) =>
    set((s) => {
      const idx = s.tabs.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return
      s.tabs.tabs[idx] = newTab
      s.tabs.activeTabId = newTab.id
      s.tabs.mru = s.tabs.mru.map((id) => (id === tabId ? newTab.id : id))
    }),

  patchTab: (tabId, patch) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      Object.assign(tab, patch)
    }),

  setTabDiff: (tabId, diff) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      tab.currentDiff = diff
      tab.diffPaneOpen = true
      tab.diffComments = []
    }),

  toggleDiffPane: (tabId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.diffPaneOpen = !tab.diffPaneOpen
    }),

  addDiffComment: (tabId, comment) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.diffComments.push(comment)
    }),

  removeDiffComment: (tabId, commentId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return
      tab.diffComments = tab.diffComments.filter((c) => c.id !== commentId)
    }),

  clearDiffComments: (tabId) =>
    set((s) => {
      const tab = s.tabs.tabs.find((t) => t.id === tabId)
      if (tab) tab.diffComments = []
    }),
})
