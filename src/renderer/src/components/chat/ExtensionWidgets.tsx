// src/renderer/src/components/chat/ExtensionWidgets.tsx
import { useStore } from '@/store'
import { useActiveTab } from '@/hooks/useActiveTab'

/**
 * Extension-provided info for the active session — mirrors the TUI's
 * ctx.ui.setWidget / setStatus surfaces: widget panels (contacts, model
 * info, …) render above the input; status entries render as compact chips.
 */
export default function ExtensionWidgets() {
  const tab = useActiveTab()
  const sessionId = tab?.id ?? ''
  const widgets = useStore((s) => s.ui.extensionWidgets.widgets[sessionId])
  const statuses = useStore((s) => s.ui.extensionWidgets.statuses[sessionId])

  if (tab?.mode !== 'active') return null

  const widgetEntries = Object.entries(widgets ?? {})
  const statusEntries = Object.entries(statuses ?? {})
  if (widgetEntries.length === 0 && statusEntries.length === 0) return null

  return (
    <div className="border-t border-[var(--pi-border-subtle)] px-3 py-1.5 text-[11px] leading-relaxed">
      {widgetEntries.map(([key, lines]) => (
        <div
          key={key}
          data-testid={`extension-widget-${key}`}
          className="mb-1 whitespace-pre-wrap rounded bg-zinc-900/60 px-2 py-1 font-mono text-zinc-400"
        >
          {lines.join('\n')}
        </div>
      ))}
      {statusEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-zinc-600">
          {statusEntries.map(([key, text]) => (
            <span
              key={key}
              data-testid={`extension-status-${key}`}
              className="rounded bg-zinc-900 px-1.5 py-0.5"
            >
              {text}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
