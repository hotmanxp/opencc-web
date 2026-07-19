import { useEffect } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * 读取当前 session 的 cwd。
 *
 * SSE 推送 (cwd.changed) 经 useAgentStore.cwdBySession 维护。
 * 仅当 store 无值时(冷启动 / 服务重启后第一次进 session)才 fallback
 * 一次性 fetch `/api/agent/sessions/:id/pwd` 拉一次,之后完全靠 SSE。
 */
export function useSessionCwd(sessionId: string | null): string | undefined {
  const cwd = useAgentStore((s) => (sessionId ? s.cwdBySession[sessionId] : undefined))
  const has = useAgentStore((s) => (sessionId ? sessionId in s.cwdBySession : false))

  useEffect(() => {
    if (!sessionId || has) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${sessionId}/pwd`)
        if (!res.ok) return
        const data = (await res.json()) as { cwd?: string }
        if (!cancelled && typeof data.cwd === 'string') {
          useAgentStore.getState().applyCwdChanged({ sessionId, cwd: data.cwd })
        }
      } catch {
        // silent
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, has])

  return cwd
}