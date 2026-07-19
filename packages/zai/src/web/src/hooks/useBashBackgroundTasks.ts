import { useAgentStore } from '../store/useAgentStore.js'
import type { BashTaskInfo } from '../lib/taskApi.js'

/**
 * 当前 session 的 Bash 后台任务。
 *
 * 100% SSE 推送 (bash_task.changed) — store 由 useEventStream dispatch
 * 通过 applyBashTaskChanged reducer 维护。无冷启动 fallback fetch。
 *
 * 副作用: 切到全新 session 时,cold start 期间返回空数组(直到 BashTool
 * 跑后台命令)。这是有意的 trade-off — 不再用一次性 REST 拉取。
 */
export function useBashBackgroundTasks(): { tasks: BashTaskInfo[]; loading: boolean } {
  const sessionId = useAgentStore((s) => s.sessionId)
  const tasks = useAgentStore((s) =>
    sessionId ? s.bashTasksBySession[sessionId] ?? [] : []
  )
  return { tasks, loading: false }
}