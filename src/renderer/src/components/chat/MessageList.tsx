// src/renderer/src/components/chat/MessageList.tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { memo } from 'react'
import { Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import ToolCallEntry from './ToolCallEntry'
import type { Message } from '@shared/types'

interface Props {
  /** Bind this list to a specific tab (keep-mounted panes). Optional for
   *  readonly rendering driven purely by `readonlyMessages`. */
  tabId?: string
  readonlyMessages?: Message[]
}

function PiMarkdown({ children }: { children: string }) {
  return (
    <div className="pi-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

// memo'd: immer keeps untouched message objects referentially stable, so
// past messages skip re-rendering (and markdown re-parsing) on every token.
const UserMessage = memo(function UserMessage({ msg, tabId }: { msg: Message; tabId?: string }) {
  const removeUserMessage = useStore((s) => s.removeUserMessage)
  const setToast = useStore((s) => s.setToast)
  return (
    <div
      data-testid="user-message"
      dir="auto"
      className={cn('mx-3 my-1 rounded px-3 py-2', msg.pending && 'opacity-60')}
      style={{ backgroundColor: 'var(--pi-user-msg-bg)' }}
    >
      <PiMarkdown>{msg.content}</PiMarkdown>
      {msg.pending && (
        <div
          data-testid="queued-badge"
          className="mt-1 flex items-center gap-1 text-[10px]"
          style={{ color: 'var(--pi-dim)' }}
        >
          <Loader2 size={10} className="animate-pulse" />
          <span>queued — enters the chat after the current tool calls</span>
          <button
            data-testid="queued-cancel-btn"
            aria-label="Cancel queued message"
            title="Cancel queued message"
            onClick={() => {
              if (!tabId) return
              removeUserMessage(tabId, msg.id)
              setToast({
                message: 'Removed from view — pi may still deliver it if already queued',
                level: 'info',
              })
            }}
            className="ms-1 rounded p-0.5 text-zinc-600 hover:text-red-400"
          >
            <X size={10} />
          </button>
        </div>
      )}
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({
  content,
  streaming,
}: {
  content: string
  streaming?: boolean
}) {
  return (
    <div data-testid="assistant-message" dir="auto" className="mx-3 py-1.5">
      <PiMarkdown>{content}</PiMarkdown>
      {streaming && (
        <span
          className="ms-0.5 inline-block h-3 w-0.5 animate-pulse align-middle"
          style={{ backgroundColor: 'var(--pi-accent)' }}
        />
      )}
    </div>
  )
})

export default function MessageList({ tabId, readonlyMessages }: Props = {}) {
  const tab = useStore((s) => (tabId ? s.tabs.tabs.find((t) => t.id === tabId) : undefined))
  const isActivePane = useStore((s) => s.tabs.activeTabId === tabId)
  const messages = readonlyMessages ?? tab?.messages ?? []
  const streamingContent = readonlyMessages ? '' : (tab?.currentStreamingContent ?? '')
  const isThinking = !readonlyMessages && tab?.status === 'thinking' && !streamingContent
  const isBooting = !readonlyMessages && tab?.status === 'booting'
  // Include pane activation in the trigger: a pane revealed from display:none
  // has no layout while hidden, so it re-scrolls to the bottom on reveal.
  const scrollRef = useAutoScroll<HTMLDivElement>(
    messages.length + streamingContent.length + (isActivePane ? 1 : 0)
  )

  return (
    <div ref={scrollRef} data-testid="message-list" className="flex-1 overflow-y-auto py-1">
      {messages.map((msg) => (
        <div key={msg.id} className="mb-1">
          {msg.role === 'user' ? (
            <UserMessage msg={msg} tabId={tabId} />
          ) : (
            <AssistantMessage content={msg.content} />
          )}
          {msg.toolCalls.length > 0 && (
            <div className="mt-0.5 space-y-px">
              {msg.toolCalls.map((call) => (
                <ToolCallEntry key={call.id} call={call} />
              ))}
            </div>
          )}
        </div>
      ))}

      {streamingContent && <AssistantMessage content={streamingContent} streaming />}

      {(isThinking || isBooting) && (
        <div className="mx-3 flex items-center gap-1 py-3">
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.3s]"
            style={{ backgroundColor: 'var(--pi-accent)' }}
          />
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.15s]"
            style={{ backgroundColor: 'var(--pi-accent)' }}
          />
          <span
            className="h-1.5 w-1.5 animate-bounce rounded-full"
            style={{ backgroundColor: 'var(--pi-accent)' }}
          />
          {isBooting && (
            <span className="ms-2 text-[11px]" style={{ color: 'var(--pi-dim)' }}>
              Starting pi… first prompt can take ~30–60s
            </span>
          )}
        </div>
      )}
    </div>
  )
}
