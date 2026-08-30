// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): useProactive hook placeholder.
 *
 * NOTE: The vendor useProactive hook does not exist as a standalone file in
 * this build — it is gated by `false || false` in REPL.tsx (lines 198, 202)
 * and thus eliminated as dead code. The proactive module is similarly gated
 * by `feature('PROACTIVE') || feature('KAIROS')` which requires bun:bundle
 * and is not available in Node.js builds.
 *
 * This file exists solely to re-export setupProactive so the vendor hook
 * barrel (opencc-src/hooks/index.ts) can export it consistently with
 * useScheduledTasks and other hooks.
 */

// zai patch (2026-08-30, plan P0): also export imperative setupProactive.
// Mirrors useProactive imperative side: GrowthBook PROACTIVE/KAIROS gate,
// internal timer. Same proactiveModule state so imperative and React callers
// share the same proactive state.
export { setupProactive } from '../../compat/repl/setup/setupProactive.js'
