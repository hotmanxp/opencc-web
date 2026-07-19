// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBashBackgroundTasks } from './useBashBackgroundTasks.js'
import { useAgentStore } from '../store/useAgentStore.js'
import * as taskApi from '../lib/taskApi.js'

describe('useBashBackgroundTasks', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessionId: null, bashTasksBySession: {} })
    vi.restoreAllMocks()
  })

  it('returns empty list when sessionId is null', () => {
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([])
  })

  it('returns tasks from store', () => {
    useAgentStore.setState({
      sessionId: 's1',
      bashTasksBySession: { s1: [{ taskId: 'b1' } as any] },
    })
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([{ taskId: 'b1' }])
  })

  it('falls back to listBashTasks one-shot on mount', async () => {
    useAgentStore.setState({ sessionId: 's1' })
    const spy = vi.spyOn(taskApi, 'listBashTasks').mockResolvedValue([
      { taskId: 'b1' } as any,
    ])
    renderHook(() => useBashBackgroundTasks())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spy).toHaveBeenCalledWith('s1')
    expect(useAgentStore.getState().bashTasksBySession['s1']).toHaveLength(1)
  })

  it('does not setInterval', async () => {
    vi.useFakeTimers()
    useAgentStore.setState({ sessionId: 's1' })
    const spy = vi.spyOn(taskApi, 'listBashTasks').mockResolvedValue([])
    renderHook(() => useBashBackgroundTasks())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spy.mock.calls.length).toBeLessThan(2)
    vi.useRealTimers()
  })
})