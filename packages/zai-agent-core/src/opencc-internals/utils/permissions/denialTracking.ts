// @ts-nocheck
// Local stub for opencc-internals/utils/permissions/denialTracking.ts.
// The full upstream file isn't in the sync whitelist because its'permission
// FSM isn't needed by zai (no classifier pipeline). forkedAgent only needs
// createDenialTrackingState() to pass into the agent runner; the empty state
// is a valid no-op.
export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
  totalSuccesses: number
}

export const DENIAL_LIMITS = {
  maxConsecutiveDenials: 3,
  maxTotalDenials: 10,
} as const

export function createDenialTrackingState(): DenialTrackingState {
  return { consecutiveDenials: 0, totalDenials: 0, totalSuccesses: 0 }
}

export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
    totalSuccesses: state.totalSuccesses,
  }
}

export function recordSuccess(
  state: DenialTrackingState,
): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: state.totalDenials,
    totalSuccesses: state.totalSuccesses + 1,
  }
}

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutiveDenials ||
    state.totalDenials >= DENIAL_LIMITS.maxTotalDenials
  )
}