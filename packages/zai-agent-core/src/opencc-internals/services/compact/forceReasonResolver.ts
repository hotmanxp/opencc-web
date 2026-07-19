// @ts-nocheck
// ZAI_STUB: zai 暂未实现，待 web 端稳定后再补
/**
 * Decide whether the autocompact query path should set a `forceReason`
 * on the tracking state, given a session's current message-count,
 * token-count, and memory-pressure signals.
 *
 * The token-count floor (`OPENCC_AUTOCOMPACT_FORCE_FLOOR_PCT` of the
 * model's natural autoCompact threshold) prevents the force-reasons from
 * firing on large-context models at low token usage — e.g. MiniMax-M3
 * with 1M context should not be compacted at 60k tokens just because the
 * conversation has 200+ messages.
 *
 * Priority: `memory-pressure` > `message-count`. A return value of
 * `undefined` means "do not force"; the natural token-based autoCompact
 * path still runs.
 */
export type ForceReason = 'memory-pressure' | 'message-count' | undefined

export type ResolveForceReasonArgs = {
  messageCount: number
  tokenCount: number
  maxActiveMessages: number
  naturalThreshold: number
  floorPct: number
  memoryPressureFlag: boolean
}

export function resolveForceReason(args: ResolveForceReasonArgs): ForceReason {
  const {
    messageCount,
    tokenCount,
    maxActiveMessages,
    naturalThreshold,
    floorPct,
    memoryPressureFlag,
  } = args

  // Floor is a percentage of the model's natural autoCompact threshold.
  // E.g. for M3 (threshold ≈ 954k) with floorPct=75, floor ≈ 715k.
  // If tokenCount is below the floor, the session has plenty of headroom
  // and we should let the natural threshold decide.
  const floor = Math.floor((naturalThreshold * floorPct) / 100)
  if (tokenCount < floor) {
    return undefined
  }

  // Memory-pressure wins over message-count. Pre-existing code at
  // query.ts:557 unconditionally overwrote; the resolver fixes that
  // priority inversion. Memory-pressure represents RSS-based urgency
  // (the process is at risk of OOM); message-count is just a long
  // conversation, less urgent.
  if (memoryPressureFlag) {
    return 'memory-pressure'
  }
  if (messageCount > maxActiveMessages) {
    return 'message-count'
  }
  return undefined
}