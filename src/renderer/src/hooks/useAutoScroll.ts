// src/renderer/src/hooks/useAutoScroll.ts
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Scrolls a container to the bottom whenever `trigger` changes, unless the
 * user has manually scrolled up — and exposes a `showJump` flag so the UI
 * can offer a "jump to latest" pill while the user is reading history.
 */
export function useAutoScroll<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null)
  const userScrolledUp = useRef(false)
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      userScrolledUp.current = !atBottom
      setShowJump(!atBottom)
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

  const jumpToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    userScrolledUp.current = false
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  return { ref, showJump, jumpToBottom }
}
