// src/renderer/src/components/modals/TreePickerDialog.tsx
import { useState } from 'react'
import { useStore } from '@/store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/**
 * Interactive session tree opened by /tree: user-message rows are fork
 * points — clicking one forks the session there and reloads the chat.
 */
export default function TreePickerDialog() {
  const picker = useStore((s) => s.ui.treePicker)
  const setTreePicker = useStore((s) => s.setTreePicker)
  const tabs = useStore((s) => s.tabs.tabs)
  const replaceTab = useStore((s) => s.replaceTab)
  const setSessions = useStore((s) => s.setSessions)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!picker) return null

  const { sessionId } = picker

  async function handleFork(entryId: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const { messages } = await window.pi.session.fork(sessionId, entryId)
      const tab = tabs.find((t) => t.id === sessionId)
      if (tab) {
        replaceTab(tab.id, { ...tab, messages, currentStreamingContent: '', status: 'idle' })
      }
      setTreePicker(null)
      const updated = await window.pi.sessions.list()
      setSessions(updated)
    } catch (err) {
      console.error('[tree:fork]', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) setTreePicker(null)
      }}
    >
      <DialogContent className="max-h-[70vh] max-w-lg overflow-y-auto border-zinc-800 bg-zinc-900">
        <DialogHeader>
          <DialogTitle className="text-sm text-zinc-200">
            Session tree — click a message to fork from it
          </DialogTitle>
        </DialogHeader>
        <div data-testid="tree-picker" className="space-y-0.5">
          {picker.nodes.map((node) => (
            <div key={node.id} style={{ paddingLeft: node.depth * 14 }}>
              {node.clickable ? (
                <button
                  disabled={busy}
                  onClick={() => void handleFork(node.id)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-xs text-zinc-200 transition-colors hover:bg-zinc-800"
                  title={node.text}
                >
                  <span className="mr-1 text-[10px] text-amber-500/80">⑂</span>
                  {node.text || '(empty message)'}
                </button>
              ) : (
                <div className="truncate px-2 py-0.5 text-[11px] text-zinc-600" title={node.text}>
                  {node.role === 'assistant' ? '↳ ' : ''}
                  {node.text || node.role}
                </div>
              )}
            </div>
          ))}
          {picker.nodes.length === 0 && (
            <p className="px-2 py-2 text-xs text-zinc-600">No entries in this session yet.</p>
          )}
        </div>
        {error && <p className="px-2 text-xs text-red-400">{error}</p>}
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="border border-zinc-800"
            onClick={() => setTreePicker(null)}
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
