// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore.js'
import { useAgentStore } from '../store/useAgentStore.js'
import { useBackgroundTasks } from './useBackgroundTasks.js'

// subscribeTaskEvents 由 TaskDrawer 调用,这里 mock 掉避免真的打 HTTP。
vi.mock('../lib/taskApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/taskApi.js')>()
  return {
    ...actual,
    listTasks: vi.fn(async () => []),
    fetchTask: vi.fn(async () => null),
    subscribeTaskEvents: vi.fn(async function* () {}),
    cancelTask: vi.fn(async () => ({ ok: true })),
    fetchBashTask: vi.fn(async () => null),
  }
})

beforeEach(() => {
  useAppStore.setState({ jobs: {}, toasts: [] })
  useAgentStore.setState({
    sessionId: null,
    // 重置 store 的 agentTasksBySession, 避免上一个 test 注入的 entry
    // 影响当前 test.
    agentTasksBySession: {},
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBackgroundTasks session 隔离 (100% SSE)', () => {
  test('切到 session B 后,session A 派发的运行中 agent_task 不在 runningTasks', () => {
    // 1. SSE agent_task.changed + job.started 推到 store
    act(() => {
      useAgentStore.getState().applyAgentTaskChanged({
        sessionId: 'sess-A',
        task: {
          id: 'task-A1', status: 'running', input: { prompt: 'do X', cwd: '/a', model: 'm' },
          createdAt: 1000, eventCount: 1, parentSessionId: 'sess-A',
        } as any,
      })
      useAppStore.getState().applyJobEvent({
        type: 'job.started',
        eventId: 'e1', ts: 1,
        jobId: 'task-A1', kind: 'agent_task', taskId: 'task-A1',
        sessionId: 'sess-A',
      })
    })
    // 2. 当前在 session A → 应该看到
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result, rerender } = renderHook(() => useBackgroundTasks())
    rerender()
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-A1')

    // 3. 切到 session B → 不应再看到
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    rerender()
    expect(result.current.runningTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })

  test('job 已被 useAppStore 清掉,detail 未加载的任务被视为全局 (复现 bug)', () => {
    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.started',
        eventId: 'e1', ts: 1,
        jobId: 'task-A1', kind: 'agent_task', taskId: 'task-A1',
        sessionId: 'sess-A',
      })
    })
    // 切到 session A, 让 hook 把 task 收进 map
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result, rerender } = renderHook(() => useBackgroundTasks())
    rerender()
    expect(result.current.runningTasks.length).toBe(1)

    // 任务 done — 让 hook 看到 job.done, 把 task 状态更新为 'completed'
    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.done',
        eventId: 'e2', ts: 2, jobId: 'task-A1',
      })
    })
    rerender()
    const internalTasks = (result.current as any).tasks as Array<{ taskId: string; status: string; detail?: any; finishedAt?: number }>
    expect(internalTasks[0]?.status).toBe('completed')

    // 3s 后 useAppStore 自动删 job — 手动触发
    act(() => {
      useAppStore.setState((s) => {
        const jobs = { ...s.jobs }
        delete jobs['task-A1']
        return { jobs }
      })
    })
    rerender()

    // 切到 session B
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    rerender()
    expect(result.current.recentTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })

  test('当前 session 完成任务后, job 清理窗口内任务仍可见 (lastKnownSessionId 兜底)', () => {
    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.started',
        eventId: 'e1', ts: 1,
        jobId: 'task-A1', kind: 'agent_task', taskId: 'task-A1',
        sessionId: 'sess-A',
      })
    })
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result, rerender } = renderHook(() => useBackgroundTasks())
    rerender()
    expect(result.current.runningTasks.length).toBe(1)

    // job.done
    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.done',
        eventId: 'e2', ts: 2, jobId: 'task-A1',
      })
    })
    rerender()
    // 3s 后 useAppStore 清理 job (手动模拟)
    act(() => {
      useAppStore.setState((s) => {
        const jobs = { ...s.jobs }
        delete jobs['task-A1']
        return { jobs }
      })
    })
    rerender()
    // 当前仍在 session A, 任务应仍在 recentTasks (lastKnownSessionId 兜底)
    expect(result.current.recentTasks.map((t) => t.taskId)).toContain('task-A1')

    // 切到 B → 任务应消失
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    rerender()
    expect(result.current.recentTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })

  test('agent_task 全局 (无 parentSessionId, sessionId=null) 在任何 session 都应可见', () => {
    // 现实场景: 后台派发一个 agent_task 但 metadata.parentSessionId 缺失
    // (例如 cli dispatch / 老数据 / 调度器自己派), server emit 的
    // job.started.sessionId === null. 此前 bug: belongsToCurrentSession 把
    // sessionId 查不到的任务视为"不属于任何 session → 隐藏", 导致 dock
    // 看不到这类全局 agent_task.
    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.started',
        eventId: 'e1', ts: 1,
        jobId: 'task-global-1', kind: 'agent_task', taskId: 'task-global-1',
        sessionId: null,
      })
    })
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result, rerender } = renderHook(() => useBackgroundTasks())
    rerender()
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-global-1')

    // 切到另一个 session, 全局任务仍应可见
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    rerender()
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-global-1')
  })

  test('SSE agent_task.changed: 当前 sid 已有 entries 时立即渲染', async () => {
    // 100% SSE 设计: 不再 listTasks fallback. 测试 SSE 直接推到 store
    // 后渲染行为。
    const { listTasks } = await import('../lib/taskApi.js')
    vi.mocked(listTasks).mockClear()

    // 预置 store entries — 模拟 SSE agent_task.changed 已推过
    act(() => {
      useAgentStore.getState().applyAgentTaskChanged({
        sessionId: 'sess-A',
        task: {
          id: 'task-A1', status: 'running',
          input: { prompt: 'do X', cwd: '/a', model: 'm' },
          createdAt: 1000, eventCount: 1, parentSessionId: 'sess-A',
        } as any,
      })
    })
    // 切到 sess-A, store 已有 entries → 立即渲染 + 不应调 listTasks
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result } = renderHook(() => useBackgroundTasks())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(listTasks).not.toHaveBeenCalled()
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-A1')
  })

  test('store 为空时 不再调 listTasks fallback (100% SSE)', async () => {
    // 100% SSE 设计: 冷启动不再发 listTasks. 切到空 store 的 session
    // 不会自动拉历史,直到 SSE 推过来或 job 通道触发。
    const { listTasks } = await import('../lib/taskApi.js')
    vi.mocked(listTasks).mockClear()

    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result } = renderHook(() => useBackgroundTasks())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(listTasks).not.toHaveBeenCalled()
    // store 为空, runningTasks 为空
    expect(result.current.runningTasks).toEqual([])
    expect(result.current.recentTasks).toEqual([])
  })

  test('冷启动后 SSE 推过来任务: 不再调 listTasks,但任务可见', async () => {
    // 模拟冷启动场景: store 空 + 切到新 session, 100ms 后 SSE agent_task.changed
    // 推过来。验证任务可见 + 没调 listTasks。
    const { listTasks } = await import('../lib/taskApi.js')
    vi.mocked(listTasks).mockClear()

    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result } = renderHook(() => useBackgroundTasks())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(listTasks).not.toHaveBeenCalled()

    // SSE agent_task.changed 推过来
    act(() => {
      useAgentStore.getState().applyAgentTaskChanged({
        sessionId: 'sess-A',
        task: {
          id: 'task-A1', status: 'running',
          input: { prompt: 'do X', cwd: '/a', model: 'm' },
          createdAt: 1000, eventCount: 1, parentSessionId: 'sess-A',
        } as any,
      })
    })
    expect(listTasks).not.toHaveBeenCalled()
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-A1')
  })
})