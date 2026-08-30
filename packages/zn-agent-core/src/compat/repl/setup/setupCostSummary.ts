// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2): L2 hook adapter — setupCostSummary.
 * Imperative cost summary refresh; mirrors useCostSummary.
 */

type SetupCostSummaryOpts = { onUpdate: (summary: any) => void }

export function setupCostSummary(opts: SetupCostSummaryOpts) {
  let disposed = false
  return {
    async refresh(): Promise<void> {
      // P2 minimal: synthesize from getAppState; P2.1 wires real cost tracking
      const summary = {
        totalUsd: 0,
        perModel: {},
        timestamp: Date.now(),
      }
      if (disposed) return
      try { opts.onUpdate(summary) } catch (e) { console.warn(e) }
    },
    teardown() {
      if (disposed) return
      disposed = true
    },
  }
}
