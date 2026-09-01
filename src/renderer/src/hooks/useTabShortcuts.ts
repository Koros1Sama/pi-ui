// src/renderer/src/hooks/useTabShortcuts.ts
import { useEffect } from 'react'
import { useStore } from '@/store'
import { positionalTarget } from '@/store/tabs-slice'

/**
 * Global tab navigation shortcuts:
 *
 * - Ctrl+Tab / Ctrl+Shift+Tab — OS Alt+Tab semantics (Firefox/Windows):
 *   holding Ctrl and pressing Tab WALKS the recency order with a live
 *   preview highlight; the walked-to tab only ACTIVATES when Ctrl is
 *   released. Releasing and pressing Ctrl again starts a fresh walk from
 *   the previously-focused tab. Shift reverses the walk. Escape cancels.
 * - Ctrl+PageDown / Ctrl+PageUp — instant positional switch (right / left).
 */
export function useTabShortcuts(): void {
  useEffect(() => {
    interface Walk {
      snapshot: string[]
      pointer: number
    }
    let walk: Walk | null = null

    function commitWalk(): void {
      const target = useStore.getState().tabs.previewTabId
      useStore.getState().setTabPreview(null)
      // END the walk — the next Ctrl+Tab press must start a FRESH walk from
      // the newly-active tab (previously-focused first), not continue.
      walk = null
      if (target) useStore.getState().setActiveTab(target)
    }

    function cancelWalk(): void {
      walk = null
      useStore.getState().setTabPreview(null)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return

      if (e.key === 'Tab') {
        e.preventDefault()
        const state = useStore.getState().tabs
        if (state.tabs.length < 2) return

        if (!walk) {
          const anchor = state.activeTabId
          if (!anchor) return
          // MRU snapshot anchored at the tab active when the walk started —
          // repeated Ctrl+Tab presses keep walking OLDER tabs without
          // reordering anything until Ctrl is released.
          walk = { snapshot: [anchor, ...state.mru.filter((id) => id !== anchor)], pointer: 1 }
        } else {
          const n = walk.snapshot.length
          walk.pointer = (walk.pointer + (e.shiftKey ? -1 : 1) + n) % n
        }
        const candidate = walk.snapshot[walk.pointer]
        if (candidate) useStore.getState().setTabPreview(candidate)
        return
      }

      if (e.key === 'Escape' && walk) {
        e.preventDefault()
        cancelWalk()
        return
      }

      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault()
        // Positional switching is instant — no preview semantics needed.
        const state = useStore.getState().tabs
        const target = positionalTarget(
          state.tabs,
          state.activeTabId,
          e.key === 'PageDown' ? 1 : -1
        )
        if (target) useStore.getState().setActiveTab(target)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      // Releasing the modifier is the OS-style commit moment.
      if ((e.key === 'Control' || e.key === 'Meta') && walk) commitWalk()
    }

    const onBlur = () => {
      // Window lost focus mid-walk (keyup may never arrive) — commit so the
      // preview never sticks.
      if (walk) commitWalk()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
