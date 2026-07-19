import { useAgentStore } from '../store/useAgentStore.js'

/**
 * 读取当前 session 的 cwd。
 *
 * 100% 由 SSE 推送 (cwd.changed) 驱动 — store 由 useEventStream dispatch
 * 通过 applyCwdChanged reducer 维护。
 *
 * 冷启动到第一次 BashTool 命令运行之间,cwd 可能为空字符串(此时 ConfigStatusBar
 * 会 fallback 到 useAppStore.instanceContext.cwdName)。这是有意的权衡 —
 * 不再用一次性 REST 拉取,避免任何 HTTP 调用。
 */
export function useSessionCwd(sessionId: string | null): string | undefined {
  return useAgentStore((s) => (sessionId ? s.cwdBySession[sessionId] : undefined))
}