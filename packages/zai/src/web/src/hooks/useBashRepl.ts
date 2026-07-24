import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReplEvent, ExecRequest, ExecResult } from '../../../shared/repl.js'
import { execRepl, abortRepl, replEventsUrl } from '../lib/bashReplApi.js'

export interface UseBashReplResult {
  events: ReplEvent[]
  busy: boolean
  currentExecId: string | null
  connected: boolean
  exec: (command: string) => Promise<ExecResult>
  abort: () => Promise<void>
  clear: () => void
}

export function useBashRepl(
  sessionId: string | null,
  defaultCwd: string | null,
): UseBashReplResult {
  const [events, setEvents] = useState<ReplEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [currentExecId, setCurrentExecId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const eventsRef = useRef<ReplEvent[]>([])
  const execIdRef = useRef<string | null>(null)

  // SSE 连接管理 — sessionId 变化关闭旧连接、建新的；events 清空。
  useEffect(() => {
    if (!sessionId) return
    const es = new EventSource(replEventsUrl(sessionId))
    setConnected(false)
    setEvents([])
    eventsRef.current = []
    execIdRef.current = null
    setBusy(false)
    setCurrentExecId(null)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as ReplEvent
        eventsRef.current = [...eventsRef.current, data]
        setEvents(eventsRef.current)
        if (data.kind === 'exit' || data.kind === 'error') {
          setBusy(false)
          setCurrentExecId(null)
          execIdRef.current = null
        }
      } catch {
        /* 忽略非 JSON 行（心跳注释等） */
      }
    }

    return () => {
      es.close()
    }
  }, [sessionId])

  const exec = useCallback(
    async (command: string): Promise<ExecResult> => {
      if (!sessionId) return { ok: false, busy: true, currentExecId: 'no-session' }
      const body: ExecRequest = { command, cwd: defaultCwd ?? undefined }
      const result = await execRepl(sessionId, body)
      if (result.ok) {
        setBusy(true)
        setCurrentExecId(result.execId)
        execIdRef.current = result.execId
      }
      return result
    },
    [sessionId, defaultCwd],
  )

  const abort = useCallback(async () => {
    if (!sessionId) return
    await abortRepl(sessionId)
  }, [sessionId])

  const clear = useCallback(() => {
    setEvents([])
    eventsRef.current = []
  }, [])

  return { events, busy, currentExecId, connected, exec, abort, clear }
}