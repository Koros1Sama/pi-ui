// src/renderer/src/hooks/useResolvedDirection.ts
import { useEffect } from 'react'
import { useStore } from '@/store'
import type { UiDirection } from '@shared/types'

/** Languages written right-to-left (ISO 639-1 prefixes). */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ckb', 'yi', 'dv', 'ug'])

/**
 * Resolves the effective layout direction from the user preference.
 * 'auto' (the default) follows the OS/app locale: an Arabic, Hebrew, Farsi…
 * system gets RTL without any configuration, everything else LTR.
 */
export function resolveDirection(preference: UiDirection | undefined): 'ltr' | 'rtl' {
  if (preference === 'rtl') return 'rtl'
  if (preference === 'ltr') return 'ltr'
  // 'auto' / unset — detect from the app locale
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ]
  for (const tag of candidates) {
    const prefix = (tag ?? '').toLowerCase().split('-')[0]
    if (RTL_LANGUAGES.has(prefix)) return 'rtl'
    if (prefix) return 'ltr' // first concrete language decides
  }
  return 'ltr'
}

/**
 * Applies the resolved direction to the document root so CSS logical
 * properties, Tailwind rtl:/ltr: variants and native scrollbars all follow.
 * (ConfigState carries config.uiDirection — see store/config-slice.ts.)
 */
export function useResolvedDirection(): 'ltr' | 'rtl' {
  const uiDirection = useStore((s) => s.config.uiDirection)
  const dir = resolveDirection(uiDirection)

  useEffect(() => {
    document.documentElement.dir = dir
  }, [dir])

  return dir
}
