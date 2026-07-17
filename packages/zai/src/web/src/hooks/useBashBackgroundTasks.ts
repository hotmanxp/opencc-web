import { useEffect, useState } from 'react'
import { listBashTasks, type BashTaskInfo } from '../lib/taskApi.js'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * 当前 session 的 Bash 后台任务。
 *
 * 每 15s 轮询,因为 Bash 任务没有 SSE 事件流推送 (stdout/stderr 在内存 tracker
 * 里,前端要轮询才能拿到最新输出)。
 */
export function useBashBackgroundTasks() {
  const sessionId = useAgentStore((s) => s.sessionId)
  const [tasks, setTasks] = useState<BashTaskInfo[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sessionId) {
      setTasks([])
      return
    }
    let cancelled = false
    let tick = 0
    const refresh = async () => {
      tick++
      const myTick = tick
      try {
        const list = await listBashTasks(sessionId)
        if (cancelled || myTick !== tick) return
        setTasks(list)
      } catch (err) {
        if (!cancelled) console.warn('[useBashBackgroundTasks] refresh failed:', err)
      } finally {
        if (myTick === tick) setLoading(false)
      }
    }
    setLoading(true)
    void refresh()
    const iv = setInterval(() => void refresh(), 15_000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [sessionId])

  return { tasks, loading }
}
