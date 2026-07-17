import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'
import { useAgentStore } from '../store/useAgentStore.js'
import {
  fetchTask,
  listTasks,
  type BackgroundTask,
  type TaskStatus,
} from '../lib/taskApi.js'

/**
 * 后台任务视图。
 * 监听 useAppStore.jobs 中 kind==='agent_task' 的 lifecycle 事件,
 * 维护本地任务缓存(包含完整 task 详情),并暴露 selectedId 给 dock/drawer 使用。
 *
 * 注意:useAppStore 的 job 3 秒后被删除,所以本地缓存延长保留窗口到 60 秒,
 * 让用户可以查看刚刚结束的任务。
 *
 * Session 隔离:每个任务归属到派发它的主 session (= BackgroundTask.parentSessionId)。
 * 只有 useAgentStore.sessionId 与任务归属 sessionId 一致的任务出现在该
 * session 的状态栏里。切到其它 session 后,该 session 派发的 task 不再显示,
 * 避免多个 session 的任务堆积在同一个状态栏里造成噪音。sessionId 缺失的
 * 任务 (resource_refresh / login / install 这类全局任务) 不受 session
 * 过滤影响,继续显示。
 */
export interface BackgroundTaskSummary {
  taskId: string
  status: TaskStatus
  prompt: string
  createdAt: number
  finishedAt?: number
  error?: string
  /** 后端完整 task 详情,延迟加载 */
  detail?: BackgroundTask
  /**
   * 该任务最近一次观察到的 sessionId (来自 useAppStore.job.sessionId 或
   * listTasks / fetchTask 详情.parentSessionId). 持久化在任务条目上,
   * 避免 useAppStore 在 job.done 3s 后清理 job + detail 还在路上的窗口
   * 内, session 过滤因 sessionOfTask 查不到而把当前 session 的任务也
   * 隐藏 (回归: "切 session 后看到 A 的任务" 修复后, 同一个 session
   * 完成的 task 在 3s 后会消失, 直到用户切 session 触发 listTasks).
   */
  lastKnownSessionId?: string
}

const RECENT_TTL_MS = 60_000

export function useBackgroundTasks() {
  const jobs = useAppStore((s) => s.jobs)
  // 当前正在查看的 session; useAgentStore.sessionId 是 sidebar 选中项,
  // 没有选中 (新建会话占位) 时为 null —— 此时不显示 agent_task 任务。
  const currentSessionId = useAgentStore((s) => s.sessionId)
  const [tasks, setTasks] = useState<Map<string, BackgroundTaskSummary>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailCache = useRef<Map<string, BackgroundTask>>(new Map())

  // 监听 jobs 中 agent_task 变化,同步到 tasks map。
  // 注意:这里只收集所有 session 的 task,job.sessionId === task.detail
  // 通过 job 输入时直接落下,从 listTasks / fetchTask 加载时通过
  // detail.parentSessionId 落下。session 过滤在 render 时(runningTasks /
  // recentTasks useMemo)按 currentSessionId 统一应用 — 这样切换 session
  // 时旧 session 的任务在 memo 中自动剔除,不会出现 "切到 B 后 A 的任务
  // 残留一段时间" 的时序漏洞。
  useEffect(() => {
    setTasks((prev) => {
      const next = new Map(prev)
      for (const [, job] of Object.entries(jobs)) {
        if (job.kind !== 'agent_task') continue
        const taskId = job.jobId
        const existing = next.get(taskId)
        let status: TaskStatus = 'queued'
        if (job.error) status = 'failed'
        else if (job.done) status = 'completed'
        const liveSessionId = typeof job.sessionId === 'string' ? job.sessionId : undefined
        next.set(taskId, {
          taskId,
          status,
          prompt: existing?.prompt ?? '',
          createdAt: existing?.createdAt ?? Date.now(),
          finishedAt: job.done || job.error ? Date.now() : existing?.finishedAt,
          error: job.error ?? existing?.error,
          detail: existing?.detail,
          // 持久化最后一次观察到的 sessionId, 供 job 清理后兜底
          lastKnownSessionId: liveSessionId ?? existing?.lastKnownSessionId,
        })
      }
      // 清理过期的 recent 任务(超过 60 秒)
      const now = Date.now()
      for (const [id, t] of next.entries()) {
        const ended = t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
        if (ended && t.finishedAt && now - t.finishedAt > RECENT_TTL_MS) next.delete(id)
      }
      return next
    })
  }, [jobs])

  // 初次加载 + 拉详情。
  // 把所有 session 的任务都进 map,session 过滤在 render 时统一应用。
  // 切 session 触发 effect 重跑 — 但 listTasks() 不重发请求,而是补 fetch
  // 缺失的 detail.parentSessionId (重新 query 时,某些 task 的 detail 可能
  // 已经丢失,例如服务重启导致 in-memory tasks map 蒸发)。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const initial = await listTasks({ limit: 50 })
        if (cancelled) return
        for (const t of initial) {
          detailCache.current.set(t.id, t)
          setTasks((prev) => {
            const next = new Map(prev)
            const existing = next.get(t.id)
            const detailSessionId = typeof t.parentSessionId === 'string' ? t.parentSessionId : undefined
            if (!existing || (existing.status !== t.status && t.status !== 'running')) {
              next.set(t.id, {
                taskId: t.id,
                status: t.status,
                prompt: t.input.prompt,
                createdAt: t.createdAt,
                finishedAt: t.finishedAt,
                error: t.error?.message,
                detail: t,
                lastKnownSessionId: detailSessionId ?? existing?.lastKnownSessionId,
              })
            } else if (existing) {
              next.set(t.id, {
                ...existing,
                prompt: t.input.prompt,
                detail: t,
                lastKnownSessionId: detailSessionId ?? existing.lastKnownSessionId,
              })
            }
            return next
          })
        }
      } catch (err) {
        console.warn('[useBackgroundTasks] initial load failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentSessionId])

  // 当 summary 没 detail 时拉详情
  const missingDetail = useMemo(() => {
    const out: string[] = []
    for (const [id, t] of tasks.entries()) {
      if (!t.detail && !detailCache.current.has(id)) out.push(id)
    }
    return out
  }, [tasks])

  useEffect(() => {
    if (missingDetail.length === 0) return
    let cancelled = false
    void (async () => {
      for (const id of missingDetail) {
        try {
          const t = await fetchTask(id)
          if (cancelled || !t) continue
          detailCache.current.set(id, t)
          setTasks((prev) => {
            const next = new Map(prev)
            const existing = next.get(id)
            if (existing) {
              const detailSessionId = typeof t.parentSessionId === 'string' ? t.parentSessionId : undefined
              next.set(id, {
                ...existing,
                prompt: t.input.prompt,
                status: t.status,
                finishedAt: t.finishedAt,
                error: t.error?.message,
                detail: t,
                lastKnownSessionId: detailSessionId ?? existing.lastKnownSessionId,
              })
            }
            return next
          })
        } catch (err) {
          console.warn('[useBackgroundTasks] fetch detail failed:', id, err)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [missingDetail])

  /**
   * 判断一条任务是否归属当前 session。
   * 三个数据来源的归属字段:
   * - useAppStore.job.* 事件流:job.sessionId (server 用 task.parentSessionId 填)
   * - listTasks / fetchTask 详情:task.parentSessionId (顶层字段)
   * - 上一次观察到的归属:task.lastKnownSessionId (持久化在 entry 上, 兜底)
   *
   * 优先级: live job > detail.parentSessionId > lastKnownSessionId. 前两
   * 者是最新值, lastKnownSessionId 是兜底, 用于 job 已被 3s 清理 + detail
   * 还在路上的窗口, 让"当前 session 完成的 task 不会突然消失".
   *
   * 三者都查不到 (极少见, e.g. AgentTool 没传 parentSessionId 且 detail
   * 还没回来且 job 也被清了) → 不显示, 避免泄露到其他 session.
   * 全局任务 (resource_refresh / login / install) 走 useAppStore.jobs
   * 直接渲染, 不进这个 hook 的 agent_task 过滤, 不受影响.
   */
  const belongsToCurrentSession = (t: BackgroundTaskSummary): boolean => {
    const liveJob = jobs[t.taskId]
    const liveSession = liveJob?.sessionId
    const detailSession = t.detail?.parentSessionId
    const sessionFromJob =
      typeof liveSession === 'string' ? liveSession : undefined
    const sessionFromDetail =
      typeof detailSession === 'string' ? detailSession : undefined
    const sessionOfTask = sessionFromJob ?? sessionFromDetail ?? t.lastKnownSessionId
    if (sessionOfTask !== undefined) {
      return currentSessionId !== null && sessionOfTask === currentSessionId
    }
    return false
  }

  const runningTasks = useMemo(
    () =>
      Array.from(tasks.values())
        .filter((t) => t.status === 'running' || t.status === 'queued')
        .filter(belongsToCurrentSession),
    [tasks, currentSessionId, jobs],
  )
  const recentTasks = useMemo(
    () =>
      Array.from(tasks.values())
        .filter((t) => t.status !== 'running' && t.status !== 'queued')
        .filter(belongsToCurrentSession),
    [tasks, currentSessionId, jobs],
  )

  return {
    tasks: Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt),
    runningTasks,
    recentTasks,
    selectedId,
    select: setSelectedId,
    getDetail: (id: string) => detailCache.current.get(id),
  }
}