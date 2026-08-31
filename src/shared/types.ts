// src/shared/types.ts

/** pi SDK ThinkingLevel values exposed in the UI */
export type AppThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelEntry {
  provider: string
  modelId: string
  displayName: string
  supportsThinking: boolean
}

export interface ProviderStatus {
  name: string
  /** 'oauth' providers use token-based auth; 'apikey' providers use a stored key */
  authType: 'oauth' | 'apikey'
  configured: boolean
}

export interface AppConfig {
  providers: ProviderStatus[]
  defaultModel: string | null
  defaultProvider: string | null
  defaultThinkingLevel: AppThinkingLevel
  systemPrompt: string
  homedir: string
  defaultWorkingDirectory: string | null
  /** "provider/modelId" entries; Ctrl+P cycles these when non-empty */
  favoriteModels: string[]
}

export interface AppDefaults {
  defaultModel: string | null
  defaultProvider: string | null
  defaultThinkingLevel: AppThinkingLevel
  systemPrompt: string
  defaultWorkingDirectory: string | null
  favoriteModels: string[]
}

export interface Preferences {
  lastUsedDirectory: string | null
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls: ToolCall[]
  createdAt: number
}

export interface ToolResultDetails {
  truncation?: {
    truncated: boolean
    truncatedBy?: 'lines' | 'bytes'
    totalLines?: number
    outputLines?: number
    outputBytes?: number
    maxBytes?: number
    lastLinePartial?: boolean
  }
  fullOutputPath?: string
  exitCode?: number | null
}

export interface DiffComment {
  id: string
  lineIndex: number
  lineContent: string
  lineType: 'added' | 'removed' | 'context'
  content: string
}

export interface TabDiff {
  path: string
  unifiedDiff: string
}

export interface SlashCommand {
  name: string
  description: string
  source: 'builtin' | 'skill' | 'prompt' | 'extension'
  insertText: string
  /** Known argument choices offered as completions (e.g. workflow ids) */
  argChoices?: string[]
  /** Short hint about the argument (e.g. "workflow id") */
  argHint?: string
}

export interface ToolCall {
  id: string
  toolName: string
  args: Record<string, unknown>
  result: string | null
  details: ToolResultDetails | null
  isError: boolean
  durationMs: number | null
  status: 'pending' | 'done'
}

/** Events emitted from main process → renderer */
export interface PiEventPayloads {
  'pi:token': { sessionId: string; delta: string }
  'pi:tool-start': {
    sessionId: string
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }
  'pi:tool-end': {
    sessionId: string
    toolCallId: string
    toolName: string
    result: string
    details: ToolResultDetails | null
    isError: boolean
    durationMs: number
  }
  'pi:turn-end': { sessionId: string }
  'pi:idle': { sessionId: string }
  'pi:error': { sessionId: string; message: string }
  /** Emitted when a session's RPC subprocess is spawned and still booting. */
  'pi:booting': { sessionId: string }
  /** Emitted once a spawned/resumed RPC session reports its state (sidebar refresh). */
  'pi:session-ready': { sessionId: string; sdkSessionId: string | null }
  /** A blocking extension dialog forwarded from the pi subprocess, awaiting an answer. */
  'pi:ui-request': {
    sessionId: string
    requestId: string
    method: 'select' | 'confirm' | 'input' | 'editor'
    title?: string
    message?: string
    placeholder?: string
    prefill?: string
    options?: string[]
  }
  /** Fire-and-forget extension notification, surfaced as a toast. */
  'pi:notify': { sessionId: string; message: string; level: string }
  /** Extension widget lines (contacts/model info etc.), null clears. */
  'pi:widget': {
    sessionId: string
    widgetKey: string
    lines: string[] | null
    placement: string
  }
  /** Extension footer status entry, null clears. */
  'pi:status': { sessionId: string; statusKey: string; text: string | null }
  /** Interactive session-tree picker (fork points from /tree). */
  'pi:tree-picker': { sessionId: string; nodes: TreePickerNode[] }
  'update:checking': Record<string, never>
  'update:available': { version: string }
  'update:not-available': { version: string }
  'update:progress': { percent: number; bytesPerSecond: number; transferred: number; total: number }
  'update:ready': { version: string }
  'update:error': { message: string }
}

export interface SessionSummary {
  id: string
  path: string // full path to JSONL file
  cwd: string // full working directory path
  cwdSlug: string // basename of the cwd session dir slug
  lastActiveAt: number // modified date of JSONL file in ms
  model: string | null // from SessionInfo
  pinned: boolean // from .meta.json
  tags: string[] // from .meta.json
  name: string | null // from SDK SessionInfo.name; null = display timestamp
  isActive: boolean // true if id matches the current live session
  /** pi-ui session id of the live tab currently running this session (if any) */
  liveSessionId?: string | null
}

export interface SessionMeta {
  [sessionId: string]: {
    tags: string[]
    pinned: boolean
  }
}

/** One entry of the session tree shown by the /tree picker. */
export interface TreePickerNode {
  id: string
  role: string
  text: string
  label?: string
  depth: number
  /** user messages are fork points */
  clickable: boolean
}

export type PiEventName = keyof PiEventPayloads

/** The window.pi API exposed by the preload script */
export interface PiAPI {
  session: {
    create(opts: {
      cwd: string
      model: string
      provider: string
      thinkingLevel: AppThinkingLevel
      name?: string
    }): Promise<{ sessionId: string }>
    send(sessionId: string, message: string): Promise<void>
    steer(sessionId: string, message: string): Promise<void>
    listCommands(sessionId: string): Promise<SlashCommand[]>
    setModel(sessionId: string, provider: string, modelId: string): Promise<void>
    uiRespond(
      sessionId: string,
      requestId: string,
      response: { value?: string; confirmed?: boolean; cancelled?: boolean }
    ): Promise<void>
    fork(sessionId: string, entryId: string): Promise<{ messages: Message[] }>
    cycleModel(
      sessionId: string,
      backward?: boolean
    ): Promise<{ provider: string; modelId: string; displayName: string }>
    cycleThinking(sessionId: string): Promise<{ level: AppThinkingLevel; levels: string[] }>
    setThinking(sessionId: string, level: AppThinkingLevel): Promise<void>
    abort(sessionId: string): Promise<void>
    close(sessionId: string): Promise<void>
  }
  config: {
    get(): Promise<AppConfig>
    setApiKey(provider: string, key: string): Promise<void>
    setDefaults(opts: Partial<AppDefaults>): Promise<void>
  }
  models: {
    list(): Promise<ModelEntry[]>
  }
  dialog: {
    openDirectory(): Promise<string | null>
    pickFile(): Promise<{ path: string; name: string; content: string } | null>
  }
  shell: {
    openPath(path: string): Promise<void>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    updateMeta(
      sessionId: string,
      patch: Partial<{ tags: string[]; pinned: boolean }>
    ): Promise<void>
    delete(sessionId: string): Promise<void>
    load(sessionPath: string): Promise<Message[]>
    resume(sessionPath: string): Promise<{ sessionId: string }>
    setName(sdkSessionId: string, name: string): Promise<void>
  }
  on<E extends PiEventName>(event: E, handler: (payload: PiEventPayloads[E]) => void): () => void
  update: {
    check(): Promise<void>
    install(): Promise<void>
  }
}
