// src/main/content-search-service.ts
import { readFile, readdir, stat } from 'fs/promises'
import { join, relative, extname } from 'path'
import type { ContentSearchMatch, ContentSearchResult } from '@shared/types'

/** Directories never worth scanning (build output, VCS, deps…). */
const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.gradle',
])

const MAX_FILE_BYTES = 2 * 1024 * 1024 // skip files > 2MB
const MAX_FILES = 50_000
const MAX_MATCHES_DEFAULT = 500
const TIME_BUDGET_MS = 10_000
const YIELD_EVERY_FILES = 25 // keep the main process responsive

/** One term to find (or exclude): plain substring, or regex when it has `*`. */
export interface SearchTerm {
  raw: string
  /** lowercase text when regex === null, else ignored */
  text: string
  regex: RegExp | null
}

export interface ParsedQuery {
  includes: SearchTerm[]
  excludes: SearchTerm[]
  pathIncludes: string[]
  pathExcludes: string[]
  extIncludes: string[]
  extExcludes: string[]
  caseSensitive: boolean
}

function wildcardToRegex(token: string, caseSensitive: boolean): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '*' ? '[\\s\\S]*' : `\\${ch}`
  )
  return new RegExp(escaped, caseSensitive ? '' : 'i')
}

function makeTerm(raw: string, caseSensitive: boolean): SearchTerm {
  const hasWildcard = raw.includes('*')
  return {
    raw,
    text: caseSensitive ? raw : raw.toLowerCase(),
    regex: hasWildcard ? wildcardToRegex(raw, caseSensitive) : null,
  }
}

function matchTerm(haystack: string, haystackLower: string, term: SearchTerm): boolean {
  if (term.regex) return term.regex.test(haystack)
  return haystackLower.includes(term.text)
}

function firstIndex(haystack: string, haystackLower: string, term: SearchTerm): number {
  if (term.regex) {
    const m = term.regex.exec(haystack)
    return m ? m.index : -1
  }
  return haystackLower.indexOf(term.text)
}

/** True when `text` satisfies every include term and no exclude term. */
export function matchText(parsed: ParsedQuery, text: string): boolean {
  const lower = parsed.caseSensitive ? text : text.toLowerCase()
  return (
    parsed.includes.every((t) => matchTerm(text, lower, t)) &&
    !parsed.excludes.some((t) => matchTerm(text, lower, t))
  )
}

/** 0-based index of the first include-term hit in `text` (-1 if none). */
export function firstMatchIndex(parsed: ParsedQuery, text: string): number {
  const lower = parsed.caseSensitive ? text : text.toLowerCase()
  let best = -1
  for (const t of parsed.includes) {
    const idx = firstIndex(text, lower, t)
    if (idx >= 0 && (best === -1 || idx < best)) best = idx
  }
  return best
}

/**
 * Everything-style query syntax:
 *
 *   word          substring all terms must match (AND)
 *   "exact text"  literal phrase (spaces preserved)
 *   -word / -"x"  exclusion — line must NOT contain it
 *   path:src      restrict to files whose path contains `src`
 *   -path:test    exclude files whose path contains `test`
 *   ext:ts,tsx    restrict to these extensions
 *   -ext:json     exclude extension
 *   case:on       case-sensitive matching (default: off)
 *   foo*bar       wildcard term (regex, * = anything)
 */
export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = {
    includes: [],
    excludes: [],
    pathIncludes: [],
    pathExcludes: [],
    extIncludes: [],
    extExcludes: [],
    caseSensitive: false,
  }

  let i = 0
  const n = query.length
  while (i < n) {
    // skip whitespace
    while (i < n && /\s/.test(query[i])) i++
    if (i >= n) break

    let negate = false
    if (query[i] === '-' && i + 1 < n && query[i + 1] !== ' ') {
      negate = true
      i++
    }

    // quoted phrase / quoted filter value
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1)
      const phrase = end === -1 ? query.slice(i + 1) : query.slice(i + 1, end)
      i = end === -1 ? n : end + 1
      if (phrase) (negate ? parsed.excludes : parsed.includes).push(makeTerm(phrase, false))
      continue
    }

    // bare token (may be a filter)
    let j = i
    while (j < n && !/\s/.test(query[j])) j++
    const token = query.slice(i, j)
    i = j

    const filterMatch = /^(path|ext|case):(.*)$/.exec(token)
    if (filterMatch) {
      const [, key, value] = filterMatch
      if (key === 'case') {
        parsed.caseSensitive = /^(on|sensitive|true|1)$/i.test(value)
      } else if (value) {
        const list = value
          .toLowerCase()
          .split(',')
          .map((v) => v.trim().replace(/^\./, ''))
          .filter(Boolean)
        if (key === 'path') {
          for (const v of list)
            (negate ? parsed.pathExcludes : parsed.pathIncludes).push(v.toLowerCase())
        } else {
          for (const v of list) (negate ? parsed.extExcludes : parsed.extIncludes).push(v)
        }
      }
      continue
    }

    if (token)
      (negate ? parsed.excludes : parsed.includes).push(makeTerm(token, parsed.caseSensitive))
  }

  // Wildcard case-sensitivity was decided per-term before case: filters could
  // appear; rebuild regexes honor the final flag.
  if (parsed.caseSensitive) {
    const rebuild = (t: SearchTerm) => makeTerm(t.raw, true)
    parsed.includes = parsed.includes.map(rebuild)
    parsed.excludes = parsed.excludes.map(rebuild)
  }

  return parsed
}

export interface SearchRequest {
  cwd: string
  query: string
  maxMatches?: number
}

export class ContentSearchService {
  /** Parse + search. Empty include set → empty result (nothing to find). */
  async search(req: SearchRequest): Promise<ContentSearchResult> {
    const started = Date.now()
    const parsed = parseQuery(req.query)
    const maxMatches = Math.min(req.maxMatches ?? MAX_MATCHES_DEFAULT, 2000)

    const empty = (truncated = false): ContentSearchResult => ({
      matches: [],
      truncated,
      fileCount: 0,
      matchCount: 0,
      durationMs: Date.now() - started,
    })
    if (parsed.includes.length === 0) return empty()

    let dirOk = false
    try {
      const s = await stat(req.cwd)
      dirOk = s.isDirectory()
    } catch {
      dirOk = false
    }
    if (!dirOk) return empty()

    const files: string[] = []
    await this.collectFiles(req.cwd, req.cwd, files, parsed, 0)

    const matches: ContentSearchMatch[] = []
    let truncated = false
    let yielded = 0

    for (const abs of files) {
      if (matches.length >= maxMatches) {
        truncated = true
        break
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        truncated = true
        break
      }
      if (++yielded % YIELD_EVERY_FILES === 0) await new Promise((r) => setImmediate(r))

      let content: string
      try {
        const st = await stat(abs)
        if (st.size > MAX_FILE_BYTES || st.size === 0) continue
        content = await readFile(abs, 'utf-8')
      } catch {
        continue
      }
      // Binary sniff: a NUL in the first 8KB means skip.
      if (content.slice(0, 8192).includes('\0')) continue

      const relPath = relative(req.cwd, abs).split(/[\\/]/).join('/')
      const lines = content.split('\n')
      let fileMatches = 0
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]
        if (line.length > 1000) continue // minified/huge lines: skip
        const lower = parsed.caseSensitive ? line : line.toLowerCase()
        let ok = true
        let firstCol = -1
        for (const term of parsed.includes) {
          if (!matchTerm(line, lower, term)) {
            ok = false
            break
          }
          const idx = firstIndex(line, lower, term)
          if (idx >= 0 && (firstCol === -1 || idx < firstCol)) firstCol = idx
        }
        if (!ok) continue
        if (parsed.excludes.some((term) => matchTerm(line, lower, term))) continue

        matches.push({
          path: abs,
          relPath,
          line: li + 1,
          column: firstCol < 0 ? 0 : firstCol,
          lineText: line.length > 300 ? line.slice(0, 300) : line,
          term: parsed.includes[0]?.raw ?? '',
        })
        fileMatches++
        if (fileMatches >= 50) break // per-file cap: keep results diverse
        if (matches.length >= maxMatches) {
          truncated = true
          break
        }
      }
    }

    return {
      matches,
      truncated,
      fileCount: files.length,
      matchCount: matches.length,
      durationMs: Date.now() - started,
    }
  }

  /** Recursive directory walk applying path/ext filters during traversal. */
  private async collectFiles(
    root: string,
    dir: string,
    out: string[],
    parsed: ParsedQuery,
    depth: number
  ): Promise<void> {
    if (out.length >= MAX_FILES || depth > 32) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const name = entry.name
      if (name.startsWith('.') || EXCLUDED_DIRS.has(name)) continue

      const abs = join(dir, name)
      if (entry.isDirectory()) {
        await this.collectFiles(root, abs, out, parsed, depth + 1)
      } else if (entry.isFile()) {
        if (parsed.extIncludes.length || parsed.extExcludes.length) {
          const ext = extname(name).toLowerCase().replace(/^\./, '')
          if (parsed.extIncludes.length && !parsed.extIncludes.includes(ext)) continue
          if (parsed.extExcludes.includes(ext)) continue
        }
        if (parsed.pathIncludes.length || parsed.pathExcludes.length) {
          const rel = relative(root, abs).split(/[\\/]/).join('/').toLowerCase()
          if (parsed.pathIncludes.length && !parsed.pathIncludes.some((p) => rel.includes(p)))
            continue
          if (parsed.pathExcludes.some((p) => rel.includes(p))) continue
        }
        out.push(abs)
      }
    }
  }
}
