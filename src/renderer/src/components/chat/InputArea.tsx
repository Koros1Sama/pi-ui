// src/renderer/src/components/chat/InputArea.tsx
import { useState, useRef, useEffect, type KeyboardEvent, type DragEvent } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { useStore } from '@/store'
import { Button } from '@/components/ui/button'
import FileChips, { type AttachedFile } from './FileChips'
import SlashCommandMenu from './SlashCommandMenu'
import type { SlashCommand } from '@shared/types'

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  html: 'html',
  sql: 'sql',
  xml: 'xml',
  txt: 'text',
}

function isBinary(content: string): boolean {
  for (let i = 0; i < Math.min(content.length, 8192); i++) {
    if (content.charCodeAt(i) === 0) return true
  }
  return false
}

function buildMessage(text: string, files: AttachedFile[]): string {
  const validFiles = files.filter((f) => !f.error)
  if (validFiles.length === 0) return text
  const fileParts = validFiles
    .map((f) => {
      const ext = f.name.split('.').pop() ?? ''
      const lang = EXT_LANG[ext] ?? ext
      // 4-backtick fence: immune to files containing ``` at line start
      return `**Attached: \`${f.name}\`**\n\`\`\`\`${lang}\n${f.content}\n\`\`\`\``
    })
    .join('\n\n')
  return text ? `${fileParts}\n\n${text}` : fileParts
}

export default function InputArea({ tabId }: { tabId: string }) {
  // Bound to its own tab (keep-mounted panes), NOT the active tab.
  const tab = useStore((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const addUserMessage = useStore((s) => s.addUserMessage)
  const setTabStatus = useStore((s) => s.setTabStatus)
  const patchTab = useStore((s) => s.patchTab)
  const homedir = useStore((s) => s.config.homedir)
  const [value, setValue] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)

  // Slash command state
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashToken, setSlashToken] = useState('')
  const [slashArgs, setSlashArgs] = useState('')
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([])
  const commandCacheRef = useRef<{ tabId: string; commands: SlashCommand[] } | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow (chat-app style): the field expands with its content between a
  // comfortable minimum and a hard maximum instead of staying one cramped row.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 160)}px`
  }, [value])

  if (!tab || tab.mode !== 'active') return null

  const thinking = tab.status === 'thinking' || tab.status === 'booting'
  const validFiles = attachedFiles.filter((f) => !f.error)
  const hasContent = value.trim().length > 0 || validFiles.length > 0
  const canSend = hasContent

  function filterCommands(query: string, allCommands: SlashCommand[]): SlashCommand[] {
    // Match on the command token only — anything after the first space is
    // an argument, so the menu stays visible while arguments are typed.
    const q = query.toLowerCase()
    return allCommands.filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    )
  }

  async function openSlashMenu(token: string, args: string) {
    if (!tab) return
    const tabId = tab.id
    const sessionId = tab.sessionId
    if (!commandCacheRef.current || commandCacheRef.current.tabId !== tabId) {
      const cmds = await window.pi.session.listCommands(sessionId)
      commandCacheRef.current = { tabId, commands: cmds }
    }
    const filtered = filterCommands(token, commandCacheRef.current.commands)
    setFilteredCommands(filtered)
    setSlashToken(token)
    setSlashArgs(args)
    setSlashActiveIndex(0)
    setSlashMenuOpen(true)
  }

  function closeSlashMenu() {
    setSlashMenuOpen(false)
    setSlashActiveIndex(0)
  }

  function handleSlashSelect(cmd: SlashCommand) {
    setValue(cmd.insertText)
    closeSlashMenu()
    textareaRef.current?.focus()
  }

  function addFile(name: string, path: string, content: string) {
    if (isBinary(content)) {
      setAttachedFiles((prev) => [
        ...prev,
        { id: crypto.randomUUID(), name, path, content: '', error: 'Binary file' },
      ])
      return
    }
    if (content.length > 512 * 1024) {
      setAttachedFiles((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          name,
          path,
          content: '',
          error: 'File too large (max 500KB)',
        },
      ])
      return
    }
    setAttachedFiles((prev) => [...prev, { id: crypto.randomUUID(), name, path, content }])
  }

  async function send() {
    if (!tab || !canSend) return
    const msg = buildMessage(value.trim(), validFiles)
    setValue('')
    setAttachedFiles([])
    closeSlashMenu()
    await sendDirect(msg)
  }

  async function sendDirect(msg: string) {
    if (!tab) return
    if (tab.status === 'thinking') {
      // Steering: delivered between tool calls AFTER the current turn. Echoed
      // immediately but flagged pending — the badge clears when the session
      // confirms the message entered the transcript.
      addUserMessage(tab.id, msg, true)
      try {
        await window.pi.session.steer(tab.sessionId, msg)
      } catch (err) {
        console.error('[steer]', err)
      }
    } else {
      // idle / booting / error — prompt (pi buffers until the process is ready)
      addUserMessage(tab.id, msg)
      setTabStatus(tab.id, 'thinking')
      try {
        await window.pi.session.send(tab.sessionId, msg)
      } catch (err) {
        console.error('[send]', err)
        setTabStatus(tab.id, 'error')
      }
    }
  }

  /** Argument choices for the command currently being typed (e.g. /workflow …). */
  const activeCommand =
    slashMenuOpen && slashArgs
      ? commandCacheRef.current?.commands.find((c) => c.name === slashToken)
      : undefined

  function handleSelectArg(cmd: SlashCommand, choice: string) {
    setValue('')
    closeSlashMenu()
    void sendDirect(`/${cmd.name} ${choice}`)
  }

  function handleChange(newValue: string) {
    setValue(newValue)
    if (newValue.startsWith('/')) {
      const rest = newValue.slice(1)
      const spaceIndex = rest.indexOf(' ')
      const token = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
      const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1)
      void openSlashMenu(token, args)
    } else {
      closeSlashMenu()
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Shift+Tab cycles the thinking level (pi TUI behavior)
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      void handleCycleThinking()
      return
    }
    if (slashMenuOpen) {
      if (e.key === 'Tab' && !e.shiftKey && slashArgs && activeCommand?.argChoices?.length) {
        // Complete the first matching argument choice (e.g. workflow ids)
        e.preventDefault()
        const match = activeCommand.argChoices.find((c) =>
          c.toLowerCase().startsWith(slashArgs.toLowerCase())
        )
        if (match) {
          setValue(`/${activeCommand.name} ${match}`)
          void openSlashMenu(activeCommand.name, match)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActiveIndex((i) => Math.min(i + 1, filteredCommands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActiveIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (slashArgs) {
          // Arguments typed after the command — send the text as-is
          // (e.g. "/name my title", "/workflow tdd").
          void send()
        } else if (filteredCommands[slashActiveIndex]) {
          handleSlashSelect(filteredCommands[slashActiveIndex])
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSlashMenu()
        return
      }
    }
    // Escape aborts a running agent (pi TUI behavior)
    if (e.key === 'Escape' && thinking) {
      e.preventDefault()
      void handleAbort()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  async function handleCycleThinking() {
    if (!tab) return
    try {
      const res = await window.pi.session.cycleThinking(tab.sessionId)
      patchTab(tab.id, { thinkingLevel: res.level, thinkingLevels: res.levels })
      useStore.getState().setToast({ message: `🧠 thinking: ${res.level}`, level: 'info' })
      // Persist as the default so new sessions start at the chosen effort.
      await window.pi.config.setDefaults({ defaultThinkingLevel: res.level })
    } catch (err) {
      console.error('[cycleThinking]', err)
    }
  }

  async function handleAbort() {
    if (!tab?.sessionId) return
    try {
      await window.pi.session.abort(tab.sessionId)
    } catch (err) {
      console.error('[abort]', err)
    }
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      try {
        const content = await file.text()
        addFile(file.name, file.name, content)
      } catch {
        setAttachedFiles((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            name: file.name,
            path: file.name,
            content: '',
            error: 'Could not read file',
          },
        ])
      }
    }
    textareaRef.current?.focus()
  }

  async function handlePaperclip() {
    try {
      const result = await window.pi.dialog.pickFile()
      if (!result) {
        setTimeout(() => textareaRef.current?.focus(), 50)
        return
      }
      addFile(result.name, result.path, result.content)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not read file'
      setAttachedFiles((prev) => [
        ...prev,
        { id: crypto.randomUUID(), name: 'file', path: '', content: '', error: msg },
      ])
    }
    // Defer focus: give Electron time to return OS focus after sheet dismisses
    setTimeout(() => textareaRef.current?.focus(), 50)
  }

  return (
    <div
      className={`border-t border-[var(--pi-border-subtle)] bg-[var(--pi-sidebar-bg)] transition-colors ${
        isDragging ? 'ring-1 ring-inset ring-[var(--pi-accent)]' : ''
      }`}
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <FileChips
        files={attachedFiles}
        onRemove={(id) => setAttachedFiles((f) => f.filter((x) => x.id !== id))}
      />

      <div className="px-3 py-3">
        <div className="relative rounded-lg border border-zinc-800 bg-zinc-900 focus-within:border-zinc-700">
          {slashMenuOpen && (
            <SlashCommandMenu
              commands={filteredCommands}
              activeIndex={slashActiveIndex}
              onSelect={handleSlashSelect}
              onDismiss={closeSlashMenu}
              args={slashArgs || undefined}
              activeCommand={activeCommand}
              onSelectArg={handleSelectArg}
            />
          )}
          <textarea
            ref={textareaRef}
            dir="auto"
            data-testid="chat-input"
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              thinking
                ? 'Steer the agent… (Enter to send)'
                : tab.status === 'error'
                  ? 'Something went wrong — try again'
                  : isDragging
                    ? 'Drop file to attach…'
                    : 'Send a message… (Enter to send, Shift+Enter for newline)'
            }
            className="w-full resize-none bg-transparent px-[72px] py-2.5 text-zinc-300 placeholder-zinc-600 outline-none"
            style={{ minHeight: 44, maxHeight: 160 }}
          />
          <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {!thinking && (
              <button
                data-testid="attach-btn"
                onClick={handlePaperclip}
                title="Attach file"
                className="flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:text-zinc-400"
              >
                📎
              </button>
            )}
            {!thinking && (
              <Button
                data-testid="send-btn"
                aria-label="Send"
                size="sm"
                onClick={send}
                disabled={!canSend}
                className="h-7 w-7 justify-center border border-zinc-700 bg-zinc-800 p-0 text-zinc-400 hover:text-zinc-200"
              >
                <ArrowUp size={14} />
              </Button>
            )}
            {thinking && (
              <Button
                data-testid="stop-btn"
                aria-label="Stop"
                size="sm"
                variant="ghost"
                onClick={handleAbort}
                className="h-7 w-7 justify-center border border-zinc-700 bg-zinc-800 p-0 text-zinc-500 hover:text-zinc-300"
              >
                <Square size={10} />
              </Button>
            )}
          </div>
        </div>
        <div
          className="mt-1.5 flex items-center gap-2 px-1 font-mono"
          style={{ color: 'var(--pi-dim)' }}
        >
          {/* Status */}
          <span
            data-testid="status-dot"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              tab.status === 'thinking' || tab.status === 'booting' ? 'animate-pulse' : ''
            }`}
            style={{
              backgroundColor:
                tab.status === 'thinking' || tab.status === 'booting'
                  ? 'var(--pi-warning)'
                  : tab.status === 'error'
                    ? 'var(--pi-error)'
                    : 'var(--pi-success)',
            }}
          />
          <span
            data-testid="status-text"
            style={{
              color:
                tab.status === 'thinking' || tab.status === 'booting'
                  ? 'var(--pi-warning)'
                  : tab.status === 'error'
                    ? 'var(--pi-error)'
                    : 'var(--pi-dim)',
            }}
          >
            {tab.status === 'booting' ? 'starting pi…' : tab.status}
          </span>

          {/* Steering label */}
          {thinking && (
            <span data-testid="steering-label" style={{ color: 'var(--pi-dim)' }}>
              ⟳ steering
            </span>
          )}

          {/* Model + thinking level */}
          {tab.model && (
            <>
              <span style={{ color: 'var(--pi-dim-dark)' }}>·</span>
              <span style={{ color: 'var(--pi-accent)' }}>{tab.model}</span>
              {tab.thinkingLevel && tab.thinkingLevel !== 'off' && (
                <span style={{ color: 'var(--pi-dim)' }}>• {tab.thinkingLevel}</span>
              )}
            </>
          )}

          {/* CWD */}
          {tab.cwd && (
            <>
              <span style={{ color: 'var(--pi-dim-dark)' }}>·</span>
              <button
                dir="ltr"
                onClick={() => window.pi.shell.openPath(tab.cwd!)}
                className="truncate hover:underline"
                style={{ color: 'var(--pi-dim)', maxWidth: '200px' }}
              >
                {homedir ? tab.cwd.replace(homedir, '~') : tab.cwd}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
