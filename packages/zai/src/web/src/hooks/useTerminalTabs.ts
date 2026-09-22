import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  type TerminalEnvironment,
  type TerminalShell,
  type WebTerminalInfo,
} from '../../../shared/terminal.js'
import {
  closeTerminal,
  createTerminal,
  fetchTerminalEnvironment,
  fetchTerminalList,
  fetchTerminalShells,
  renameTerminal,
  TerminalApiError,
} from '../lib/terminalApi.js'
import { STORAGE_KEYS, useLocalStorageState } from '../components/splitPane/shared.js'

/**
 * 分屏 Bash 面板的终端 tab 集合管理。
 *
 * 与 dsh 客户端的差异：**服务端是 tab 集合的唯一真相**（不再往 localStorage 写
 * contentId → WebTerminalId 绑定、也没有待关重试队列）——刷新后 GET
 * /api/terminal/list 就能把活着的终端重新播成 tab，并重连到同一批 PTY。
 * localStorage 只记"当前看的是哪一个"。
 *
 * 连接预算：HTTP/1.1 同源并发连接有限（agent 流 + bash-tasks 流已占用数条），
 * 因此**只有可见的 tab 开 SSE**（由 TerminalView 按 visible 决定），切 tab 时
 * 新连接以整屏 snapshot 起手，画面立即恢复。
 */

/** 终端 id：仅允许 [\w-]，服务端用 /^[\w-]{1,128}$/ 校验。 */
function newTerminalId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `t-${rand}`
}

export interface TerminalTabsState {
  /** 该会话保留的终端（含已退出的）。 */
  terminals: WebTerminalInfo[]
  activeId: string | null
  /** 环境与上限；未加载完为 null。 */
  environment: TerminalEnvironment | null
  shells: TerminalShell[]
  /** 面板级错误（加载失败 / 新建被拒等），null 表示无错误。 */
  error: string | null
  /** 错误附带的修复提示（如 node-pty 未安装）。 */
  errorHint: string | null
  ready: boolean
  setActive: (id: string) => void
  create: (shellPath?: string) => Promise<void>
  close: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /** TerminalView 收到 snapshot / state 帧后回填，保持 tab 条状态与终端一致。 */
  applyInfo: (info: WebTerminalInfo) => void
  retry: () => void
}

export function useTerminalTabs(sessionId: string | null, cwd: string | null): TerminalTabsState {
  const [terminals, setTerminals] = useState<WebTerminalInfo[]>([])
  const [environment, setEnvironment] = useState<TerminalEnvironment | null>(null)
  const [shells, setShells] = useState<TerminalShell[]>([])
  const [error, setError] = useState<string | null>(null)
  const [errorHint, setErrorHint] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [activeStored, setActiveStored] = useLocalStorageState<string | null>(
    STORAGE_KEYS.terminalTab,
    null,
  )
  // cwd 走 ref：加载 effect 只依赖 sessionId，避免切目录时把已有 tab 清空重建。
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // 首次挂载时列表为空 → 自动开一个默认 shell，点进 Bash 就有终端可用。
  // ref 保证"本次挂载只自动建一次"（手动关掉最后一个 tab 后不再自动补）。
  const autoCreatedRef = useRef(false)

  const fail = useCallback((err: unknown): void => {
    if (err instanceof TerminalApiError) {
      setError(err.message)
      setErrorHint(err.hint ?? null)
      return
    }
    setError((err as Error)?.message ?? String(err))
    setErrorHint(null)
  }, [])

  const reload = useCallback(
    async (targetSessionId: string): Promise<void> => {
      const [env, shellList, list] = await Promise.all([
        fetchTerminalEnvironment(cwdRef.current),
        fetchTerminalShells(),
        fetchTerminalList(targetSessionId),
      ])
      setEnvironment(env)
      setShells(shellList)
      setTerminals(list)
      if (list.length === 0 && env.available && !autoCreatedRef.current) {
        autoCreatedRef.current = true
        const info = await createTerminal({
          sessionId: targetSessionId,
          id: newTerminalId(),
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS,
          ...(cwdRef.current ? { cwd: cwdRef.current } : {}),
        })
        setTerminals([info])
      }
    },
    [],
  )

  useEffect(() => {
    if (!sessionId) {
      setTerminals([])
      setEnvironment(null)
      setShells([])
      setReady(false)
      autoCreatedRef.current = false
      return
    }
    let cancelled = false
    setReady(false)
    autoCreatedRef.current = false
    void reload(sessionId)
      .catch((err: unknown) => {
        if (!cancelled) fail(err)
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, generation, reload, fail])

  // activeId 必须总是指向一个存在的终端：新建/关闭后自动落到第一个。
  const activeId = terminals.some((t) => t.id === activeStored) ? activeStored : (terminals[0]?.id ?? null)
  useEffect(() => {
    if (activeId !== activeStored) setActiveStored(activeId)
  }, [activeId, activeStored, setActiveStored])

  const create = useCallback(
    async (shellPath?: string): Promise<void> => {
      if (!sessionId) return
      const current = terminals.find((t) => t.id === activeId)
      try {
        const info = await createTerminal({
          sessionId,
          id: newTerminalId(),
          cols: current?.cols ?? DEFAULT_TERMINAL_COLS,
          rows: current?.rows ?? DEFAULT_TERMINAL_ROWS,
          ...(shellPath ? { shellPath } : {}),
          ...(cwdRef.current ? { cwd: cwdRef.current } : {}),
        })
        setTerminals((prev) => [...prev, info])
        setActiveStored(info.id)
        setError(null)
        setErrorHint(null)
      } catch (err) {
        fail(err)
      }
    },
    [sessionId, terminals, activeId, setActiveStored, fail],
  )

  const close = useCallback(
    async (id: string): Promise<void> => {
      if (!sessionId) return
      try {
        await closeTerminal(sessionId, id)
        setTerminals((prev) => prev.filter((t) => t.id !== id))
      } catch (err) {
        fail(err)
      }
    },
    [sessionId, fail],
  )

  const rename = useCallback(
    async (id: string, title: string): Promise<void> => {
      if (!sessionId) return
      const trimmed = title.trim()
      if (!trimmed) return
      const previous = terminals
      setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, title: trimmed } : t)))
      try {
        await renameTerminal(sessionId, id, trimmed)
      } catch (err) {
        setTerminals(previous)
        fail(err)
      }
    },
    [sessionId, terminals, fail],
  )

  const applyInfo = useCallback((info: WebTerminalInfo): void => {
    setTerminals((prev) => prev.map((t) => (t.id === info.id ? info : t)))
  }, [])

  const retry = useCallback((): void => {
    setError(null)
    setErrorHint(null)
    setGeneration((n) => n + 1)
  }, [])

  const setActive = useCallback(
    (id: string): void => {
      setActiveStored(id)
    },
    [setActiveStored],
  )

  return {
    terminals,
    activeId,
    environment,
    shells,
    error,
    errorHint,
    ready,
    setActive,
    create,
    close,
    rename,
    applyInfo,
    retry,
  }
}