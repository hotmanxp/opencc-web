// Runtime compat entry — aggregated into the package main entry via
// bundle-entry.ts (the old `@zn-ai/zn-agent-core/runtime` subpath is
// gone; consumers import from `@zn-ai/zn-agent-core`).
//
// The original implementation re-exported `query`, `QueryEngine`, and
// `registerProcessOutputErrorHandlers` from `opencc-src/`. That pulled in the
// full opencc source tree (React JSX, opentelemetry, lodash-es, axios,
// chalk, etc.) which is Bun-native and not buildable in the current
// workspace.
//
// The actual zai server only consumes the compat layer below — it never
// imports `query` / `QueryEngine` directly via this subpath. The opencc
// runtime is wired through `DefaultAgentRuntime` (compat/runtime/contract.ts),
// which lazy-imports `opencc-src/query.js` at call time inside a `try/catch`
// and throws a friendly error if opencc is not vendored.
//
// `query` / `QueryEngine` are exposed as throwing stubs (see
// `openccStubs.ts`) so any code that bypasses `DefaultAgentRuntime` gets a
// clear actionable error. `registerProcessOutputErrorHandlers` is
// inlined because it is just EPIPE wiring and zai's CLI calls it at
// startup — making it a stub would crash the server on boot.

import { throwNotWired, registerProcessOutputErrorHandlersImpl } from './openccStubs.js'

export { CwdStore } from '../compat/cwdStore.js'
export { runWithSessionId, getCurrentSessionId } from '../compat/runWithSessionId.js'
export type { PermissionMode } from '../compat/permissions.js'

export function query(..._args: unknown[]): never {
  throwNotWired('query')
}
export class QueryEngine {
  constructor(..._args: unknown[]) {
    throwNotWired('QueryEngine constructor')
  }
}

// State event bus — zai server subscribes to translate into SSE events
export {
  stateChangeBus,
  resetStateChangeBusForTests,
  type StateChangeEventMap,
} from '../stateChangeBus.js'

export function registerProcessOutputErrorHandlers(): void {
  registerProcessOutputErrorHandlersImpl()
}

// Transcript repair — ported from zai's old runtime, lives in compat
export { repairAndPersistTranscript } from '../compat/transcript/repair.js'

// zai patch (Aug 2026): append* helpers are the runtime transcript write
// path. Previously the prompt route relied on the opencc `query()` loop
// to persist user/assistant/tool messages, but the opencc runtime only
// emits stream events — it never wrote to the transcript. Result: every
// session in the new layout has `messages: []` and the UI shows a blank
// transcript on reload. Importing the helpers here lets the zai prompt
// route persist each runtime event as it consumes the stream.
export {
  appendUserMessageV2,
  appendAssistantMessageV2,
  appendToolUse,
  appendToolResult,
} from '../compat/transcript/persistence.js'

// zai-specific model-caller contract (the factory in zai-server
// implements this; runtime consumers accept it as the modelCaller option)
export type { ModelCaller, Tool } from '../compat/runtime/modelCaller.js'
