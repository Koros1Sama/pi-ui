// src/main/rpc-process.ts
//
// Wraps a `pi --mode rpc` subprocess:
//   - JSONL framing over stdin/stdout (LF-only records — Node's readline is
//     NOT protocol-compliant because it also splits on U+2028/U+2029)
//   - request/response correlation by `id`
//   - agent-event fan-out (`agent-event`), stderr passthrough (`stderr`)
//   - dialog `extension_ui_request`s are auto-dismissed so extensions never
//     hang waiting for a UI this host cannot show
//   - boot watchdog (`booted`) and graceful disposal
//
// Commands written before the subprocess finishes booting are buffered by pi
// itself and processed once extensions are loaded (~20s with a rich setup),
// so callers may write immediately after start().
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'

const PI_PACKAGE = '@earendil-works/pi-coding-agent'
const CLI_RELATIVE_PATH = 'dist/bundle/cli.js'

/** Extension-UI dialog methods block the extension until the client replies. */
export const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

export interface RpcProcessOptions {
  cwd: string
  /** Extra CLI args (e.g. --provider/--model/--name). `--mode rpc` is added automatically. */
  args?: string[]
  /** How long to wait for the first stdout line before declaring boot failure. */
  bootTimeoutMs?: number
  /** Default per-request timeout. Generous: the first request may wait out extension boot. */
  requestTimeoutMs?: number
}

let cachedCliJs: string | null = null

/** Locate the globally installed pi CLI bundle (override via PI_UI_CLI_PATH). */
export function resolveCliJsPath(): string {
  if (cachedCliJs) return cachedCliJs

  const override = process.env['PI_UI_CLI_PATH']
  if (override && existsSync(override)) {
    cachedCliJs = override
    return override
  }

  const candidates: string[] = []
  try {
    // Single STRING command with shell — passing an args ARRAY with
    // shell:true triggers Node's DEP0190 deprecation (args get concatenated
    // unescaped). Fixed literal, so shell parsing is safe.
    const res = spawnSync('npm root -g', {
      encoding: 'utf8',
      shell: true,
      timeout: 15_000,
    })
    const root = (res.stdout ?? '').trim()
    if (root) candidates.push(join(root, PI_PACKAGE, CLI_RELATIVE_PATH))
  } catch {
    // npm unavailable — fall through to the hardcoded layouts
  }
  if (process.env['APPDATA']) {
    candidates.push(
      join(process.env['APPDATA'], 'npm', 'node_modules', PI_PACKAGE, CLI_RELATIVE_PATH)
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedCliJs = candidate
      return candidate
    }
  }
  throw new Error(
    `pi CLI not found. Install it globally (npm i -g ${PI_PACKAGE}) or point PI_UI_CLI_PATH at the cli.js bundle. Tried: ${candidates.join(', ')}`
  )
}

export interface NodeRuntime {
  command: string
  /** Full environment for the subprocess — inherits everything (auth, proxies…). */
  env: Record<string, string>
}

let cachedRuntime: NodeRuntime | null = null

/**
 * Resolve a node executable able to run the pi CLI bundle.
 * Prefers this process's own binary as plain node (ELECTRON_RUN_AS_NODE) so
 * packaged builds work without a system node installation.
 */
export function resolveNodeRuntime(): NodeRuntime {
  if (cachedRuntime) return cachedRuntime
  // Prefer the SYSTEM node when available: npm-global native modules
  // (better-sqlite3, sharp, …) are compiled against the system Node ABI.
  // Electron's bundled node (ELECTRON_RUN_AS_NODE) has a DIFFERENT ABI —
  // running pi under it breaks every native module the user's extensions
  // load ("compiled against NODE_MODULE_VERSION X… requires Y").
  try {
    const probe = spawnSync('node', ['--eval', 'process.exit(0)'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    if (probe.status === 0) {
      cachedRuntime = { command: 'node', env: { ...process.env } as Record<string, string> }
      return cachedRuntime
    }
  } catch {
    // no system node — fall through to Electron's node
  }
  const asNodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>
  try {
    const probe = spawnSync(process.execPath, ['--eval', 'process.exit(0)'], {
      env: asNodeEnv,
      timeout: 10_000,
    })
    if (probe.status === 0) {
      cachedRuntime = { command: process.execPath, env: asNodeEnv }
      return cachedRuntime
    }
  } catch {
    // fall through to the plain 'node' guess
  }
  cachedRuntime = { command: 'node', env: { ...process.env } as Record<string, string> }
  return cachedRuntime
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One `pi --mode rpc` subprocess. Emits:
 *   - 'agent-event' (parsed non-response JSON line)
 *   - 'ui-request'  (parsed extension_ui_request — only dialog methods, and only
 *                    when a listener is attached; otherwise auto-cancelled)
 *   - 'exit'        (Error, only when the process died on its own)
 *   - 'error'       (Error, spawn failure)
 *   - 'stderr'      (string, raw stderr chunk — diagnostics only)
 */
export class RpcProcess extends EventEmitter {
  private proc: ChildProcess | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private _exited = false
  private _disposed = false
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  private bootResolve!: () => void
  private bootReject!: (err: Error) => void

  /** Resolves on the first stdout line; rejects on boot timeout / early exit. */
  readonly booted: Promise<void>

  constructor(private readonly opts: RpcProcessOptions) {
    super()
    this.booted = new Promise<void>((resolve, reject) => {
      this.bootResolve = resolve
      this.bootReject = reject
    })
  }

  get exited(): boolean {
    return this._exited
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  start(): void {
    if (this.proc) return
    const cliJs = resolveCliJsPath() // throws synchronously if the CLI is missing
    const runtime = resolveNodeRuntime()
    const args = [cliJs, '--mode', 'rpc', ...(this.opts.args ?? [])]
    const proc = spawn(runtime.command, args, {
      cwd: this.opts.cwd,
      env: runtime.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc = proc

    const bootTimeout = this.opts.bootTimeoutMs ?? 90_000
    this.bootTimer = setTimeout(() => {
      if (!this._exited && !this._disposed) {
        this.bootReject(new Error(`pi RPC process failed to boot within ${bootTimeout}ms`))
        void this.dispose()
      }
    }, bootTimeout)

    proc.stdin?.on('error', () => {
      // EPIPE after process death — surfaced via 'exit'; nothing to do here
    })
    proc.stdout?.on('data', (chunk: Buffer) => this.feed(chunk))
    proc.stdout?.on('end', () => this.flush())
    proc.stderr?.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')))
    proc.on('error', (err) => this.emit('error', err))
    proc.on('exit', (code, signal) => this.handleExit(code, signal))
  }

  /**
   * Send a command and await its correlated response.
   * `data` from a successful response resolves the promise; a failed
   * response rejects with its `error` string.
   */
  async request<T = unknown>(
    cmd: Record<string, unknown>,
    timeoutMs: number | undefined = this.opts.requestTimeoutMs ?? 180_000
  ): Promise<T> {
    const id = randomUUID()
    const payload = { ...cmd, id }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC "${String(cmd['type'] ?? '?')}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      })
      try {
        this.writeJson(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Write an extension_ui_response line (dialog answers from the host UI). */
  writeUiResponse(payload: Record<string, unknown>): void {
    this.writeJson(payload)
  }

  async dispose(): Promise<void> {
    this._disposed = true
    const proc = this.proc
    if (!proc || this._exited) return
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL')
      }, 3_000)
      proc.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      proc.kill()
    })
  }

  private writeJson(obj: unknown): void {
    const stdin = this.proc?.stdin
    if (!stdin || this._exited || this._disposed) {
      throw new Error('pi RPC process is not running')
    }
    stdin.write(JSON.stringify(obj) + '\n')
  }

  private feed(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) break
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      this.handleLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
  }

  private flush(): void {
    this.buffer += this.decoder.end()
    if (this.buffer.length > 0) {
      this.handleLine(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer)
      this.buffer = ''
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    if (this.bootTimer) {
      clearTimeout(this.bootTimer)
      this.bootTimer = null
      this.bootResolve()
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.warn('[rpc-process] unparseable stdout line:', line.slice(0, 200))
      return
    }

    if (parsed['type'] === 'response') {
      this.handleResponse(parsed)
    } else if (parsed['type'] === 'extension_ui_request') {
      this.handleExtensionUiRequest(parsed)
    } else {
      this.emit('agent-event', parsed)
    }
  }

  private handleResponse(parsed: Record<string, unknown>): void {
    const id = parsed['id']
    if (typeof id !== 'string') return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (parsed['success'] === true) {
      pending.resolve(parsed['data'])
    } else {
      pending.reject(
        new Error(String(parsed['error'] ?? `RPC "${String(parsed['command'])}" failed`))
      )
    }
  }

  private handleExtensionUiRequest(parsed: Record<string, unknown>): void {
    const method = String(parsed['method'] ?? '')
    const id = parsed['id']
    // Dialog methods block the extension until answered — forward to the host
    // UI when attached, else dismiss so the agent keeps running (extension
    // receives undefined/false). Fire-and-forget methods (notify/setStatus/…)
    // don't need a response but are still forwarded so notifications reach
    // the UI (pi:notify) instead of vanishing.
    if (typeof id !== 'string') return
    if (DIALOG_UI_METHODS.has(method)) {
      if (this.listenerCount('ui-request') > 0) {
        this.emit('ui-request', parsed)
        return
      }
      try {
        this.writeJson({ type: 'extension_ui_response', id, cancelled: true })
      } catch {
        // process already gone
      }
    } else if (this.listenerCount('ui-request') > 0) {
      this.emit('ui-request', parsed)
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    this._exited = true
    if (this.bootTimer) {
      clearTimeout(this.bootTimer)
      this.bootTimer = null
    }
    const err = new Error(`pi RPC process exited (code=${code} signal=${signal})`)
    this.bootReject(err)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
    if (!this._disposed) this.emit('exit', err)
  }
}
