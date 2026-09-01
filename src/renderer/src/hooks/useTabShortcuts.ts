// src/renderer/src/hooks/useTabShortcuts.ts
import { useEffect } from 'react'
import { useStore } from '@/store'
import { mruTarget, positionalTarget } from '@/store/tabs-slice'

/**
 * Global tab navigation shortcuts:
 * - Ctrl+Tab / Ctrl+Shift+Tab — switch by RECENCY (Firefox / Alt+Tab style:
 *   Ctrl+Tab jumps to the previously focused tab, then older, cycling)
 * - Ctrl+PageDown / Ctrl+PageUp — switch by tab-bar position (right / left)
 */
export function useTabShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return

      if (e.key === 'Tab') {
        e.preventDefault()
        const state = useStore.getState().tabs
        const target = mruTarget(state.mru, state.activeTabId, e.shiftKey ? -1 : 1)
        if (target) useStore.getState().setActiveTab(target)
        return
      }

      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault()
        const state = useStore.getState().tabs
        const target = positionalTarget(
          state.tabs,
          state.activeTabId,
          e.key === 'PageDown' ? 1 : -1
        )
        if (target) useStore.getState().setActiveTab(target)
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
