import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import { useAppStore } from '../store/useAppStore.js'
import { useProjection } from '../store/useProjection.js'
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
  /** zai patch (2026-08-09): 该 session 截至目前累计的 API 请求次数(后端 vendor 计数)。0 表示还没推到。 */
  apiRequestCount: number
  /** zai patch (2026-08-09): 该 session 最近一次 API 调用的 total context tokens(input + cache_creation + cache_read)。null 表示还没推过(transcript 重放/早期 query)。 */
  contextTokens: number | null
  /** zai patch (2026-08-09): 当前 sid 用的模型支持的上下文大小(从 settings.models 查 sid.model → capabilities.contextWindow)。null 表示无数据。 */
  contextWindow: number | null
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

function findAliasForModel(
  model: string | null,
  models: ModelEntry[],
  providerId?: string | null,
): ModelEntry | null {
  if (!model) return null
  // zai patch: prefer the (model, providerId) tuple match when
  // providerId is supplied. Several provider profiles can host the
  // same model name (e.g. `MiniMax-M3` on Open Platform and
  // ZhiNiao) — without this tuple match, displayLabel / contextWindow
  // would surface whichever provider happened to be first in the
  // list, not the one the user actually picked. Falls back to
  // first-match-by-model for legacy sessions without providerId.
  if (providerId) {
    const exact = models.find((m) => m.model === model && m.providerId === providerId)
    if (exact) return exact
  }
  return models.find((m) => m.model === model) ?? null
}

/**
 * Derive a ConversationInfo snapshot from the agent store and the
 * runtime settings endpoint. Re-runs when any store field changes —
 * cheap because countCompletedTurns is O(n).
 */
export function useConversationInfo(): ConversationInfo {
  const { sessionId, activeSessionId, sessions, messages, status, apiRequestCountBySession, contextTokensBySession } =
    useAgentStore()
  const { instanceContext } = useAppStore()
  const cwd = instanceContext?.cwd || null

  const [runtime, setRuntime] = useState<RuntimeSettings>({
    defaultModel: null,
    baseURL: null,
    models: [],
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  // dsh 投影试点 (2026-08-15): 当前上下文大小改由 host 推送的
  // session/projection 帧提供 (useProjection 订阅), fallback 到旧的
  // contextTokensBySession (runtime.done 路径保留)。
  const effectiveSessionId = sessionId ?? activeSessionId ?? null
  const projectedCtxTokens = useProjection<number>(effectiveSessionId, 'context.tokens')

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
    const sess = effectiveSessionId
      ? sessions.find((s) => s.sessionId === effectiveSessionId) ?? null
      : null
    // 找首条 user.text: messages[0] 不一定是 user 消息(SSE 流水里
    // 可能有 system / runtime.* / assistant.* 排在前面),所以不能直接
    // 取 messages[0]。info 面板的"标题"和"首条消息时间"应该对齐
    // 用户视角的第一条 user.text —— 它的 text 描述用户最初在问什么,
    // ts 是用户实际发问的时刻。完全没有 user 消息时再 fallback 到
    // manifest 字段(createdAt 是后端落盘的 session 创建时间,作为
    // 兜底仍然比 messages[0]?.ts 稳定)。
    const firstUserMsg = messages.find((m) => (m as { type?: unknown }).type === 'user.text') ?? null
    const firstUserText =
      firstUserMsg && typeof firstUserMsg.text === 'string' && firstUserMsg.text.length > 0
        ? firstUserMsg.text
        : null
    const firstUserTs =
      firstUserMsg && typeof firstUserMsg.ts === 'number' && firstUserMsg.ts > 0
        ? firstUserMsg.ts
        : null
    const derivedTitle = firstUserText ?? sess?.title ?? null
    const firstTs = firstUserTs ?? sess?.createdAt ?? null
    const turns = countCompletedTurns(messages)
    const model =
      sess?.model && sess.model !== 'unknown'
        ? sess.model
        : runtime.defaultModel
    // zai patch: thread session.providerId into the alias lookup so a
    // model hosted on multiple providers surfaces the right one
    // (displayLabel / contextWindow / etc.). Without this, the card
    // would show whichever provider happened to be first in
    // runtime.models, not the one the user actually picked.
    const alias = findAliasForModel(model, runtime.models, sess?.providerId)
    const displayLabel = alias?.label ?? alias?.alias ?? model ?? null
    // zai patch (2026-08-09): 派生当前 session 的 context window。
    // 从 runtime.models 找 sid.model 对应的 capabilities.contextWindow。
    // 找不到时(null / unknown model / 无 capabilities)返回 null,UI 用 "—" 显示。
    // 同样按 (model, providerId) 精确匹配;同名跨 provider 时取当前 provider 的能力。
    const contextWindow =
      model && model !== 'unknown'
        ? (alias?.capabilities?.contextWindow ?? null)
        : null

    return {
      sessionId: effectiveSessionId,
      title: derivedTitle,
      startTime: typeof firstTs === 'number' && firstTs > 0 ? firstTs : null,
      lastUpdate: sess?.updatedAt ?? null,
      turnCount: turns,
      messageCount: messages.length,
      status,
      cwd: cwd || sess?.cwd || null,
      model,
      settingsLoaded,
      displayLabel,
      apiRequestCount: effectiveSessionId
        ? (apiRequestCountBySession[effectiveSessionId] ?? 0)
        : 0,
      contextTokens: effectiveSessionId
        ? (projectedCtxTokens ?? contextTokensBySession[effectiveSessionId] ?? null)
        : null,
      contextWindow,
    }
  }, [effectiveSessionId, projectedCtxTokens, sessions, messages, status, cwd, runtime, settingsLoaded, apiRequestCountBySession, contextTokensBySession])
}
