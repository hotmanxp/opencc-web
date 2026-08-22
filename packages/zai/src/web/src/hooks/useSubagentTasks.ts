/**
 * dsh-019: dsh-mode subagent 任务 React Hook。
 *
 * 数据源:GET /api/subagent-tasks?sessionId=xxx(对齐 bash-tasks 端点)。
 * 5s 轮询(Phase 1 简化方案;Phase 2 可改 SSE 推送 — zai dsh factory 已
 *  emit `subagent.changed` 事件到 eventBus,但 web 端 useEventStream
 *  reducer 还没派发到独立 store slot)。
 *
 * sessionId 过滤:只返回当前 session 派生的 subagent(对齐 zai compat
 *  subagent_control.list_agents 行为 + dsh-bridge 持久化用 parentSessionId
 *  拆桶)。
 *
 * opencc 模式:useSubagentTasks 永远返回空数组(后端 /api/subagent-tasks
 * 返回 503)。Bash 任务仍走 useBashBackgroundTasks,不影响。
 */

import { useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'

export interface DshSubagentTask {
  id: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  description?: string
}

const POLL_INTERVAL_MS = 5_000

export function useSubagentTasks(): {
  tasks: DshSubagentTask[]
  loading: boolean
  error: string | null
  refresh: () => void
} {
  const sessionId = useAgentStore((s) => s.sessionId)
  const [tasks, setTasks] = useState<DshSubagentTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // refresh 计数器 — 外部 button 调 refresh() 可触发立即重新 fetch
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!sessionId) {
      setTasks([])
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/subagent-tasks?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => {
        if (!r.ok) {
          // 503 dsh_subagent_unavailable(opencc 模式)或 4xx 错误 — 当作空
          if (r.status === 503) {
            if (!cancelled) {
              setTasks([])
              setError(null)
            }
            return null
          }
          throw new Error(`HTTP ${r.status}`)
        }
        return r.json() as Promise<{ tasks: DshSubagentTask[] }>
      })
      .then((data) => {
        if (cancelled) return
        if (data) setTasks(data.tasks ?? [])
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, tick])

  // 5s 轮询(Phase 1 简化,Phase 2 改 SSE)
  useEffect(() => {
    if (!sessionId) return
    const interval = setInterval(() => setTick((n) => n + 1), POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [sessionId])

  return {
    tasks,
    loading,
    error,
    refresh: () => setTick((n) => n + 1),
  }
}

/**
 * 中止一个 dsh subagent 任务(走 POST /api/subagent-tasks/:id/interrupt)。
 */
export async function interruptSubagentTask(taskId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/subagent-tasks/${encodeURIComponent(taskId)}/interrupt`, {
      method: 'POST',
    })
    if (!r.ok) {
      const body = await r.text()
      return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
