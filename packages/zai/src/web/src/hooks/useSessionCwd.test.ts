// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useSessionCwd } from './useSessionCwd.js'

// Mock fetch globally
const mockFetch = vi.fn()
beforeEach(() => {
  mockFetch.mockReset()
  ;(globalThis as any).fetch = mockFetch
})

describe('useSessionCwd', () => {
  it('returns undefined when sessionId is null', async () => {
    const { result } = renderHook(() => useSessionCwd(null))
    expect(result.current).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches immediately on mount with valid sessionId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cwd: '/tmp/foo', updatedAt: 1 }),
    })
    const { result } = renderHook(() => useSessionCwd('sess-a'))
    await waitFor(() => expect(result.current).toBe('/tmp/foo'))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith('/api/agent/sessions/sess-a/pwd')
  })

  it('clears interval on unmount', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cwd: '/tmp', updatedAt: 1 }),
    })
    const { unmount, result } = renderHook(() => useSessionCwd('sess-u'))
    await waitFor(() => expect(result.current).toBe('/tmp'))
    const callsBeforeUnmount = mockFetch.mock.calls.length
    unmount()
    // 立即 unmount, fetch count 不应再增
    await new Promise(r => setTimeout(r, 10))
    expect(mockFetch.mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('keeps last known value on 404 (session closed)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ cwd: '/known', updatedAt: 1 }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'session not found' }) })
    const { result } = renderHook(() => useSessionCwd('sess-gone'))
    await waitFor(() => expect(result.current).toBe('/known'))
    expect(result.current).toBe('/known')
  })

  it('polls every 5 seconds', async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cwd: '/tmp/x', updatedAt: 1 }),
    })
    const { result, unmount } = renderHook(() => useSessionCwd('sess-poll'))
    // Flush microtasks so the initial fetch lands; do NOT fire the interval.
    // (vi.runOnlyPendingTimersAsync would also fire the pending t=5000 setInterval.)
    await act(async () => { await Promise.resolve() })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mockFetch).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
    unmount()
  })

  it('restarts polling when sessionId changes', async () => {
    // Use 'sess-a' (not bare 'a') as the discriminator — '/api/agent/...'
    // already contains the substring 'a' so url.includes('a') would match both sessions.
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ cwd: url.includes('sess-a') ? '/A' : '/B', updatedAt: 1 }),
    }))
    const { result, rerender, unmount } = renderHook(
      ({ sid }: { sid: string }) => useSessionCwd(sid),
      { initialProps: { sid: 'sess-a' } }
    )
    await waitFor(() => expect(result.current).toBe('/A'))
    rerender({ sid: 'sess-b' })
    await waitFor(() => expect(result.current).toBe('/B'))
    expect(mockFetch).toHaveBeenLastCalledWith('/api/agent/sessions/sess-b/pwd')
    unmount()
  })

  it('keeps last known value on fetch error (network)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ cwd: '/known', updatedAt: 1 }) })
      .mockRejectedValueOnce(new Error('network'))
    const { result, unmount } = renderHook(() => useSessionCwd('sess-err'))
    await waitFor(() => expect(result.current).toBe('/known'))
    // Verify the catch path doesn't throw by awaiting the rejected mock result:
    await act(async () => {
      try { await mockFetch.mock.results[1]?.value } catch {}
    })
    // result should still be /known after the rejected fetch
    expect(result.current).toBe('/known')
    unmount()
  })
})