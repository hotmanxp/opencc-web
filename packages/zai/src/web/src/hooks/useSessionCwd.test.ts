// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSessionCwd } from './useSessionCwd.js'
import { useAgentStore } from '../store/useAgentStore.js'

// flushStore: 让 React 在 setState 后 flush rerender
function flushStore() {
  return act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

describe('useSessionCwd (SSE-only)', () => {
  beforeEach(() => {
    useAgentStore.setState({ cwdBySession: {} })
    vi.restoreAllMocks()
  })

  it('returns undefined when sessionId is null', () => {
    const { result } = renderHook(() => useSessionCwd(null))
    expect(result.current).toBeUndefined()
  })

  it('returns cwd from store when present (SSE dispatched)', () => {
    useAgentStore.getState().applyCwdChanged({
      sessionId: 's1',
      cwd: '/tmp',
      updatedAt: 1,
    } as any)
    const { result } = renderHook(() => useSessionCwd('s1'))
    expect(result.current).toBe('/tmp')
  })

  it('returns undefined when store has no entry (cold start, pre-SSE)', () => {
    const { result } = renderHook(() => useSessionCwd('s1'))
    expect(result.current).toBeUndefined()
  })

  it('reacts to subsequent SSE cwd.changed events', () => {
    const { result } = renderHook(() => useSessionCwd('s1'))
    expect(result.current).toBeUndefined()
    act(() => {
      useAgentStore.getState().applyCwdChanged({
        sessionId: 's1',
        cwd: '/from/sse',
        updatedAt: 1,
      } as any)
    })
    expect(result.current).toBe('/from/sse')
  })

  it('does not call fetch /pwd (no fallback HTTP)', () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    renderHook(() => useSessionCwd('s1'))
    // 整个 hook 生命周期不应触发任何 fetch
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not setInterval (no polling)', async () => {
    vi.useFakeTimers()
    vi.spyOn(global, 'fetch')
    const intervalSpy = vi.spyOn(global, 'setInterval')
    renderHook(() => useSessionCwd('s1'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(intervalSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})