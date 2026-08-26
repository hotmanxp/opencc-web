import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ReplEvent,
  ExecRequest,
  ExecResult,
  TopCommandEntry,
} from '../../../shared/repl.js'
import { execRepl, abortRepl, replEventsUrl } from '../lib/bashReplApi.js'
import { fetchTopCommands } from '../lib/replHistoryApi.js'

export interface UseBashReplResult {
  events: ReplEvent[]
  busy: boolean
  currentExecId: string | null
  connected: boolean
  /** 全局命令历史 top10(plan §4 Task 4)。 */
  topCommands: TopCommandEntry[]
  /** 手动刷新 topCommands(供 BashTab 选中/执行后调用)。 */
  refreshTopCommands: () => Promise<void>
  /**
   * 触发一次命令执行。opts.wait:true 时 await 服务端真实终态,返回值包含
   * code/signal/durationMs(MobileQuickDrawer 决定 success/error toast 用);
   * 默认 false (fire-and-forget),返回值只有 execId。
   */
  exec: (command: string, opts?: { wait?: boolean }) => Promise<ExecResult>
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
  const [topCommands, setTopCommands] = useState<TopCommandEntry[]>([])
  const eventsRef = useRef<ReplEvent[]>([])
  const execIdRef = useRef<string | null>(null)
  const topCommandsRef = useRef<TopCommandEntry[]>([])

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

  // 拉全局 top10 — sessionId 建立后跑一次（plan §4 Task 4）。
  // fire-and-forget:失败静默保留空数组,BashTab 仍然可用。
  useEffect(() => {
    if (!sessionId) {
      setTopCommands([])
      topCommandsRef.current = []
      return
    }
    let cancelled = false
    fetchTopCommands()
      .then((resp) => {
        if (cancelled) return
        topCommandsRef.current = resp.entries
        setTopCommands(resp.entries)
      })
      .catch(() => {
        /* swallow — 拉取失败不影响 hook 正常使用 */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const refreshTopCommands = useCallback(async () => {
    try {
      const resp = await fetchTopCommands()
      topCommandsRef.current = resp.entries
      setTopCommands(resp.entries)
    } catch {
      /* swallow */
    }
  }, [])

  const exec = useCallback(
    async (command: string, opts: { wait?: boolean } = {}): Promise<ExecResult> => {
      if (!sessionId) return { ok: false, busy: true, currentExecId: 'no-session' }
      const body: ExecRequest = { command, cwd: defaultCwd ?? undefined }
      const result = await execRepl(sessionId, body, opts)
      if (result.ok) {
        setBusy(true)
        setCurrentExecId(result.execId)
        execIdRef.current = result.execId
        // 后台异步刷新 topCommands:命令已写入历史(JSONL append 已落盘),
        // 但 server 5min cache 还没失效,手动触发一次刷新让 UI 立刻反映。
        void refreshTopCommands()
      }
      return result
    },
    [sessionId, defaultCwd, refreshTopCommands],
  )

  const abort = useCallback(async () => {
    if (!sessionId) return
    await abortRepl(sessionId)
  }, [sessionId])

  const clear = useCallback(() => {
    setEvents([])
    eventsRef.current = []
  }, [])

  return {
    events,
    busy,
    currentExecId,
    connected,
    topCommands,
    refreshTopCommands,
    exec,
    abort,
    clear,
  }
}