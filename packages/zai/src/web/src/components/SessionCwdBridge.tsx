import { useEffect } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import { useSessionCwd } from '../hooks/useSessionCwd.js'

/**
 * Bridges the per-session cwd (from useSessionCwd polling) into the global
 * instance context, so ConfigStatusBar can render it without re-subscribing.
 *
 * Why a bridge: ConfigStatusBar is rendered deep in Agent.tsx but the cwd
 * polling lifecycle (start/stop on sessionId change) is best owned by the
 * top-level page tree. This component renders nothing (returns null) and only
 * side-effects useAppStore.
 *
 * Why useAppStore.setState (not setInstanceContext):
 * `setInstanceContext` is `(ctx) => set({ instanceContext: ctx })` — a
 * full-replacement setter, NOT a Zustand-style updater. Passing a function
 * (like `prev => ({ ...prev, cwdName })`) would assign the function itself as
 * `instanceContext`, breaking every consumer that reads
 * `instanceContext.cwdName` (Agent.tsx falls back to '~'). Use setState with a
 * proper (state) => partial updater instead.
 */
export function SessionCwdBridge() {
  const sessionId = useAgentStore(s => s.sessionId)
  const sessionCwd = useSessionCwd(sessionId)
  const fallbackCwdName = useAppStore(s => s.instanceContext?.cwdName ?? '')

  useEffect(() => {
    const name = sessionCwd
      ? sessionCwd.split('/').filter(Boolean).pop() || sessionCwd
      : fallbackCwdName
    // 兜底: instanceContext 未初始化(Layout 还没 fetch /api/system)时不要写
    // 空 cwdName 把 store 里的 null 替换成半成品 — 等 Layout 落地后再覆盖。
    useAppStore.setState((state) => {
      if (!state.instanceContext) return state
      // 已经一致就不触发 render / subscriber
      if (state.instanceContext.cwdName === name) return state
      return { instanceContext: { ...state.instanceContext, cwdName: name } }
    })
  }, [sessionCwd, fallbackCwdName])

  return null
}