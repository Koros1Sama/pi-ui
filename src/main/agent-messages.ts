// src/main/agent-messages.ts
//
// Convert pi AgentMessage[] (from session files or the RPC get_messages
// command) into the flat UI Message[] shape. Shared by SessionStore (file
// replay) and SessionService (live fork reload) so both stay identical.
import { randomUUID } from 'crypto'
import type { Message, ToolCall } from '@shared/types'

export function convertAgentMessages(agentMessages: unknown[]): Message[] {
  const result: Message[] = []
  const pendingToolCalls = new Map<string, { msgIdx: number; callIdx: number }>()

  for (const raw of agentMessages) {
    const msg = raw as { role: string; content: unknown; timestamp?: number }

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('')
            : ''
      result.push({
        id: randomUUID(),
        role: 'user',
        content,
        toolCalls: [],
        createdAt: (msg.timestamp as number) ?? Date.now(),
      })
      pendingToolCalls.clear()
    } else if (msg.role === 'assistant') {
      const parts = Array.isArray(msg.content)
        ? (msg.content as Array<{
            type: string
            text?: string
            id?: string
            name?: string
            arguments?: Record<string, unknown>
          }>)
        : []

      const textContent = parts
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')

      const toolCalls: ToolCall[] = parts
        .filter((c) => c.type === 'toolCall' || c.type === 'tool_use')
        .map((c) => ({
          id: c.id ?? randomUUID(),
          toolName: c.name ?? '',
          args: c.arguments ?? {},
          result: null,
          details: null,
          isError: false,
          durationMs: null,
          status: 'done' as const,
        }))

      const msgIdx = result.length
      result.push({
        id: randomUUID(),
        role: 'assistant',
        content: textContent,
        toolCalls,
        createdAt: Date.now(),
      })

      toolCalls.forEach((call, callIdx) => {
        pendingToolCalls.set(call.id, { msgIdx, callIdx })
      })
    } else if (msg.role === 'toolResult') {
      const toolResult = msg as {
        role: 'toolResult'
        toolCallId: string
        content: Array<{ type: string; text?: string }>
        isError: boolean
      }
      const location = pendingToolCalls.get(toolResult.toolCallId)
      if (location) {
        const targetMsg = result[location.msgIdx]
        if (targetMsg) {
          const call = targetMsg.toolCalls[location.callIdx]
          if (call) {
            call.result = toolResult.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text ?? '')
              .join('')
            call.isError = toolResult.isError
          }
        }
      }
    }
  }

  return result
}
