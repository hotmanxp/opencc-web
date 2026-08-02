export type {
  TaskStatus,
  DispatchInput,
  BackgroundTask,
  BackgroundTaskError,
  TaskEvent,
  TaskListFilter,
} from './types.js'
export { TaskNotFoundError } from './types.js'

export type { BackgroundRuntime } from './BackgroundRuntime.js'
// `AgentRuntime` interface from `compat/runtime/contract.ts` was the
// legacy compat surface. Task 6 deletes contract.ts; the new
// `OpenccRuntime` interface from `opencc-src/server/serverTypes.ts`
// is the replacement. No re-export needed.
export {
  DefaultBackgroundRuntime,
  type DefaultBackgroundRuntimeOptions,
} from './DefaultBackgroundRuntime.js'

export type { TaskStore } from './store/TaskStore.js'
export { JsonTaskStore } from './store/JsonTaskStore.js'
export { atomicWriteFile } from './store/atomicWrite.js'

export {
  RETRY_POLICY,
  classifyRetryableError,
  isQuotaExhausted,
  getRetryDelay,
  retrySleep,
  type RetryDecision,
} from './retryPolicy.js'

export {
  setBackgroundRuntime,
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from './registry.js'
