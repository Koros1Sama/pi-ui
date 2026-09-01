// src/renderer/src/store/tabs-slice.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store'
import { mruTarget, positionalTarget, type Tab } from './tabs-slice'

function makeTab(id: string): Tab {
  return {
    id,
    sessionId: id,
    cwd: `/${id}`,
    model: 'm',
    provider: 'p',
    thinkingLevel: 'off',
    status: 'idle',
    messages: [],
    currentStreamingContent: '',
    mode: 'active',
    diffPaneOpen: false,
    currentDiff: null,
    diffComments: [],
  }
}

function resetStore() {
  useStore.setState((useStore as unknown as { getInitialState: () => object }).getInitialState())
}

describe('mruTarget', () => {
  it('cycles recency order with wraparound (Firefox Ctrl+Tab)', () => {
    const mru = ['a', 'b', 'c']
    expect(mruTarget(mru, 'a', 1)).toBe('b')
    expect(mruTarget(mru, 'b', 1)).toBe('c')
    expect(mruTarget(mru, 'c', 1)).toBe('a')
  })

  it('reverse direction (Ctrl+Shift+Tab)', () => {
    const mru = ['a', 'b', 'c']
    expect(mruTarget(mru, 'a', -1)).toBe('c')
    expect(mruTarget(mru, 'b', -1)).toBe('a')
  })

  it('handles unknown ids and tiny lists', () => {
    expect(mruTarget(['a', 'b'], 'zzz', 1)).toBe('a')
    expect(mruTarget(['x'], 'x', 1)).toBeNull()
    expect(mruTarget([], null, 1)).toBeNull()
    expect(mruTarget(['a', 'b'], null, 1)).toBeNull()
  })
})

describe('positionalTarget', () => {
  const tabs = [makeTab('a'), makeTab('b'), makeTab('c')]

  it('cycles tab-bar position (Ctrl+PageDown right, PageUp left)', () => {
    expect(positionalTarget(tabs, 'a', 1)).toBe('b')
    expect(positionalTarget(tabs, 'c', 1)).toBe('a') // wraps
    expect(positionalTarget(tabs, 'a', -1)).toBe('c') // wraps
    expect(positionalTarget(tabs, 'b', -1)).toBe('a')
  })

  it('handles unknown ids and tiny lists', () => {
    expect(positionalTarget(tabs, 'zzz', 1)).toBe('a')
    expect(positionalTarget([makeTab('x')], 'x', 1)).toBeNull()
    expect(positionalTarget([], null, 1)).toBeNull()
  })
})

describe('tabs store MRU maintenance', () => {
  beforeEach(() => {
    resetStore()
  })

  it('creation pushes to the MRU front; activation refreshes it', () => {
    useStore.getState().createTab(makeTab('t1'))
    useStore.getState().createTab(makeTab('t2'))
    useStore.getState().createTab(makeTab('t3'))
    expect(useStore.getState().tabs.mru).toEqual(['t3', 't2', 't1'])

    useStore.getState().setActiveTab('t1')
    expect(useStore.getState().tabs.mru).toEqual(['t1', 't3', 't2'])

    useStore.getState().closeTab('t2')
    expect(useStore.getState().tabs.mru).toEqual(['t1', 't3'])
  })

  it('replaceTab swaps the id inside the MRU list', () => {
    useStore.getState().createTab(makeTab('t1'))
    useStore.getState().createTab(makeTab('t2'))
    useStore.getState().replaceTab('t1', makeTab('t9'))
    expect(useStore.getState().tabs.mru).toEqual(['t2', 't9'])
  })
})

describe('pending (steered) user messages', () => {
  beforeEach(() => {
    resetStore()
    useStore.getState().createTab(makeTab('t1'))
  })

  it('addUserMessage flags pending; confirm resolves FIFO; clear flushes all', () => {
    const st = useStore.getState()
    st.addUserMessage('t1', 'first', true)
    st.addUserMessage('t1', 'second', true)
    st.addUserMessage('t1', 'normal send')

    let msgs = useStore.getState().tabs.tabs[0]!.messages
    expect(msgs.map((m) => m.pending)).toEqual([true, true, undefined])

    useStore.getState().confirmPendingUserMessage('t1')
    msgs = useStore.getState().tabs.tabs[0]!.messages
    expect(msgs[0]!.pending).toBe(false)
    expect(msgs[1]!.pending).toBe(true)

    useStore.getState().clearPendingUserMessages('t1')
    msgs = useStore.getState().tabs.tabs[0]!.messages
    expect(msgs.every((m) => !m.pending)).toBe(true)
  })
})
