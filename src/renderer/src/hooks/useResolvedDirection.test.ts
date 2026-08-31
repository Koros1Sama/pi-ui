// src/renderer/src/hooks/useResolvedDirection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveDirection } from './useResolvedDirection'

const nav = navigator as Navigator & { languages?: readonly string[] }

function setLanguages(langs: string[], language: string) {
  Object.defineProperty(nav, 'languages', { value: langs, configurable: true })
  Object.defineProperty(nav, 'language', { value: language, configurable: true })
}

describe('resolveDirection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('explicit rtl/ltr preferences win', () => {
    setLanguages(['ar-SA'], 'ar-SA')
    expect(resolveDirection('ltr')).toBe('ltr')
    setLanguages(['en-US'], 'en-US')
    expect(resolveDirection('rtl')).toBe('rtl')
  })

  it('auto detects RTL from an Arabic locale', () => {
    setLanguages(['ar-SA', 'en-US'], 'ar-SA')
    expect(resolveDirection('auto')).toBe('rtl')
    expect(resolveDirection(undefined)).toBe('rtl')
  })

  it('auto detects RTL from Hebrew, Farsi and Urdu', () => {
    for (const tag of ['he-IL', 'fa-IR', 'ur-PK']) {
      setLanguages([tag], tag)
      expect(resolveDirection('auto')).toBe('rtl')
    }
  })

  it('auto resolves LTR for western locales', () => {
    for (const tag of ['en-US', 'de-DE', 'ja-JP']) {
      setLanguages([tag], tag)
      expect(resolveDirection('auto')).toBe('ltr')
    }
  })

  it('falls back to LTR when no locale is available', () => {
    setLanguages([], '')
    expect(resolveDirection('auto')).toBe('ltr')
  })
})
