// @vitest-environment node
// src/main/conversation-search-service.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationSearchService } from './conversation-search-service'

function sessionHeader(cwd: string): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd,
  })
}

function msgLine(role: 'user' | 'assistant', parts: unknown[], ts = 1783000000000): string {
  return JSON.stringify({
    type: 'message',
    id: `m-${role}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date(ts).toISOString(),
    message: { role, content: parts, timestamp: ts },
  })
}

const text = (t: string) => ({ type: 'text', text: t })
const thinking = (t: string) => ({ type: 'thinking', thinking: t, thinkingSignature: 'x' })
const toolCall = (name: string) => ({ type: 'toolCall', id: `c_${name}`, name, arguments: {} })

describe('ConversationSearchService', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'piui-convo-'))
    const projA = join(root, '--proj-a--')
    const projB = join(root, '--proj-b--')
    await mkdir(projA, { recursive: true })
    await mkdir(projB, { recursive: true })

    await writeFile(
      join(projA, '2026-01-01_a.jsonl'),
      [
        sessionHeader('D:\\work\\proj-a'),
        msgLine('user', [text('please fix the api key rotation bug')]),
        msgLine('assistant', [
          thinking('the api key secret phrase should NOT match'),
          text('I rotated the api key for you'),
        ]),
        msgLine('assistant', [toolCall('read'), text('done')]),
        '',
      ].join('\n')
    )

    await writeFile(
      join(projB, '2026-01-02_b.jsonl'),
      [
        sessionHeader('D:\\work\\proj-b'),
        msgLine('user', [text('unrelated chatter here')], 1783000100000),
        msgLine('assistant', [text('the API KEY strategy is fine')], 1783000200000),
        '',
      ].join('\n')
    )

    // Corrupt line + non-message lines must be skipped gracefully
    await writeFile(
      join(projB, '2026-01-03_c.jsonl'),
      [
        sessionHeader('D:\\work\\proj-b'),
        '{ this is not json',
        JSON.stringify({ type: 'model_change', id: 'x', provider: 'zai', modelId: 'glm-5.3' }),
        msgLine('user', [text('api key note to self')]),
        '',
      ].join('\n')
    )
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function makeService(): ConversationSearchService {
    return new ConversationSearchService(root)
  }

  it('returns empty for queries with no include terms', async () => {
    const res = await makeService().search('from:user')
    expect(res.matches).toHaveLength(0)
  })

  it('returns empty for a missing sessions root', async () => {
    const res = await new ConversationSearchService(join(root, 'nope')).search('api')
    expect(res.matches).toHaveLength(0)
  })

  it('finds plain terms in both user and assistant messages', async () => {
    const res = await makeService().search('api key')
    expect(res.matchCount).toBeGreaterThanOrEqual(3)
    const roles = new Set(res.matches.map((m) => m.role))
    expect(roles.has('user')).toBe(true)
    expect(roles.has('assistant')).toBe(true)
  })

  it('captures the session cwd from the header line', async () => {
    const res = await makeService().search('rotation')
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0]!.cwd).toBe('D:\\work\\proj-a')
  })

  it('matches quoted phrases with spaces', async () => {
    const res = await makeService().search('"api key rotation"')
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0]!.role).toBe('user')
  })

  it('excludes lines matching -term', async () => {
    const res = await makeService().search('api -rotation')
    expect(res.matches.some((m) => m.snippet.includes('rotation'))).toBe(false)
    expect(res.matchCount).toBeGreaterThan(0)
  })

  it('from:user restricts matches to user messages', async () => {
    const res = await makeService().search('api from:user')
    expect(res.matchCount).toBeGreaterThan(0)
    expect(res.matches.every((m) => m.role === 'user')).toBe(true)
  })

  it('from:ai restricts matches to assistant messages', async () => {
    const res = await makeService().search('api from:ai')
    expect(res.matchCount).toBeGreaterThan(0)
    expect(res.matches.every((m) => m.role === 'assistant')).toBe(true)
  })

  it('from:me is an alias for from:user', async () => {
    const res = await makeService().search('api from:me')
    expect(res.matches.every((m) => m.role === 'user')).toBe(true)
  })

  it('does not search thinking blocks or tool calls', async () => {
    const res = await makeService().search('secret phrase')
    expect(res.matches).toHaveLength(0)
  })

  it('is case-insensitive by default and honors case:on', async () => {
    // Fixture text is "the API KEY strategy is fine" (uppercase).
    const ci = await makeService().search('api key strategy')
    expect(ci.matches).toHaveLength(1)

    const cs = await makeService().search('api key strategy case:on')
    expect(cs.matches).toHaveLength(0)
  })

  it('supports wildcards', async () => {
    const res = await makeService().search('rot*tion')
    expect(res.matches).toHaveLength(1)
  })

  it('skips corrupt lines and non-message entries without failing', async () => {
    const res = await makeService().search('note to self')
    expect(res.matches).toHaveLength(1)
  })
})
