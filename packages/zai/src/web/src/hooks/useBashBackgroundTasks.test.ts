// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useBashBackgroundTasks } from './useBashBackgroundTasks.js'
import { useAgentStore } from '../store/useAgentStore.js'
import * as taskApi from '../lib/taskApi.js'
import type { BashTaskInfo } from '../lib/taskApi.js'

describe('useBashBackgroundTasks (SSE-only)', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessionId: null, bashTasksBySession: {} })
    vi.restoreAllMocks()
  })

  it('returns empty list when sessionId is null', () => {
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([])
  })

  it('returns tasks from store when SSE dispatched', () => {
    const task: BashTaskInfo = { taskId: 'b1', status: 'running', sessionId: 's1', command: 'ls', description: '', startedAt: 0, stdout: '', stderr: '', isBackgrounded: false, notified: false }
    useAgentStore.setState({ sessionId: 's1' })
    act(() => {
      useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task })
    })
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toHaveLength(1)
    expect(result.current.tasks[0].taskId).toBe('b1')
  })

  it('returns undefined when store empty (cold start, pre-SSE)', () => {
    useAgentStore.setState({ sessionId: 's1' })
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([])
  })

  it('reacts to subsequent SSE bash_task.changed events', () => {
    useAgentStore.setState({ sessionId: 's1' })
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([])
    act(() => {
      useAgentStore.getState().applyBashTaskChanged({
        sessionId: 's1',
        task: { taskId: 'b1', status: 'running', sessionId: 's1', command: 'ls', description: '', startedAt: 0, stdout: '', stderr: '', isBackgrounded: false, notified: false },
      })
    })
    expect(result.current.tasks).toHaveLength(1)
  })

  it('does not call listBashTasks (no fallback HTTP)', () => {
    const fetchSpy = vi.spyOn(taskApi, 'listBashTasks')
    useAgentStore.setState({ sessionId: 's1' })
    renderHook(() => useBashBackgroundTasks())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not setInterval (no polling)', async () => {
    vi.useFakeTimers()
    vi.spyOn(taskApi, 'listBashTasks')
    const intervalSpy = vi.spyOn(global, 'setInterval')
    useAgentStore.setState({ sessionId: 's1' })
    renderHook(() => useBashBackgroundTasks())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(intervalSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})