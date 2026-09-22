import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalFrame, WebTerminalInfo } from '../../../../shared/terminal.js'
import { resizeTerminal, terminalEventsUrl, writeTerminal } from '../../lib/terminalApi.js'
import { readTerminalTheme } from './terminalTheme.js'
import '@xterm/xterm/css/xterm.css'

/**
 * 一个持久 PTY 终端的 xterm 视图。
 * 移植自 deepseek-harness `packages/client/ui-sidebar-terminal/src/client/terminal.tsx`
 * （裁掉 attachment writable/retain 门控）。
 *
 * 三条 effect 分工（互不重建 xterm）：
 *   1. 挂载一次：建 xterm + FitAddon + onData → /write + 跟随 data-theme
 *   2. `visible` 为真才开 SSE（连接预算，见 useTerminalTabs 头注）
 *   3. `visible` 为真才观测尺寸并 fit；隐藏时只跟随后端尺寸
 *
 * 卸载**不**关闭终端 —— 只有关 tab 才 kill 进程（收起分屏 / 切 tab / 刷新
 * 都应保留 shell），与 dsh 的 "collapse 不杀、reload 重连同一进程" 一致。
 */

export interface TerminalViewProps {
  sessionId: string
  info: WebTerminalInfo
  /** 是否是当前选中的 tab；隐藏的 tab 不占 SSE 连接。 */
  visible: boolean
  maxCols: number
  maxRows: number
  scrollback: number
  /** 收到 snapshot / state 帧后回填 tab 条（标题、尺寸、running/exited）。 */
  onInfo: (info: WebTerminalInfo) => void
}

type Connection = { kind: 'connecting' } | { kind: 'live' } | { kind: 'exited' } | { kind: 'error'; message: string }

/** rAF 合帧：高频输出攒到下一帧一次性写入，避免每 chunk 一次重排。 */
function scheduleFlush(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(handle)
  }
  const handle = setTimeout(callback, 16)
  return () => clearTimeout(handle)
}

export function TerminalView({
  sessionId,
  info,
  visible,
  maxCols,
  maxRows,
  scrollback,
  onInfo,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const pendingRef = useRef('')
  const cancelFlushRef = useRef<(() => void) | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [connection, setConnection] = useState<Connection>({ kind: 'connecting' })
  const [retryToken, setRetryToken] = useState(0)

  // 所有异步回调只从 ref 读最新值，避免把 props 挂进 effect 依赖导致 xterm 重建。
  const targetRef = useRef({ sessionId, id: info.id })
  targetRef.current = { sessionId, id: info.id }
  const onInfoRef = useRef(onInfo)
  onInfoRef.current = onInfo
  const limitsRef = useRef({ maxCols, maxRows })
  limitsRef.current = { maxCols, maxRows }
  const scrollbackRef = useRef(scrollback)

  /** 立即写屏（snapshot 用，不等合帧）。 */
  const writeNow = useCallback((data: string): void => {
    termRef.current?.write(data)
  }, [])

  /** 合帧写屏（output 用）。 */
  const writeCoalesced = useCallback((data: string): void => {
    pendingRef.current += data
    if (cancelFlushRef.current) return
    cancelFlushRef.current = scheduleFlush(() => {
      cancelFlushRef.current = null
      const buffered = pendingRef.current
      pendingRef.current = ''
      if (buffered) termRef.current?.write(buffered)
    })
  }, [])

  /**
   * 帧里的终端状态 → xterm 门控：同步尺寸、退出后禁写、回填 tab 条。
   * 单一实现点，snapshot / state 两条路径共用（尺寸与"还能不能输入"必须一致）。
   */
  const applyInfoToTerm = useCallback((next: WebTerminalInfo): void => {
    const term = termRef.current
    if (!term) return
    if (term.cols !== next.cols || term.rows !== next.rows) term.resize(next.cols, next.rows)
    term.options.disableStdin = next.state !== 'running'
    onInfoRef.current(next)
  }, [])

  // 1) xterm 生命周期（挂载一次）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: scrollbackRef.current,
      minimumContrastRatio: 4.5,
      theme: readTerminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    const input = term.onData((data) => {
      const target = targetRef.current
      void writeTerminal(target.sessionId, target.id, data).catch(() => {
        /* 终端可能刚好退出：忽略，后续 state 帧会把 UI 切到 exited */
      })
    })
    // 应用主题切换（App.tsx 写在 <html data-theme>）时刷新 xterm 调色板。
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      themeObserver.disconnect()
      input.dispose()
      cancelFlushRef.current?.()
      cancelFlushRef.current = null
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      pendingRef.current = ''
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // 终端已退出 → 禁写。这里覆盖「刷新后从 /list 恢复出一个已退出的 tab」的情况
  // （那种终端不会开 SSE，所以拿不到 state 帧）；运行中退出走 applyInfoToTerm。
  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = info.state !== 'running'
    if (info.state !== 'running') setConnection({ kind: 'exited' })
  }, [info.state])

  // 2) SSE：只给可见 tab 开流；首帧是整屏 snapshot。
  // 已退出的终端也要开一次：服务端会「交付快照后立即结束」，正好用来恢复
  // 退出前的最后一屏（服务端在关闭时同步推送了一次 unread drain，见 PtySession.finish）。
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    if (!term) return
    const target = targetRef.current
    setConnection({ kind: 'connecting' })
    const source = new EventSource(terminalEventsUrl(target.sessionId, target.id))
    source.onopen = () => setConnection((prev) => (prev.kind === 'error' ? prev : { kind: 'live' }))
    source.onerror = () =>
      // 正常结束（终端退出）时浏览器也会报 error，别把已退出误报成连接故障。
      setConnection((prev) => (prev.kind === 'exited' ? prev : { kind: 'error', message: '输出流已断开' }))
    source.onmessage = (event: MessageEvent) => {
      let frame: TerminalFrame
      try {
        frame = JSON.parse(event.data) as TerminalFrame
      } catch {
        return
      }
      if (frame.type === 'snapshot') {
        term.reset()
        applyInfoToTerm(frame.info)
        writeNow(frame.screen)
        setConnection({ kind: frame.info.state === 'running' ? 'live' : 'exited' })
        return
      }
      if (frame.type === 'output') {
        writeCoalesced(frame.data)
        return
      }
      if (frame.type === 'state') {
        applyInfoToTerm(frame.info)
        if (frame.info.state !== 'running') setConnection({ kind: 'exited' })
        return
      }
      setConnection({ kind: 'error', message: frame.message })
    }
    return () => source.close()
  }, [visible, retryToken, writeNow, writeCoalesced, applyInfoToTerm])

  // 3) 尺寸：可见时按容器 proposeDimensions → 夹取 → 本地 resize + 防抖上报
  useEffect(() => {
    if (!visible) return
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return
    const measure = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      const dimensions = fit.proposeDimensions()
      if (!dimensions) return
      const cols = Math.min(dimensions.cols, limitsRef.current.maxCols)
      const rows = Math.min(dimensions.rows, limitsRef.current.maxRows)
      if (cols < 2 || rows < 1) return
      if (cols === term.cols && rows === term.rows) return
      term.resize(cols, rows)
      const target = targetRef.current
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        void resizeTerminal(target.sessionId, target.id, cols, rows).catch(() => {
          /* 终端已退出 / 已被别处关闭：忽略 */
        })
      }, 120)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    measure()
    return () => {
      observer.disconnect()
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
    }
  }, [visible])

  // 切回可见时聚焦，省一次点击。
  useEffect(() => {
    if (visible && info.state === 'running') termRef.current?.focus()
  }, [visible, info.state])

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} data-testid={`terminal-screen-${info.id}`} className="h-full w-full" />
      {visible && connection.kind === 'error' && (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-1.5 text-[11px]"
          style={{ background: 'var(--error-bg)', color: 'var(--error)' }}
          role="status"
        >
          <span>{connection.message}</span>
          <button
            type="button"
            className="cursor-pointer rounded border px-2 py-0.5"
            style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
            onClick={() => setRetryToken((n) => n + 1)}
            data-testid={`terminal-reconnect-${info.id}`}
          >
            重连
          </button>
        </div>
      )}
    </div>
  )
}