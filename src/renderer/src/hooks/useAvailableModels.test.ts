// src/renderer/src/hooks/useAvailableModels.test.ts
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useAvailableModels } from './useAvailableModels'
import { useStore } from '../store'
import type { ModelEntry } from '@shared/types'

function resetStore() {
  useStore.setState((useStore as unknown as { getInitialState: () => object }).getInitialState())
}

const model = (provider: string, modelId = 'm1'): ModelEntry => ({
  provider,
  modelId,
  displayName: `${provider}/${modelId}`,
  supportsThinking: false,
})

describe('useAvailableModels', () => {
  beforeEach(() => {
    resetStore()
  })

  it('shows everything when no providers are configured', () => {
    useStore.setState((s) => ({
      config: {
        ...s.config,
        models: [model('anthropic'), model('openai')],
        providers: [
          { name: 'anthropic', authType: 'apikey', configured: false },
          { name: 'openai', authType: 'apikey', configured: false },
        ],
      },
    }))

    const { result } = renderHook(() => useAvailableModels())
    expect(result.current).toHaveLength(2)
  })

  it('filters models of known-but-unconfigured providers', () => {
    useStore.setState((s) => ({
      config: {
        ...s.config,
        models: [model('anthropic'), model('openai')],
        providers: [
          { name: 'anthropic', authType: 'apikey', configured: true },
          { name: 'openai', authType: 'apikey', configured: false },
        ],
      },
    }))

    const { result } = renderHook(() => useAvailableModels())
    expect(result.current.map((m) => m.provider)).toEqual(['anthropic'])
  })

  it('keeps models of custom providers unknown to the built-in list', () => {
    // OpenRouter-style custom provider registered via ~/.pi/agent or an
    // extension: never appears in the provider status list, must not be hidden.
    useStore.setState((s) => ({
      config: {
        ...s.config,
        models: [model('anthropic'), model('my-custom-provider'), model('openrouter-proxy')],
        providers: [
          { name: 'anthropic', authType: 'apikey', configured: true },
          { name: 'openai', authType: 'apikey', configured: false },
        ],
      },
    }))

    const { result } = renderHook(() => useAvailableModels())
    expect(result.current.map((m) => m.provider)).toEqual([
      'anthropic',
      'my-custom-provider',
      'openrouter-proxy',
    ])
  })
})
