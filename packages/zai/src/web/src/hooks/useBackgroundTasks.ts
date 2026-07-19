import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore.js'
import { useAgentStore } from '../store/useAgentStore.js'
import type { BackgroundTask, TaskStatus } from '../lib/taskApi.js'

/**
 * 后台任务视图。
 *
 * 100% SSE 推送 + jobs lifecycle event 驱动:
 * - useAppStore.jobs (kind='agent_task') 提供 lifecycle (queued / progress / done / failed)
 * - useAgentStore.agentTasksBySession (来自 SSE agent_task.changed) 提供完整 task 快照
 * 两者合并维护本地任务缓存,暴露 selectedId 给 dock/drawer。
 *
 * Session 隔离:每个任务归属到派发它的主 session (= BackgroundTask.parentSessionId)。
 * 只有 useAgentStore.sessionId 与任务归属 sessionId 一致的任务出现在该
 * session 的状态栏里。切到其它 session 后,该 session 派发的 task 不再显示,
 * 避免多个 session 的任务堆积在同一个状态栏里造成噪音。sessionId 缺失的
 * 任务 (resource_refresh / login / install 这类全局任务) 不受 session
 * 过滤影响,继续显示。
 *
 * 切到全新 session 时,cold start 期间返回空数组(SSE agent_task.changed
 * 还没推过来)。这是有意的 trade-off — 不再用 listTasks / fetchTask REST。
 */
export interface BackgroundTaskSummary {
  taskId: string
  status: TaskStatus
  prompt: string
  createdAt: number
  finishedAt?: number
  error?: string
  detail?: BackgroundTask
  /**
   * 该任务最近一次观察到的 sessionId (来自 useAppStore.job.sessionId 或
   * SSE agent_task.changed.event.sessionId). 持久化在任务条目上,
   * 避免 useAppStore 在 job.done 3s 后清理 job + detail 还在路上的窗口
   * 内, session 过滤因 sessionOfTask 查不到而把当前 session 的任务也
   * 隐藏。
   */
  lastKnownSessionId?: string
}

const RECENT_TTL_MS = 60_000

export function useBackgroundTasks() {
  const jobs = useAppStore((s) => s.jobs)
  // 当前正在查看的 session; useAgentStore.sessionId 是 sidebar 选中项,
  // 没有选中 (新建会话占位) 时为 null —— 此时不显示 agent_task 任务。
  const currentSessionId = useAgentStore((s) => s.sessionId)
  // SSE 推送的 agent_task.changed 落到 useAgentStore.agentTasksBySession[sid],
  // 作为本 hook 的 source of truth (按 session 隔离, store 写入与读取按 sid 走)。
  const storeTasks = useAgentStore((s) =>
    currentSessionId ? s.agentTasksBySession[currentSessionId] : undefined,
  )
  const [tasks, setTasks] = useState<Map<string, BackgroundTaskSummary>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailCache = useRef<Map<string, BackgroundTask>>(new Map())

  // 把 store 里 SSE agent_task.changed 推送的全量快照合并进本地 tasks Map。
  // store 是 source of truth, 每次 storeTasks 引用变化就覆盖合并 — 与 jobs
  // effect 互补 (jobs 是 useAppStore 那条独立 lifecycle 通道)。
  useEffect(() => {
    if (!storeTasks) return
    setTasks((prev) => {
      const next = new Map(prev)
      for (const summary of storeTasks) {
        const existing = next.get(summary.taskId)
        // 已存在 → 保留 jobs effect 写入的 live status (jobs 是最即时源),
        // 只补 store 字段 (prompt / detail / lastKnownSessionId);
        // 不存在 → 直接落入。
        if (existing) {
          next.set(summary.taskId, {
            ...existing,
            prompt: summary.prompt || existing.prompt,
            detail: summary.detail ?? existing.detail,
            lastKnownSessionId: summary.lastKnownSessionId ?? existing.lastKnownSessionId,
          })
        } else {
          next.set(summary.taskId, summary)
        }
      }
      return next
    })
  }, [storeTasks])

  // 监听 jobs 中 agent_task 变化,同步到 tasks map。
  // 注意:这里只收集所有 session 的 task,job.sessionId 通过 job 输入时
  // 直接落下。session 过滤在 render 时(runningTasks / recentTasks useMemo)
  // 按 currentSessionId 统一应用 — 这样切换 session 时旧 session 的任务
  // 在 memo 中自动剔除,不会出现 "切到 B 后 A 的任务 残留一段时间" 的时序漏洞。
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

  /**
   * 判断一条任务是否归属当前 session。
   * 数据来源:
   * - useAppStore.job.* 事件流:job.sessionId (server 用 task.parentSessionId 填)
   * - SSE agent_task.changed:event.sessionId
   * - 上一次观察到的归属:task.lastKnownSessionId (持久化在 entry 上, 兜底)
   *
   * 优先级: live job > SSE > lastKnownSessionId. 前两者是最新值,
   * lastKnownSessionId 是兜底, 用于 job 已被 3s 清理 + SSE 还在路上的窗口。
   *
   * 三者都查不到 (sessionId 是 null 或 undefined) → 视为全局任务,
   * 任何 session 都应可见. 这覆盖两种场景:
   *  (1) agent_task 派发时 metadata.parentSessionId 缺失 (老数据 / cli
   *      dispatch / 调度器自己派) → server emit job.* sessionId=null
   *  (2) 调度器自己派的全局子任务, 跟具体 session 解耦
   * 修复 HRMSV3-ZN-WEBSITE#668 同根问题: 之前 return false 会把这类任务
   * 藏起来, dock 看不见.
   *
   * 注: 全局任务 (resource_refresh / login / install) 走 useAppStore.jobs
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
    if (sessionOfTask === undefined) {
      // 三个来源都没拿到 sessionId → 全局任务, 任何 session 都可见
      return true
    }
    // 有明确归属 → 必须与当前 session 匹配
    return currentSessionId !== null && sessionOfTask === currentSessionId
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