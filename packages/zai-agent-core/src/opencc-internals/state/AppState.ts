/**
 * Minimal AppState stub for zai-agent-core.
 *
 * OpenCC upstream's `AppState` is a 100+ field store tied to React rendering
 * and the REPL loop. zai-agent-core has no UI; this stub provides only the
 * `getAppState()/setAppState()` shape that `ToolUseContext` requires, so the
 * bridge in `runtime/toolUseContextBridge.ts` can fill the field with a
 * no-op default.
 */

export type AppState = Record<string, unknown>

export function defaultAppState(): AppState {
  return {}
}

export type AppStateStore = {
  getState: () => AppState
  setState: (updater: AppState | ((prev: AppState) => AppState)) => void
}

export function createAppStateStore(
  initial: AppState = defaultAppState(),
): AppStateStore {
  let state = initial
  return {
    getState: () => state,
    setState: (updater) => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
  }
}