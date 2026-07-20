/**
 * runtime/summary 公共 API facade。
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-e-step-limit-design.md
 *
 * Re-exports the public surface of E (agent step limit + tool use summary).
 * The integration PR (Phase 2 of the umbrella plan) wires these into
 * queryLoop.ts; this module is intentionally passive — it does not
 * register hooks or modify global state.
 */

// ---- step counter (§2.1) ---------------------------------------------------
export {
  getAgentStepLimit,
} from './stepCounter.js'
export type {
  StepLimitOptions,
  RuntimeConfigSlice,
} from './stepCounter.js'

// ---- summary store (§2.1, §2.2) ------------------------------------------
export {
  getSummaryStore,
  TOOL_SUMMARY_SCHEMA,
} from './summaryStore.js'
export type {
  SummaryStore,
  SummaryStoreOptions,
  ToolSummaryRecord,
} from './summaryStore.js'

// ---- tool use summary (§2.1, §2.4) ---------------------------------------
export {
  generateToolUseSummary,
} from './toolUseSummary.js'
export type {
  GenerateSummaryOptions,
  SummaryModelCaller,
  ToolResultLike,
} from './toolUseSummary.js'
