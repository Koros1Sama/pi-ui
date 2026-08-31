// src/renderer/src/components/modals/ExtensionUIDialog.tsx
import { useState } from 'react'
import { useStore, type ExtensionDialog } from '@/store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type UiAnswer = { value?: string; confirmed?: boolean; cancelled?: boolean }

/**
 * Renders blocking extension UI requests (select/confirm/input/editor)
 * forwarded from the pi subprocess over RPC, and answers them via
 * window.pi.session.uiRespond. Without an answer the extension would hang,
 * so every dismissal path responds with `cancelled`. Requests are queued
 * (FIFO) — a second request never silently replaces a pending one.
 */
export default function ExtensionUIDialog() {
  const dialog = useStore((s) => s.ui.extensionDialogs[0] ?? null)
  const shiftExtensionDialog = useStore((s) => s.shiftExtensionDialog)
  const queueLength = useStore((s) => s.ui.extensionDialogs.length)

  if (!dialog) return null

  const { sessionId, requestId } = dialog

  async function answer(response: UiAnswer): Promise<void> {
    shiftExtensionDialog()
    try {
      await window.pi.session.uiRespond(sessionId, requestId, response)
    } catch (err) {
      console.error('[extension-ui] respond failed:', err)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void answer({ cancelled: true })
      }}
    >
      <DialogContent className="max-w-md border-zinc-800 bg-zinc-900">
        {/* key=requestId remounts the body per request so text state resets */}
        <DialogBody key={dialog.requestId} dialog={dialog} answer={answer} />
        {queueLength > 1 && (
          <p className="px-1 text-[10px] text-zinc-600">
            +{queueLength - 1} more request(s) queued
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DialogBody({
  dialog,
  answer,
}: {
  dialog: ExtensionDialog
  answer(response: UiAnswer): Promise<void>
}) {
  // Only prefill seeds the value — the placeholder is a hint, not an answer.
  const [text, setText] = useState(dialog.prefill ?? '')

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm text-zinc-200">
          {dialog.title || 'Extension request'}
        </DialogTitle>
      </DialogHeader>

      {dialog.method === 'select' && (
        <div data-testid="extension-ui-select" className="max-h-64 space-y-1 overflow-y-auto">
          {(dialog.options ?? []).map((opt) => (
            <button
              key={opt}
              onClick={() => void answer({ value: opt })}
              className="block w-full rounded px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {opt}
            </button>
          ))}
          {(dialog.options ?? []).length === 0 && (
            <p className="px-3 py-1 text-xs text-zinc-600">No options</p>
          )}
        </div>
      )}

      {dialog.method === 'confirm' && (
        <div data-testid="extension-ui-confirm">
          {dialog.message && <p className="mb-3 text-xs text-zinc-400">{dialog.message}</p>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void answer({ cancelled: true })}
              className="border border-zinc-800"
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => void answer({ confirmed: true })}>
              Confirm
            </Button>
          </div>
        </div>
      )}

      {dialog.method === 'input' && (
        <div data-testid="extension-ui-input">
          <Input
            autoFocus
            value={text}
            placeholder={dialog.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text) void answer({ value: text })
            }}
            className="border-zinc-800 bg-zinc-950 text-xs"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void answer({ cancelled: true })}
              className="border border-zinc-800"
            >
              Cancel
            </Button>
            <Button size="sm" disabled={!text} onClick={() => void answer({ value: text })}>
              OK
            </Button>
          </div>
        </div>
      )}

      {dialog.method === 'editor' && (
        <div data-testid="extension-ui-editor">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            className="w-full rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-300 outline-none focus:border-zinc-700"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void answer({ cancelled: true })}
              className="border border-zinc-800"
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => void answer({ value: text })}>
              Save
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
