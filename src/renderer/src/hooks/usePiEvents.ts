import { useEffect } from 'react'
import { useStore } from '../store'

const DIFF_TOOLS = new Set(['write', 'edit', 'read_write', 'patch'])

/**
 * Registers global pi event listeners and routes each event to the correct
 * tab by sessionId. Call once at the App level — not per-tab.
 */
export function usePiEvents(): void {
  const appendToken = useStore((s) => s.appendToken)
  const setTabStatus = useStore((s) => s.setTabStatus)
  const finalizeAssistantMessage = useStore((s) => s.finalizeAssistantMessage)
  const addToolCall = useStore((s) => s.addToolCall)
  const resolveToolCall = useStore((s) => s.resolveToolCall)
  const setTabDiff = useStore((s) => s.setTabDiff)
  const confirmPendingUserMessage = useStore((s) => s.confirmPendingUserMessage)
  const clearPendingUserMessages = useStore((s) => s.clearPendingUserMessages)

  useEffect(() => {
    function findTabId(sessionId: string): string | null {
      const { tabs } = useStore.getState().tabs
      return tabs.find((t) => t.id === sessionId)?.id ?? null
    }

    // Track tool call args by toolCallId so pi:tool-end can access them
    const toolArgs = new Map<string, Record<string, unknown>>()

    // Token batching: every appendToken re-renders the message list (and
    // re-parses the streaming markdown). Flushing per-token made long
    // responses janky — accumulate deltas per tab and flush at ~16fps.
    const pendingTokens = new Map<string, string>()
    function flushTokens(): void {
      if (pendingTokens.size === 0) return
      const entries = Array.from(pendingTokens.entries())
      pendingTokens.clear()
      for (const [tabId, delta] of entries) {
        appendToken(tabId, delta)
        setTabStatus(tabId, 'thinking')
      }
    }

    const unsubs = [
      window.pi.on('pi:token', ({ sessionId, delta }) => {
        const tabId = findTabId(sessionId)
        if (!tabId) return
        pendingTokens.set(tabId, (pendingTokens.get(tabId) ?? '') + delta)
        // Streaming resumes only after the steer queue flushed — any queued
        // user message is definitely inside the transcript by now.
        clearPendingUserMessages(tabId)
      }),

      window.pi.on('pi:booting', ({ sessionId }) => {
        flushTokens()
        const tabId = findTabId(sessionId)
        if (!tabId) return
        setTabStatus(tabId, 'booting')
      }),

      window.pi.on('pi:session-ready', ({ sessionId }) => {
        const tabId = findTabId(sessionId)
        if (!tabId) return
        // A freshly booted session becomes usable (booting → idle) without
        // clobbering a thinking state if the user already sent.
        const tab = useStore.getState().tabs.tabs.find((t) => t.id === tabId)
        if (tab && tab.status === 'booting') setTabStatus(tabId, 'idle')
      }),

      window.pi.on('pi:user-message', ({ sessionId }) => {
        const tabId = findTabId(sessionId)
        if (!tabId) return
        // The session echoed a user message into the transcript — the oldest
        // pending (steered) one is delivered (FIFO queue).
        confirmPendingUserMessage(tabId)
      }),

      window.pi.on('pi:tool-start', ({ sessionId, toolCallId, toolName, args }) => {
        flushTokens()
        const tabId = findTabId(sessionId)
        if (!tabId) return
        toolArgs.set(toolCallId, args)
        addToolCall(tabId, { toolCallId, toolName, args })
      }),

      window.pi.on(
        'pi:tool-end',
        ({ sessionId, toolCallId, toolName, result, details, isError, durationMs }) => {
          const tabId = findTabId(sessionId)
          if (!tabId) return
          resolveToolCall(tabId, { toolCallId, result, details, isError, durationMs })
          // Auto-open diff pane for write/edit tools with non-empty result
          if (DIFF_TOOLS.has(toolName) && result?.trim()) {
            const args = toolArgs.get(toolCallId)
            const path = typeof args?.path === 'string' ? args.path : 'unknown'
            setTabDiff(tabId, { path, unifiedDiff: result })
          }
          toolArgs.delete(toolCallId)
        }
      ),

      window.pi.on('pi:turn-end', () => {
        // Turn ended — assistant message finalized on pi:idle
      }),

      window.pi.on('pi:idle', ({ sessionId }) => {
        flushTokens()
        const tabId = findTabId(sessionId)
        if (!tabId) return
        finalizeAssistantMessage(tabId)
        setTabStatus(tabId, 'idle')
        // Run fully settled: nothing stays queued.
        clearPendingUserMessages(tabId)
      }),

      window.pi.on('pi:error', ({ sessionId }) => {
        flushTokens()
        const tabId = findTabId(sessionId)
        if (!tabId) return
        // Pin whatever partial text arrived instead of leaving a live
        // streaming cursor under an error status (and merging with the
        // next response after recovery).
        finalizeAssistantMessage(tabId)
        setTabStatus(tabId, 'error')
      }),
    ]

    const flushTimer = setInterval(flushTokens, 60)
    return () => {
      clearInterval(flushTimer)
      flushTokens() // don't lose the tail
      unsubs.forEach((unsub) => unsub())
    }
  }, [
    appendToken,
    setTabStatus,
    finalizeAssistantMessage,
    addToolCall,
    resolveToolCall,
    setTabDiff,
    confirmPendingUserMessage,
    clearPendingUserMessages,
  ])
}
