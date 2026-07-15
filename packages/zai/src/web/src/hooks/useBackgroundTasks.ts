import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'
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
}

const RECENT_TTL_MS = 60_000

export function useBackgroundTasks() {
  const jobs = useAppStore((s) => s.jobs)
  const [tasks, setTasks] = useState<Map<string, BackgroundTaskSummary>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailCache = useRef<Map<string, BackgroundTask>>(new Map())

  // 监听 jobs 中 agent_task 变化,同步到 tasks map
  useEffect(() => {
    setTasks((prev) => {
      const next = new Map(prev)
      for (const [, job] of Object.entries(jobs)) {
        if (job.kind !== 'agent_task') continue
        // jobId === taskId (BackgroundRuntime 装饰层把 jobId 设成 taskId)
        const taskId = job.jobId
        const existing = next.get(taskId)
        let status: TaskStatus = 'queued'
        if (job.error) status = 'failed'
        else if (job.done) status = 'completed'
        next.set(taskId, {
          taskId,
          status,
          prompt: existing?.prompt ?? '',
          createdAt: existing?.createdAt ?? Date.now(),
          finishedAt: job.done || job.error ? Date.now() : existing?.finishedAt,
          error: job.error ?? existing?.error,
          detail: existing?.detail,
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

  // 初次加载 + 拉详情
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
            if (!existing || (existing.status !== t.status && t.status !== 'running')) {
              next.set(t.id, {
                taskId: t.id,
                status: t.status,
                prompt: t.input.prompt,
                createdAt: t.createdAt,
                finishedAt: t.finishedAt,
                error: t.error?.message,
                detail: t,
              })
            } else if (existing) {
              next.set(t.id, { ...existing, prompt: t.input.prompt, detail: t })
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
  }, [])

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
              next.set(id, {
                ...existing,
                prompt: t.input.prompt,
                status: t.status,
                finishedAt: t.finishedAt,
                error: t.error?.message,
                detail: t,
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

  const runningTasks = useMemo(
    () => Array.from(tasks.values()).filter((t) => t.status === 'running' || t.status === 'queued'),
    [tasks],
  )
  const recentTasks = useMemo(
    () => Array.from(tasks.values()).filter((t) => t.status !== 'running' && t.status !== 'queued'),
    [tasks],
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