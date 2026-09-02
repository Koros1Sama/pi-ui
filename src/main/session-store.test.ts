// src/main/session-store.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionStore, type FsLike } from './session-store'

vi.mock('@mariozechner/pi-coding-agent', () => ({
  SessionManager: {
    open: vi.fn(),
  },
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn(),
}))

import { SessionManager } from '@mariozechner/pi-coding-agent'

const ROOT = '/sessions'

/** Windows path.join produces backslashes — normalize for fixture lookups. */
const norm = (p: unknown): string => String(p).replace(/\\/g, '/')

function dirEnt(name: string) {
  return { name, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }
}
function fileEnt(name: string) {
  return { name, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true }
}

const mockFs = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}

/** Fake filesystem: full paths → { content, mtimeMs }. */
function setupFs(files: Record<string, { content: string; mtimeMs?: number }> = {}): void {
  const dirs = new Set<string>()
  for (const p of Object.keys(files)) {
    const dir = p.slice(0, p.lastIndexOf('/'))
    dirs.add(dir)
  }

  mockFs.existsSync.mockImplementation((p: unknown) => norm(p) in files)
  mockFs.readdirSync.mockImplementation((p: unknown) => {
    const path = norm(p).replace(/\/$/, '')
    if (path === ROOT) return [...dirs].map((d) => dirEnt(d.slice(d.lastIndexOf('/') + 1)))
    return Object.keys(files)
      .filter((f) => f.slice(0, f.lastIndexOf('/')) === path)
      .map((f) => fileEnt(f.slice(f.lastIndexOf('/') + 1)))
  })
  mockFs.statSync.mockImplementation((p: unknown) => {
    const f = files[norm(p)]
    return { size: f ? f.content.length : 0, mtimeMs: f?.mtimeMs ?? 0 }
  })
  mockFs.readFileSync.mockImplementation((p: unknown) => files[norm(p)]?.content ?? '')
}

describe('SessionStore', () => {
  let store: SessionStore

  beforeEach(() => {
    process.env['PI_SESSIONS_DIR'] = ROOT
    store = new SessionStore(mockFs as unknown as FsLike)
    vi.clearAllMocks()
    mockFs.existsSync.mockReturnValue(false)
    mockFs.readFileSync.mockReturnValue('{}')
    mockFs.writeFileSync.mockReset()
    mockFs.mkdirSync.mockReset()
    mockFs.statSync.mockImplementation(() => ({ size: 0, mtimeMs: 0 }))
  })

  afterEach(() => {
    delete process.env['PI_SESSIONS_DIR']
  })

  it('list() returns empty array when no sessions exist', async () => {
    setupFs({})
    const result = await store.list([])
    expect(result).toEqual([])
  })

  it('list() scans the filesystem and maps facts to SessionSummary', async () => {
    setupFs({
      [`${ROOT}/--home-code--/2024-01-01T00-00-00-000Z_abc.jsonl`]: {
        content:
          '{"type":"session","version":3,"id":"abc","cwd":"/home/code"}\n' +
          '{"type":"message","message":{"role":"user","content":"hello"}}\n',
        mtimeMs: new Date('2024-01-02').getTime(),
      },
    })

    const result = await store.list([])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('abc') // from the session header, matches live ids
    expect(result[0].cwd).toBe('/home/code')
    expect(result[0].cwdSlug).toBe('--home-code--')
    expect(result[0].lastActiveAt).toBe(new Date('2024-01-02').getTime())
    expect(result[0].pinned).toBe(false)
    expect(result[0].tags).toEqual([])
    expect(result[0].isActive).toBe(false)
  })

  it('list() falls back to the first user message snippet when name is missing', async () => {
    setupFs({
      [`${ROOT}/--home-code--/s.jsonl`]: {
        content:
          '{"type":"session","id":"abc","cwd":"/home/code"}\n' +
          '{"type":"model_change","id":"m1","modelId":"glm-5.3","provider":"zai"}\n' +
          '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Fix the login bug please"}]}}\n',
      },
    })

    const result = await store.list([])
    expect(result[0].name).toBe('Fix the login bug please')
    expect(result[0].model).toBe('glm-5.3')
  })

  it('list() truncates long snippets to 60 chars', async () => {
    const longText = 'a'.repeat(100)
    setupFs({
      [`${ROOT}/--home-code--/s.jsonl`]: {
        content:
          '{"type":"session","id":"abc","cwd":"/home/code"}\n' +
          `{"type":"message","message":{"role":"user","content":"${longText}"}}\n`,
      },
    })

    const result = await store.list([])
    expect(result[0].name).toBe('a'.repeat(60))
  })

  it('list() keeps an explicit session_info name over the snippet fallback', async () => {
    setupFs({
      [`${ROOT}/--home-code--/s.jsonl`]: {
        content:
          '{"type":"session","id":"abc","cwd":"/home/code"}\n' +
          '{"type":"message","message":{"role":"user","content":"some message"}}\n' +
          '{"type":"session_info","id":"n1","name":"My Named Session"}\n',
      },
    })

    const result = await store.list([])
    expect(result[0].name).toBe('My Named Session')
  })

  it('list() uses the meta cache name for huge files the slices cannot see', async () => {
    setupFs({
      [`${ROOT}/--home-code--/s.jsonl`]: {
        content: '{"type":"session","id":"abc","cwd":"/home/code"}\n',
      },
      [`${ROOT}/--home-code--/.meta.json`]: {
        content: JSON.stringify({ abc: { tags: [], pinned: false, name: 'Cached Name' } }),
      },
    })

    const result = await store.list([])
    expect(result[0].name).toBe('Cached Name')
  })

  it('list() marks isActive when sessionId matches active session', async () => {
    setupFs({
      [`${ROOT}/--home--/2024-01-01T00-00-00-000Z_abc.jsonl`]: {
        content: '{"type":"session","id":"abc","cwd":"/home"}\n',
      },
    })

    const result = await store.list(['abc'])
    expect(result[0].isActive).toBe(true)
  })

  it('list() applies pinned from .meta.json', async () => {
    setupFs({
      [`${ROOT}/--home--/2024-01-01T00-00-00-000Z_abc.jsonl`]: {
        content: '{"type":"session","id":"abc","cwd":"/home"}\n',
      },
      [`${ROOT}/--home--/.meta.json`]: {
        content: JSON.stringify({ abc: { tags: ['important'], pinned: true } }),
      },
    })

    const result = await store.list([])
    expect(result[0].pinned).toBe(true)
    expect(result[0].tags).toEqual(['important'])
  })

  it('list() reads ONLY head/tail slices for huge files (never the middle)', async () => {
    const headContent =
      '{"type":"session","id":"abc","cwd":"/home/code"}\n' +
      '{"type":"message","message":{"role":"user","content":"first message"}}\n'
    const tailContent =
      '{"type":"model_change","id":"m9","modelId":"glm-5.3","provider":"zai"}\n' +
      '{"type":"session_info","id":"n9","name":"Renamed"}\n'
    const bigPath = `${ROOT}/--home-code--/big.jsonl`

    setupFs({})
    // Force the slice path: size > HEAD (64K) + TAIL (256K)
    mockFs.statSync.mockImplementation((p: unknown) =>
      norm(p) === bigPath
        ? { size: 64 * 1024 + 256 * 1024 + 1000, mtimeMs: 42 }
        : { size: 0, mtimeMs: 0 }
    )
    mockFs.readdirSync.mockImplementation((p: unknown) => {
      const path = norm(p).replace(/\/$/, '')
      if (path === ROOT) return [dirEnt('--home-code--')]
      return [fileEnt('big.jsonl')]
    })
    mockFs.openSync.mockReturnValue(7)
    mockFs.readSync.mockImplementation(
      (_fd: number, buf: Buffer, _offset: number, length: number, position: number) => {
        const src = position === 0 ? headContent : tailContent
        const slice = src.slice(0, length)
        buf.write(slice, 0, 'utf8')
        return slice.length
      }
    )

    const result = await store.list([])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('abc')
    expect(result[0].cwd).toBe('/home/code')
    expect(result[0].name).toBe('Renamed')
    expect(result[0].model).toBe('glm-5.3')
    expect(result[0].lastActiveAt).toBe(42)
    // The full-file readFileSync path must never run for the big transcript
    const fullReads = mockFs.readFileSync.mock.calls.filter((c) => norm(c[0]) === bigPath)
    expect(fullReads).toHaveLength(0)
    expect(mockFs.openSync).toHaveBeenCalled()
  })

  it('updateMeta() writes updated meta to .meta.json', async () => {
    const written: string[] = []
    mockFs.writeFileSync.mockImplementation((_p: unknown, data: unknown) => {
      written.push(data as string)
    })

    await store.updateMeta(`${ROOT}/--home--`, 'abc', {
      pinned: true,
      tags: ['foo'],
    })

    expect(written).toHaveLength(1)
    const parsed = JSON.parse(written[0])
    expect(parsed.abc.pinned).toBe(true)
    expect(parsed.abc.tags).toEqual(['foo'])
  })

  it('updateMeta() preserves cached name/model fields', async () => {
    const written: string[] = []
    setupFs({
      [`${ROOT}/--home--/.meta.json`]: {
        content: JSON.stringify({ abc: { tags: ['x'], pinned: false, name: 'Keep Me' } }),
      },
    })
    mockFs.writeFileSync.mockImplementation((_p: unknown, data: unknown) => {
      written.push(data as string)
    })

    await store.updateMeta(`${ROOT}/--home--`, 'abc', { pinned: true })

    const parsed = JSON.parse(written[0])
    expect(parsed.abc.name).toBe('Keep Me')
    expect(parsed.abc.pinned).toBe(true)
  })

  describe('setNameById', () => {
    it('calls appendSessionInfo and caches the name in meta', async () => {
      const mockAppendSessionInfo = vi.fn()
      const sessionPath = `${ROOT}/--home--/2024-01-01T00-00-00-000Z_abc.jsonl`
      setupFs({
        [sessionPath]: { content: '{"type":"session","id":"abc","cwd":"/home"}\n' },
      })

      // Populate jsonlPathById by calling list first
      await store.list([])

      vi.mocked(SessionManager.open).mockReturnValue({
        appendSessionInfo: mockAppendSessionInfo,
      } as never)

      const written: string[] = []
      mockFs.writeFileSync.mockImplementation((_p: unknown, data: unknown) => {
        written.push(data as string)
      })

      await store.setNameById('abc', 'My New Name')
      const openedPath = String(vi.mocked(SessionManager.open).mock.calls[0]?.[0]).replace(
        /\\/g,
        '/'
      )
      expect(openedPath).toBe(sessionPath)
      expect(mockAppendSessionInfo).toHaveBeenCalledWith('My New Name')
      const meta = JSON.parse(written.find((w) => w.includes('My New Name')) ?? '{}')
      expect(meta.abc.name).toBe('My New Name')
    })

    it('throws for unknown session id', async () => {
      await expect(store.setNameById('unknown-id', 'Name')).rejects.toThrow('Unknown session')
    })
  })
})
