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
  useAgentStore.setState({
    sessionId: null,
    // 重置 store 的 agentTasksBySession, 避免上一个 test 注入的 entry
    // 影响当前 test 的 hasInitial / listTasks fallback 判定.
    agentTasksBySession: {},
  })
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

  test('listTasks 返回 detail 后,session 隔离正常生效', async () => {
    // 上一 case 的反面: 切到 B 后 store 没有 sess-B entries → 触发 listTasks
    // fallback. 加载到的 task-A1 属于 sess-A → 注入到 agentTasksBySession['sess-A']
    // 而非 ['sess-B']. 当前查看 sess-B 时 storeTasks=undefined, store 合并
    // effect 不写入本地 map; jobs effect 留下的 lastKnownSessionId='sess-A'
    // 兜底继续生效 → recentTasks 不含 task-A1.
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
    // 切到 B, store 没有 sess-B entries → 触发 listTasks fallback
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-B' })
    })
    const { result, rerender } = renderHook(() => useBackgroundTasks())
    // 等 listTasks promise resolve + applyAgentTaskChanged 跑完
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    rerender()
    expect(result.current.recentTasks.map((t) => t.taskId)).not.toContain('task-A1')
  })

  test('store 已有当前 sid entries 时,listTasks 不重发', async () => {
    // Task 14 新契约: SSE 已推过 / 之前已加载过的 session 不再发 listTasks.
    // 验证方法: 预置 agentTasksBySession[sess-A], 切到 sess-A → listTasks
    // 调用次数保持为 0.
    const { listTasks } = await import('../lib/taskApi.js')
    vi.mocked(listTasks).mockClear()

    // 预置 store entries — 模拟 SSE 已推过 / 之前 fallback 已加载
    act(() => {
      useAgentStore.getState().applyAgentTaskChanged({
        sessionId: 'sess-A',
        task: {
          id: 'task-A1',
          status: 'running',
          input: { prompt: 'do X', cwd: '/a', model: 'm' },
          createdAt: 1000,
          eventCount: 1,
          parentSessionId: 'sess-A',
        } as any,
      })
    })
    // 切到 sess-A, store 已有 entries → listTasks 不应被调用
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result } = renderHook(() => useBackgroundTasks())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(listTasks).not.toHaveBeenCalled()
    // 预置的 entry 应出现在 runningTasks
    expect(result.current.runningTasks.map((t) => t.taskId)).toContain('task-A1')
  })

  test('store 为空时 listTasks fallback 触发,结果通过 applyAgentTaskChanged 注入', async () => {
    // Task 14 新契约: 冷启动 (store 没当前 sid entries) 时发一次 listTasks,
    // 每条 task 走 applyAgentTaskChanged 注入到 store — SSE 推送路径与 fallback
    // 路径汇合到同一个 reducer, 后续渲染逻辑统一.
    const { listTasks } = await import('../lib/taskApi.js')
    vi.mocked(listTasks).mockClear()
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
      {
        id: 'task-B1',
        status: 'running',
        input: { prompt: 'do Y', cwd: '/b', model: 'm' },
        createdAt: 1500,
        eventCount: 2,
        parentSessionId: 'sess-B',
      } as any,
    ])

    // spy on applyAgentTaskChanged to verify injection
    const applySpy = vi.spyOn(useAgentStore.getState(), 'applyAgentTaskChanged')

    // 切到 sess-A, store 空 → listTasks 触发 + apply
    act(() => {
      useAgentStore.setState({ sessionId: 'sess-A' })
    })
    const { result } = renderHook(() => useBackgroundTasks())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(listTasks).toHaveBeenCalledTimes(1)
    // 两条结果都注入; 各自的 sessionId 来自 task.parentSessionId
    expect(applySpy).toHaveBeenCalledTimes(2)
    const calls = applySpy.mock.calls.map((c) => c[0])
    expect(calls).toContainEqual(
      expect.objectContaining({ sessionId: 'sess-A', task: expect.objectContaining({ id: 'task-A1' }) }),
    )
    expect(calls).toContainEqual(
      expect.objectContaining({ sessionId: 'sess-B', task: expect.objectContaining({ id: 'task-B1' }) }),
    )

    // 当前 sessionId=sess-A → storeTasks(sess-A) 有 task-A1; 渲染时应可见
    expect(result.current.recentTasks.map((t) => t.taskId)).toContain('task-A1')
    // task-B1 注入到 sess-B, 在 sess-A 视图里不出现
    expect(result.current.runningTasks.map((t) => t.taskId)).not.toContain('task-B1')
  })
})
