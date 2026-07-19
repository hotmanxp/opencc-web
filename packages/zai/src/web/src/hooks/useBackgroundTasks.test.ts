// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useAppStore } from '../store/useAppStore.js'
import { useAgentStore } from '../store/useAgentStore.js'
import { useBackgroundTasks } from './useBackgroundTasks.js'

// listTasks / fetchTask 由 useBackgroundTasks 间接调用,这里 mock 掉避免
// 真的打 HTTP。mock 返回空数组意味着 "还没有任何 detail loaded".
vi.mock('../lib/taskApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/taskApi.js')>()
  return {
    ...actual,
    listTasks: vi.fn(async () => []),
    fetchTask: vi.fn(async () => null),
    subscribeTaskEvents: vi.fn(async function* () {}),
    cancelTask: vi.fn(async () => ({ ok: true })),
  }
})

beforeEach(() => {
  useAppStore.setState({ jobs: {}, toasts: [] })
  useAgentStore.setState({ sessionId: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBackgroundTasks session 隔离', () => {
  test('切到 session B 后,session A 派发的运行中 agent_task 不在 runningTasks', () => {
    // 1. session A 派发一个 sub-agent 任务
    act(() => {
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
    rerender() // 让 useEffect 跑
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-A1')

    // 3. 切到 session B → 不应再看到
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    rerender()
    expect(result.current.runningTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })

  test('job 已被 useAppStore 清掉, detail 未加载的任务被视为全局 (复现 bug)', () => {
    // 现实场景: session A 派发任务, 任务在 3 秒内完成, useAppStore 把 job
    // 删了, 但 listTasks 还没把 detail 加载回来. 此时:
    //   - liveJob 没了 → sessionFromJob = undefined
    //   - detail 还没回来 → sessionFromDetail = undefined
    //   - belongsToCurrentSession 把这种任务当成 "全局任务" → 切到任何
    //     session 都看得见. 这是用户报告的 bug: 切到 B 还看到 A 的任务.
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
    // 期望: 看不到 (按 session 隔离)
    // 实际 bug: 看得到 (因为 job 没了 detail 也没, 被当全局)
    expect(result.current.recentTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })

  test('当前 session 完成任务后, job 清理窗口内任务仍可见 (lastKnownSessionId 兜底)', () => {
    // 上一个修复把"未知 session 隐藏"可能导致回归: 当前 session 完成的
    // task, 3s 后 useAppStore 清掉 job, listTasks 又还没补上 detail, 任务
    // 会从 recentTasks 消失. lastKnownSessionId 兜底: 进入 map 时记下
    // sessionId, 即使后续两个来源都没了, 仍按 lastKnownSessionId 判定.
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
    // ★ 这里当前 fail — belongsToCurrentSession 误把 sessionId=null
    // 的任务当"不属于任何 session" 隐藏了
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-global-1')

    // 切到另一个 session, 全局任务仍应可见
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    rerender()
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-global-1')
  })

  test('listTasks 返回 detail 后,session 隔离正常生效', async () => {
    // 上一 case 的反面: listTasks 把 parentSessionId 加载回来后, 即使
    // liveJob 没了, 过滤仍然正确.
    const { listTasks } = await import('../lib/taskApi.js')
    vi.mocked(listTasks).mockResolvedValueOnce([
      {
        id: 'task-A1',
        status: 'completed',
        input: { prompt: 'do X', cwd: '/a', model: 'm' },
        createdAt: 1000,
        finishedAt: 2000,
        eventCount: 5,
        parentSessionId: 'sess-A',
      } as any,
    ])

    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.started',
        eventId: 'e1', ts: 1,
        jobId: 'task-A1', kind: 'agent_task', taskId: 'task-A1',
        sessionId: 'sess-A',
      })
    })
    act(() => {
      useAppStore.getState().applyJobEvent({
        type: 'job.done',
        eventId: 'e2', ts: 2, jobId: 'task-A1',
      })
      useAppStore.setState((s) => {
        const jobs = { ...s.jobs }
        delete jobs['task-A1']
        return { jobs }
      })
    })
    // 切到 B, 触发 useEffect → listTasks 加载 detail
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    const { result, rerender } = renderHook(() => useBackgroundTasks())
    // 等 listTasks promise resolve + setTasks 跑完
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    rerender()
    expect(result.current.recentTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })
})
