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
 */
export function SessionCwdBridge() {
  const sessionId = useAgentStore(s => s.sessionId)
  const sessionCwd = useSessionCwd(sessionId)
  const setInstanceContext = useAppStore(s => s.setInstanceContext)
  const fallbackCwdName = useAppStore(s => s.instanceContext?.cwdName ?? '')

  useEffect(() => {
    if (!setInstanceContext) return  // guarded for tests / non-store consumers
    const name = sessionCwd
      ? sessionCwd.split('/').filter(Boolean).pop() || sessionCwd
      : fallbackCwdName
    setInstanceContext(prev => prev ? { ...prev, cwdName: name } : prev)
  }, [sessionCwd, fallbackCwdName, setInstanceContext])

  return null
}