/**
 * dsh-019 Phase 2: dsh-mode subagent 任务 React Hook(100% SSE 驱动)。
 *
 * 数据源:useAgentStore.subagentTasksBySession[sessionId] — 由 zai-side
 * useEventStream 收到 server 'subagent.changed' SSE 事件后写入。
 * 无 5s 轮询(对齐 useBashBackgroundTasks / useBackgroundTasks 的
 * "100% SSE 推送" 设计)。
 *
 * sessionId 过滤:只返回当前 session 派生的 subagent(对齐 zai compat
 *  subagent_control.list_agents 行为 + dsh-bridge 持久化用 parentSessionId
 *  拆桶)。
 *
 * opencc 模式:useAgentStore.subagentTasksBySession 永远空(后端 zai
 *  dsh factory 不会 emit subagent.changed),hook 返空数组。SSE 也
 * 不会推(与 dsh factory 注入的 __zaiDshSubagentControl 桥接相关)。
 *
 * Cold start 兜底:第一次打开新 session 时,server SSE 连接建立中,
 *  store 还没收到 subagent.changed — 同步 fetch /api/subagent-tasks
 *  拉一次历史(SSE 连接建立后由 hydrateSessionState 补 4 字段快照,
 *  但 subagent_tasks 暂未进 cold-state 协议 — Phase 2 简化用 REST
 *  fallback,Phase 3 可加 cold-state subagent_tasks 字段)。
 */

import { useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import type { DshSubagentTaskItem } from '../store/useAgentStore.js'

// 兼容老代码:hook 导出 DshSubagentTask 类型同 DshSubagentTaskItem shape
export type DshSubagentTask = DshSubagentTaskItem

/** Phase 3 P0-B: mode 选项 — 'current'(默认)只显示当前 session,'all' 跨 session。 */
export type SubagentTasksMode = 'current' | 'all'

/**
 * 2026-08-24 Blocker D: server `/api/subagent-tasks` 返回的 shape 用
 * `taskId` 字段,而 client `DshSubagentTaskItem` 期望 `id` + `taskId`
 * 双字段(`useAgentStore.ts:69-87`)。`SubagentsTab.tsx:102` 与
 * `SubagentDetailBody.tsx:330` 都用 `task.id` 找 row / 找 task — 不归一
 * 化的话,server response 一进 store 就 `id === undefined`,row 不渲染。
 *
 * 同时归一化 `description` ↔ `prompt`(server 返回 `description`,但 DSH
 * 落盘原始字段是 `prompt`)。
 *
 * 暴露为 named export 是为了让单测能直接 import 验证。
 */
export function normalizeTask(raw: unknown): DshSubagentTaskItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.taskId === 'string' ? r.taskId
    : typeof r.id === 'string' ? r.id
    : undefined
  if (!id) return null
  const taskId = typeof r.taskId === 'string' ? r.taskId : id
  const description = typeof r.description === 'string'
    ? r.description
    : typeof r.prompt === 'string'
      ? r.prompt.slice(0, 80)
      : undefined
  const status = (typeof r.status === 'string'
    ? r.status
    : 'running') as DshSubagentTaskItem['status']
  const state = (typeof r.state === 'string'
    ? r.state
    : status === 'running'
      ? 'running'
      : 'settled') as DshSubagentTaskItem['state']
  return {
    id,
    taskId,
    status,
    description,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
    ...(typeof r.parentSessionId === 'string'
      ? { parentSessionId: r.parentSessionId }
      : {}),
    ...(typeof r.provider === 'string' ? { provider: r.provider } : {}),
    state,
    ...(typeof r.startedAt === 'number' ? { startedAt: r.startedAt } : {}),
    ...(typeof r.finishedAt === 'number' ? { finishedAt: r.finishedAt } : {}),
    ...(typeof r.stopReason === 'string' ? { stopReason: r.stopReason } : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {}),
  }
}

export function useSubagentTasks(opts?: { mode?: SubagentTasksMode }): {
  tasks: DshSubagentTaskItem[]
  loading: boolean
  error: string | null
  refresh: () => void
} {
  const mode = opts?.mode ?? 'current'
  const sessionId = useAgentStore((s) => s.sessionId)
  // 100% SSE 推送: 从 store 读,useAgentStore 已经在 useEventStream
  // 收到 'subagent.changed' 时更新 subagentTasksBySession[sessionId]。
  // zustand selector 自动订阅,subagent 状态变化时组件 re-render。
  //
  // Phase 3 P0-B: 'all' 模式时,SSE 只推当前 session;跨 session 视图
  // 走另一条 path(allCache)— 见 useEffect fallback。
  const currentSessionTasks = useAgentStore((s) =>
    sessionId ? s.subagentTasksBySession[sessionId] ?? EMPTY : EMPTY
  )

  // Phase 3 P0-B: 'all' 模式的跨 session 任务缓存。
  const [allCache, setAllCache] = useState<DshSubagentTaskItem[]>(EMPTY)
  const [allLoading, setAllLoading] = useState(false)
  const [allError, setAllError] = useState<string | null>(null)
  const [, setRefreshTick] = useState(0)

  // Cold-start fallback: 切到全新 session(无 SSE 推送过的历史)时,拉一次
  // REST 兜底。useEffect 只在 sessionId 变化时跑一次,后续 SSE 持续更新。
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (mode === 'all') {
      // 'all' 模式 — 拉全 session 任务,不带 sessionId。
      let cancelled = false
      setAllLoading(true)
      fetch('/api/subagent-tasks?allSessions=true')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data: { tasks: unknown[] }) => {
          if (cancelled) return
          // 2026-08-24 Blocker D: server response 用 taskId 字段 — 归一化为 client 期望的 id + taskId。
          const normalized = (data.tasks ?? [])
            .map((t) => normalizeTask(t))
            .filter((t): t is DshSubagentTaskItem => t !== null)
          setAllCache(normalized)
          setAllError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setAllError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setAllLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    if (!sessionId) return
    // 'current' 模式 — 仅在 store 已空(还没 SSE 推送过)时拉一次,
    // 避免重复打 server
    const list = useAgentStore.getState().subagentTasksBySession[sessionId]
    if (list !== undefined) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/subagent-tasks?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { tasks: unknown[] }) => {
        if (cancelled) return
        // 2026-08-24 Blocker D: 同 'all' 模式归一化。
        const normalized = (data.tasks ?? [])
          .map((t) => normalizeTask(t))
          .filter((t): t is DshSubagentTaskItem => t !== null)
        // 直接 set store(对齐 cold-state hydrate 模式)— 后续 SSE 推送会
        // 通过 applySubagentChanged reducer 继续合并,不会覆盖。
        useAgentStore.setState((s) => ({
          subagentTasksBySession: { ...s.subagentTasksBySession, [sessionId]: normalized },
        }))
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 503 dsh_subagent_unavailable(opencc 模式) — 静默空
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, mode])

  // refresh() — 强制重拉。'all' 模式重新触发 fetch;'current' 模式
  // 仅递增 tick 触发 useEffect 重跑(useEffect 已依赖 sessionId)。
  return {
    tasks: mode === 'all' ? allCache : currentSessionTasks,
    loading: mode === 'all' ? allLoading : loading,
    error: mode === 'all' ? allError : error,
    refresh: () => setRefreshTick((n) => n + 1),
  }
}

const EMPTY: DshSubagentTaskItem[] = []

/**
 * 中止一个 dsh subagent 任务(走 POST /api/subagent-tasks/:id/interrupt)。
 * 与 useSubagentTasks 一样在 dsh-bridge subagent 端点不可用时返回 503。
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

/**
 * dsh-019 Phase 2: 给运行中的子 agent 投消息(走
 * POST /api/subagent-tasks/:id/send-message)。消息会被 dsh-bridge 包装成
 * createUserMessage 通过 ctx.agents.get(sid).followup 推入子 agent 下一轮 turn。
 * 已结束的任务返回 409(由后端检查)。
 */
export async function sendMessageToSubagentTask(
  taskId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(
      `/api/subagent-tasks/${encodeURIComponent(taskId)}/send-message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      },
    )
    if (!r.ok) {
      const body = await r.text()
      return { ok: false, error: `HTTP ${r.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
