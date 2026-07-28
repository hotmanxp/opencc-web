import type { AppState } from './AppStateStore.js'
import { getDefaultAppState } from './AppStateStore.js'
import { createStore, type OnChange, type Store } from './store.js'

/**
 * Top-level AppState key whose value must always be a fresh empty Map when
 * we repair a partial state. The default AppState includes several Maps
 * (`agentNameRegistry`) that must not be shared across snapshots — sharing
 * them lets a future `setAppState(prev => { ...prev, registry: emptyMap })`
 * corrupt state for every consumer of the prior Map reference.
 */
const FRESH_MAP_KEYS = new Set<string>(['agentNameRegistry'])

/**
 * Build a fresh, side-effect-free shape object: every top-level key of
 * `getDefaultAppState()` is present, with Maps replaced by fresh empty
 * Maps (not shared references). Used only to repair a partial state in
 * the store invariant — this is NOT a substitute for a real initial
 * state.
 */
function getDefaultStateShape(): AppState {
  const defaults = getDefaultAppState()
  const shape = {} as Record<string, unknown>
  for (const key of Object.keys(defaults)) {
    shape[key] = FRESH_MAP_KEYS.has(key) ? new Map() : defaults[key as keyof AppState]
  }
  return shape as unknown as AppState
}

/**
 * Repair a partial AppState by filling in any missing top-level keys from
 * the captured shape. The shape Map for `agentNameRegistry` is fresh per
 * call to avoid aliasing across repairs.
 *
 * Returns `{ state: repaired, repairedKeys: string[] }` so callers (e.g.
 * the store wrapper) can log which keys were filled in — that log is the
 * primary signal for tracing the upstream `setAppState(prev => ...)`
 * updater that produced the partial state.
 */
function repairAppState(next: unknown): {
  state: AppState
  repairedKeys: string[]
} {
  const shape = getDefaultStateShape()
  const repairedKeys: string[] = []
  // Bail out fast for null/non-object — leave to the caller to crash, since
  // a non-object AppState is not repairable and there is no useful fallback.
  if (next === null || typeof next !== 'object') {
    return { state: shape, repairedKeys: Object.keys(shape) }
  }
  const nextObj = next as Record<string, unknown>
  for (const key of Object.keys(shape)) {
    if (!(key in nextObj)) {
      nextObj[key] = shape[key as keyof AppState]
      repairedKeys.push(key)
    }
  }
  return { state: nextObj as unknown as AppState, repairedKeys }
}

/**
 * AppState-aware store factory. Same surface as `createStore`, but wraps
 * `setState` with an invariant: every accepted AppState must have the same
 * top-level key shape as `getDefaultAppState()`. Missing keys are auto-
 * repaired from a captured shape and the affected key list is forwarded
 * to the optional `onRepair` hook (and logged via `logForDebugging`).
 *
 * Why this exists: the cascading-undefined crash chain (`reading 'alwaysDenyRules'`
 * → `reading 'clients'` → `reading 'mode'`) all share one upstream cause —
 * some `setAppState(prev => ...)` callback returned an AppState that
 * silently dropped a top-level key, which then propagated into the React
 * tree via `useAppState(s => s.<key>)`. Repairing inside the store stops
 * the propagation and emits a log identifying the bad key, without
 * re-introducing the crash every time OpenCC adds a new selector reading
 * a previously-unprotected field.
 *
 * Behavioral guarantees:
 * - `setState(prev => prev)` (no-change) does not invoke `onChange` or
 *   `onRepair`.
 * - `setState(prev => ({ ...prev, ... }))` does not invoke `onRepair` —
 *   spread keeps all top-level keys.
 * - `setState(prev => ({ <subset of keys> }))` invokes `onRepair` with
 *   the list of newly-filled-in top-level keys. The partial returned
 *   keys themselves remain untouched.
 */
export function createAppStateStore(
  initialState: AppState,
  onChange?: OnChange<AppState>,
  onRepair?: (repairedKeys: string[]) => void,
): Store<AppState> {
  // Apply the invariant to the initial state too: if a caller hands us a
  // partial default, repair it before any selector sees it.
  const { state: repairedInitial, repairedKeys } = repairAppState(initialState)
  if (repairedKeys.length > 0) {
    onRepair?.(repairedKeys)
  }

  const inner = createStore<AppState>(repairedInitial, onChange)

  return {
    getState: inner.getState,
    subscribe: inner.subscribe,
    setState: (updater: (prev: AppState) => AppState) => {
      const prev = inner.getState()
      const next = updater(prev)
      if (Object.is(next, prev)) return
      const { state: repaired, repairedKeys: newlyRepaired } = repairAppState(next)
      // Empty-array repaired means: updater spread correctly. Skip the
      // onRepair noise unless we actually filled something in.
      if (newlyRepaired.length > 0) {
        onRepair?.(newlyRepaired)
      }
      // Reach into the inner store with the repaired value so the
      // existing createStore identity + onChange machinery stays intact.
      inner.setState(() => repaired)
    },
  }
}
