import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import type { StopHookExecutionDeps } from './stopHooks.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string

  // -- goal continuation
  stopHookExecutionDeps?: StopHookExecutionDeps
}

export function productionDeps(): QueryDeps {
  // zai patch: when a zai modelCaller is registered (via
  // `globalThis.__zaiModelCaller`) and the compat layer has exposed
  // its translateCallModel shim (via `globalThis.__zaiTranslateCallModel`),
  // route the default callModel through zai's translateCallModel so that
  // sub-agents spawned by AgentTool (which call `query()` without
  // specifying `params.deps` and therefore fall through to productionDeps)
  // get the SAME call path as the parent's main loop — model profile
  // resolution, the 2013 orphan-tool_result sanitizer, and any other
  // zai-specific request shaping. Without this hook, sub-agents
  // bypass zai's compat layer entirely and use vendor's
  // `queryModelWithStreaming` directly, which can fail silently in
  // zai's env (sub-agent call returns no output → parent sees
  // "(Subagent completed but returned no output.)").
  const zaiModelCaller = (globalThis as any).__zaiModelCaller
  const zaiTranslateCallModel = (globalThis as any).__zaiTranslateCallModel
  if (zaiModelCaller && typeof zaiTranslateCallModel === 'function') {
    if (process.env.ZAI_DEBUG === '1') {
      console.log(
        '[zai] productionDeps: routing sub-agent callModel through translateCallModel',
      )
    }
    return {
      callModel: (openccReq: any) =>
        zaiTranslateCallModel(openccReq, zaiModelCaller),
      microcompact: microcompactMessages,
      autocompact: autoCompactIfNeeded,
      uuid: randomUUID,
    }
  }
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
