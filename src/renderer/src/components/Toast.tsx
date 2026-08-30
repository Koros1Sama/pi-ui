// src/renderer/src/components/Toast.tsx
import { useEffect } from 'react'
import { useStore } from '@/store'

/** Auto-dismissing toast for extension notifications forwarded as pi:notify. */
export default function Toast() {
  const toast = useStore((s) => s.ui.toast)
  const setToast = useStore((s) => s.setToast)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast, setToast])

  if (!toast) return null

  return (
    <div
      data-testid="extension-toast"
      className={`fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 cursor-pointer rounded-lg border px-4 py-2 text-xs shadow-lg ${
        toast.level === 'error'
          ? 'border-red-900 bg-red-950/90 text-red-300'
          : toast.level === 'warning'
            ? 'border-amber-900 bg-amber-950/90 text-amber-300'
            : 'border-zinc-800 bg-zinc-900/95 text-zinc-300'
      }`}
      onClick={() => setToast(null)}
    >
      {toast.message}
    </div>
  )
}
