// @vitest-environment node
// src/main/content-search-service.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseQuery, ContentSearchService } from './content-search-service'

describe('parseQuery', () => {
  it('splits bare words into includes', () => {
    const q = parseQuery('foo bar')
    expect(q.includes.map((t) => t.raw)).toEqual(['foo', 'bar'])
    expect(q.excludes).toHaveLength(0)
  })

  it('keeps quoted phrases intact including spaces', () => {
    const q = parseQuery('"api key" TODO')
    expect(q.includes.map((t) => t.raw)).toEqual(['api key', 'TODO'])
  })

  it('parses exclusions for words and phrases', () => {
    const q = parseQuery('foo -bar -"skip me"')
    expect(q.includes.map((t) => t.raw)).toEqual(['foo'])
    expect(q.excludes.map((t) => t.raw)).toEqual(['bar', 'skip me'])
  })

  it('parses path/ext filters with lists and negation', () => {
    const q = parseQuery('foo path:src,lib -path:test ext:ts,tsx -ext:json')
    expect(q.pathIncludes).toEqual(['src', 'lib'])
    expect(q.pathExcludes).toEqual(['test'])
    expect(q.extIncludes).toEqual(['ts', 'tsx'])
    expect(q.extExcludes).toEqual(['json'])
  })

  it('strips leading dots from extensions', () => {
    const q = parseQuery('ext:.ts')
    expect(q.extIncludes).toEqual(['ts'])
  })

  it('parses case sensitivity flag', () => {
    expect(parseQuery('foo case:on').caseSensitive).toBe(true)
    expect(parseQuery('foo case:off').caseSensitive).toBe(false)
    expect(parseQuery('foo').caseSensitive).toBe(false)
  })

  it('marks wildcard terms as regex', () => {
    const q = parseQuery('foo*bar baz')
    expect(q.includes[0]?.regex).toBeInstanceOf(RegExp)
    expect(q.includes[1]?.regex).toBeNull()
  })

  it('treats a lone dash as a word, not negation', () => {
    const q = parseQuery('foo - bar')
    expect(q.includes.map((t) => t.raw).sort()).toEqual(['-', 'bar', 'foo'])
  })

  it('handles unterminated quotes gracefully', () => {
    const q = parseQuery('"open phrase')
    expect(q.includes.map((t) => t.raw)).toEqual(['open phrase'])
  })
})

describe('ContentSearchService.search', () => {
  let root: string
  const service = new ContentSearchService()

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'piui-search-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })

    await writeFile(
      join(root, 'src', 'app.ts'),
      'const apiToken = "abc"\n// TODO: refresh api key periodically\nexport const x = 1\n'
    )
    await writeFile(join(root, 'readme.md'), '# Guide\nUse the api key with care.\n')
    await writeFile(join(root, 'src', 'util.ts'), 'function helper() {}\n')
    await writeFile(join(root, 'data.json'), '{"apiKey": "nope"}\n')
    await writeFile(join(root, 'node_modules', 'dep', 'dep.js'), 'apiKey here\n')
    await writeFile(join(root, '.git', 'config'), 'apiKey in git\n')
    await writeFile(join(root, 'blob.bin'), 'text\0binary\0apiKey\0')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds plain terms across files with line numbers', async () => {
    const res = await service.search({ cwd: root, query: 'api' })
    const rels = res.matches.map((m) => m.relPath).sort()
    expect(rels).toContain('src/app.ts')
    expect(rels).toContain('readme.md')
    expect(rels.every((r) => !r.startsWith('node_modules') && !r.startsWith('.git'))).toBe(true)
    const todo = res.matches.find((m) => m.relPath === 'src/app.ts' && m.line === 2)
    expect(todo).toBeDefined()
    expect(todo?.lineText).toContain('TODO')
  })

  it('matches quoted phrases with spaces', async () => {
    const res = await service.search({ cwd: root, query: '"api key"' })
    expect(res.matches.length).toBeGreaterThan(0)
    expect(res.matches.every((m) => m.lineText.toLowerCase().includes('api key'))).toBe(true)
  })

  it('excludes lines matching -term', async () => {
    const res = await service.search({ cwd: root, query: 'api -TODO' })
    expect(res.matches.some((m) => m.lineText.includes('TODO'))).toBe(false)
  })

  it('restricts by path: filter', async () => {
    const res = await service.search({ cwd: root, query: 'api path:src' })
    expect(res.matches.length).toBeGreaterThan(0)
    expect(res.matches.every((m) => m.relPath.startsWith('src/'))).toBe(true)
  })

  it('restricts by ext: filter', async () => {
    const res = await service.search({ cwd: root, query: 'api -ext:md' })
    expect(res.matches.some((m) => m.relPath.endsWith('.md'))).toBe(false)
  })

  it('supports wildcards', async () => {
    const res = await service.search({ cwd: root, query: 'ap*key' })
    expect(res.matches.length).toBeGreaterThan(0)
  })

  it('case sensitivity follows case: flag', async () => {
    const sensitive = await service.search({ cwd: root, query: 'API case:on' })
    expect(sensitive.matchCount).toBe(0)
    const insensitive = await service.search({ cwd: root, query: 'API' })
    expect(insensitive.matchCount).toBeGreaterThan(0)
  })

  it('skips binary files', async () => {
    const res = await service.search({ cwd: root, query: 'apiKey' })
    expect(res.matches.some((m) => m.relPath === 'blob.bin')).toBe(false)
  })

  it('returns empty for queries with no include terms', async () => {
    const res = await service.search({ cwd: root, query: 'path:src' })
    expect(res.matches).toHaveLength(0)
  })

  it('returns empty for a missing directory', async () => {
    const res = await service.search({ cwd: join(root, 'nope'), query: 'api' })
    expect(res.matches).toHaveLength(0)
  })

  it('respects maxMatches and reports truncation', async () => {
    const res = await service.search({ cwd: root, query: 'api', maxMatches: 1 })
    expect(res.matches.length).toBe(1)
    expect(res.truncated).toBe(true)
  })
})
