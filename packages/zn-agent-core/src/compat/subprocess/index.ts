// Barrel for the subprocess IPC seam.
//
// Public surface:
//   - `spawnSubprocess(req)`: pipe `stdio` child with scrubbed env + tree kill
//   - `getChildEnv(overlay?)`: env composition helper for callers that spawn
//      outside this seam but still want the same scrub discipline (rare)
//   - `STRIPPED_ENV_VARS`: read-only view of the strip list (tests, ops tools)
//   - `MAX_TIMER_DELAY_MS`, `DISPOSE_GRACE_MS_DEFAULT`: timer bounds
//   - `JsonRpcClient`: line-delimited JSON-RPC 2.0 client on top of a
//     `SubprocessHandle`
//
// Deliberately NOT exported here:
//   - `spawn.ts` internal helpers (`resolveInvocation`, `runKillTree`,
//     `quoteForCmd`) — they're implementation details that change when
//     Windows quirks evolve
//   - The `KillState` shape used by `spawnSubprocess` for idempotent kill

export { spawnSubprocess } from './spawn.js'
export { getChildEnv, STRIPPED_ENV_VARS } from './env.js'
export { MAX_TIMER_DELAY_MS, DISPOSE_GRACE_MS_DEFAULT } from './timeouts.js'
export { JsonRpcClient } from './jsonRpc.js'
export type {
  SpawnSubprocessRequest,
  SubprocessHandle,
} from './types.js'
export type {
  JsonRpcRequestFrame,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcFrame,
  JsonRpcNotificationHandler,
} from './jsonRpc.js'
