// packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts
//
// 仅在右侧分屏开启期间启用: 进入分屏 → 强制会话历史侧栏 collapsed=true.
// 用户点展开 → expand() 翻 false 并启动 timeoutMs 倒计时 (默认 10s).
// 用户点手动收起 → collapse() 翻 true 并清掉计时器.
// 用户在列表内有任何交互 (hover / mousemove / 切会话) → 调 schedule() 重置计时.
// 关闭分屏 → clearTimeout, 但不强制改 collapsed (沿用当前态 — 由用户决定).
//
// 状态完全本地 (useState). 不持久化, 不进 store, 不读 React context.
// splitPaneOpen 由调用方通过 boolean 参数注入 (Agent.tsx 顶部持有的
// useLocalStorageState(STORAGE_KEYS.open) 派生值); hook 自身不订阅 storage
// 事件, 避免与 Agent.tsx / AgentInputBox / SplitPane 三处订阅者双源冲突.
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_TIMEOUT_MS = 10_000

export interface UseSplitPaneSessionAutoCollapseOpts {
  splitPaneOpen: boolean
  /** 测试 override; 默认 10s. */
  timeoutMs?: number
}

export interface UseSplitPaneSessionAutoCollapseResult {
  collapsed: boolean
  /** 点 "展开会话历史" 时调用: 翻 false + 启动倒计时. */
  expand: () => void
  /** 点 "收起会话历史" 时调用: 翻 true + 清掉计时器. */
  collapse: () => void
  /** hover / mousemove / onClick 时调用, 重置倒计时. */
  schedule: () => void
}

export function useSplitPaneSessionAutoCollapse(
  opts: UseSplitPaneSessionAutoCollapseOpts,
): UseSplitPaneSessionAutoCollapseResult {
  const { splitPaneOpen, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  const [collapsed, setCollapsed] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const armTimer = useCallback(
    (ms: number) => {
      clearTimer()
      timerRef.current = setTimeout(() => {
        setCollapsed(true)
        timerRef.current = null
      }, ms)
    },
    [clearTimer],
  )

  const schedule = useCallback(() => {
    if (!splitPaneOpen) return
    armTimer(timeoutMs)
  }, [splitPaneOpen, armTimer, timeoutMs])

  const expand = useCallback(() => {
    setCollapsed(false)
    if (!splitPaneOpen) return
    armTimer(timeoutMs)
  }, [splitPaneOpen, armTimer, timeoutMs])

  const collapse = useCallback(() => {
    setCollapsed(true)
    clearTimer()
  }, [clearTimer])

  // Enter 分屏: 强制收起 + 清掉旧 timer
  useEffect(() => {
    if (!splitPaneOpen) {
      // 退出分屏: 仅清 timer, 不改 collapsed (保留用户原态).
      clearTimer()
      return
    }
    setCollapsed(true)
    clearTimer()
  }, [splitPaneOpen, clearTimer])

  // Unmount cleanup
  useEffect(() => clearTimer, [clearTimer])

  return { collapsed, expand, collapse, schedule }
}
