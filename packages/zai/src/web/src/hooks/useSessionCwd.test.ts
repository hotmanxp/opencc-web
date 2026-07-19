// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSessionCwd } from './useSessionCwd.js'
import { useAgentStore } from '../store/useAgentStore.js'

describe('useSessionCwd', () => {
  beforeEach(() => {
    useAgentStore.setState({ cwdBySession: {} })
    vi.restoreAllMocks()
  })

  it('returns undefined when sessionId is null', () => {
    const { result } = renderHook(() => useSessionCwd(null))
    expect(result.current).toBeUndefined()
  })

  it('returns cwd from store when present', () => {
    useAgentStore.setState({ cwdBySession: { 's1': '/tmp' } })
    const { result } = renderHook(() => useSessionCwd('s1'))
    expect(result.current).toBe('/tmp')
  })

  it('falls back to one-shot fetch when store has no entry', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ cwd: '/fallback' }),
    } as any)
    renderHook(() => useSessionCwd('s1'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/fallback')
  })

  it('does not setInterval (no polling)', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ cwd: '/x' }),
    } as any)
    renderHook(() => useSessionCwd('s1'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchSpy.mock.calls.length).toBeLessThan(2)
    vi.useRealTimers()
  })
})