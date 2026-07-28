// @zn-ai/zn-agent-core/runtime
export { CwdStore } from '../compat/cwdStore.js'
export { runWithSessionId, getCurrentSessionId } from '../compat/runWithSessionId.js'
export type { PermissionMode } from '../opencc-src/types/permissions.js'

// Re-export opencc's core runtime pieces
export { query } from '../opencc-src/query.js'
export { QueryEngine } from '../opencc-src/QueryEngine.js'

// State event bus — zai server subscribes to translate into SSE events
export {
  stateChangeBus,
  resetStateChangeBusForTests,
  type StateChangeEventMap,
} from '../stateChangeBus.js'

// Process-output error handlers — wired by zai CLI to surface EPIPE etc.
export { registerProcessOutputErrorHandlers } from '../opencc-src/utils/process.js'

// Transcript repair — ported from zai's old runtime, lives in compat
export { repairAndPersistTranscript } from '../compat/transcript/repair.js'

// zai-specific model-caller contract (the factory in zai-server
// implements this; runtime consumers accept it as the modelCaller option)
export type { ModelCaller, Tool } from '../compat/runtime/modelCaller.js'