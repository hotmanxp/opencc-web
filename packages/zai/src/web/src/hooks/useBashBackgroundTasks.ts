import { useEffect } from 'react'
import { listBashTasks, type BashTaskInfo } from '../lib/taskApi.js'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * 当前 session 的 Bash 后台任务。
 *
 * SSE 推送 (bash_task.changed) 经 useAgentStore.bashTasksBySession 维护。
 * 仅当 store 无值时 fallback 一次性 fetch `/api/bash-tasks?sessionId=...`,
 * 之后完全靠 SSE。
 */
export function useBashBackgroundTasks() {
  const sessionId = useAgentStore((s) => s.sessionId)
  const tasks = useAgentStore((s) =>
    sessionId ? s.bashTasksBySession[sessionId] ?? [] : []
  )
  const has = useAgentStore((s) =>
    sessionId ? sessionId in s.bashTasksBySession : false
  )

  useEffect(() => {
    if (!sessionId || has) return
    let cancelled = false
    void (async () => {
      try {
        const list = await listBashTasks(sessionId)
        if (cancelled) return
        for (const task of list) {
          useAgentStore.getState().applyBashTaskChanged({ sessionId, task })
        }
      } catch (err) {
        if (!cancelled) console.warn('[useBashBackgroundTasks] initial fetch failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, has])

  return { tasks, loading: false }
}