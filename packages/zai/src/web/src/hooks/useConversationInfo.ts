import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import type { AgentMessage, AgentStatus } from '../store/useAgentStore.js'
import type { ModelEntry } from '../../../shared/settings.js'

/**
 * Snapshot of conversation metadata shown in the info Popover.
 *
 * All fields are derived from existing store state plus a 1-shot fetch
 * of /api/agent/settings. Nothing here mutates the store.
 */
export interface ConversationInfo {
  /** Active session ID. Falls back to activeSessionId to cover streaming. */
  sessionId: string | null
  /** Session title from manifest, if any. */
  title: string | null
  /** Timestamp of the first message (ms epoch). Falls back to session createdAt. */
  startTime: number | null
  /** Last activity timestamp from the session manifest. */
  lastUpdate: number | null
  /** Number of complete user → assistant pairs. Unfinished trailing turn excluded. */
  turnCount: number
  /** Total messages currently in the local store. */
  messageCount: number
  /** Agent status (idle / streaming / aborted / error). */
  status: AgentStatus
  /** Current working directory. */
  cwd: string | null
  /** Effective model name: session.model when known, else runtime defaultModel. */
  model: string | null
  /** True once the /api/agent/settings fetch has settled (success or failure). */
  settingsLoaded: boolean
  /** Alias-aware display label. Falls back: alias.label → alias.alias → model → null. */
  displayLabel: string | null
}

interface RuntimeSettings {
  defaultModel: string | null
  baseURL: string | null
  models: ModelEntry[]
}

/**
 * Count complete user → assistant pairs in the message stream.
 *
 * Algorithm: walk messages linearly. Each `user.text` opens a candidate
 * turn. The first non-user message after it (assistant text, thinking,
 * tool_use, runtime.*) closes the turn and increments the counter.
 * An unpaired trailing user.text is not counted.
 *
 * Exported standalone (no React) so it can be unit-tested without
 * rendering components.
 */
export function countCompletedTurns(messages: AgentMessage[]): number {
  let turns = 0
  let sawUser = false
  for (const m of messages) {
    const t = m.type as string
    if (t === 'user.text') {
      sawUser = true
      continue
    }
    if (sawUser) {
      turns++
      sawUser = false
    }
  }
  return turns
}

function findAliasForModel(model: string | null, models: ModelEntry[]): ModelEntry | null {
  if (!model) return null
  return models.find((m) => m.model === model) ?? null
}

/**
 * Derive a ConversationInfo snapshot from the agent store and the
 * runtime settings endpoint. Re-runs when any store field changes —
 * cheap because countCompletedTurns is O(n).
 */
export function useConversationInfo(): ConversationInfo {
  const { sessionId, activeSessionId, sessions, messages, status, cwd } =
    useAgentStore()

  const [runtime, setRuntime] = useState<RuntimeSettings>({
    defaultModel: null,
    baseURL: null,
    models: [],
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // 1-shot fetch on mount. Failure is silent — `defaultModel` stays null
  // and the card shows "未知".
  useEffect(() => {
    let cancelled = false
    fetch('/api/agent/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Partial<RuntimeSettings>) => {
        if (cancelled) return
        setRuntime({
          defaultModel: data.defaultModel ?? null,
          baseURL: data.baseURL ?? null,
          models: Array.isArray(data.models) ? data.models : [],
        })
      })
      .catch(() => {
        // intentional swallow: model row will show "未知"
      })
      .finally(() => {
        if (!cancelled) setSettingsLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return useMemo<ConversationInfo>(() => {
    const effectiveSessionId = sessionId ?? activeSessionId ?? null
    const sess = effectiveSessionId
      ? sessions.find((s) => s.transcriptId === effectiveSessionId) ?? null
      : null
    const firstTs = messages[0]?.ts ?? sess?.createdAt ?? null
    const turns = countCompletedTurns(messages)
    const model =
      sess?.model && sess.model !== 'unknown'
        ? sess.model
        : runtime.defaultModel
    const alias = findAliasForModel(model, runtime.models)
    const displayLabel = alias?.label ?? alias?.alias ?? model ?? null

    return {
      sessionId: effectiveSessionId,
      title: sess?.title ?? null,
      startTime: typeof firstTs === 'number' && firstTs > 0 ? firstTs : null,
      lastUpdate: sess?.updatedAt ?? null,
      turnCount: turns,
      messageCount: messages.length,
      status,
      cwd: cwd || sess?.cwd || null,
      model,
      settingsLoaded,
      displayLabel,
    }
  }, [sessionId, activeSessionId, sessions, messages, status, cwd, runtime, settingsLoaded])
}
