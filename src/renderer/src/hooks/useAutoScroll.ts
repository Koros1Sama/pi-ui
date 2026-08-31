// src/renderer/src/hooks/useAutoScroll.ts
import { useEffect, useRef } from 'react'

/**
 * Scrolls a container to the bottom whenever `trigger` changes,
 * unless the user has manually scrolled up.
 */
export function useAutoScroll<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      userScrolledUp.current = !atBottom
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (userScrolledUp.current) return
    const el = ref.current
    // Skip while the container is hidden (display:none): its layout is zeroed,
    // and the trigger will fire again once it becomes visible so the pane
    // lands at the bottom when revealed.
    if (!el || el.clientHeight === 0) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [trigger])

  return ref
}
