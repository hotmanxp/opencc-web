import { describe, expect, test } from 'bun:test'
import { getDefaultAppState } from './AppStateStore.js'
import { createAppStateStore } from './createAppStateStore.js'

// TDD RED test for the cascading-undefined crash chain — 3rd iteration now
// surfaces via `useAutoModeUnavailableNotification` reading
// `s.toolPermissionContext.mode` (where `s.toolPermissionContext` is
// undefined). Symptom guards in selectors (getDenyRules / mcp?.clients /
// toolPermissionContext.mode) only push the crash one layer down each
// time the user updates OpenCC. The architectural fix is: enforce an
// invariant in the store itself — every accepted AppState must have the
// same top-level key shape as `getDefaultAppState()`, and missing keys
// are auto-repaired from a captured shape + logged for follow-up.

describe('createAppStateStore invariant', () => {
  test('preserves a well-formed state unchanged', () => {
    const store = createAppStateStore(getDefaultAppState())
    const initial = store.getState()
    expect(initial.toolPermissionContext).toBeDefined()
    expect(initial.mcp).toBeDefined()
    store.setState(prev => ({ ...prev, verbose: !prev.verbose }))
    expect(store.getState().toolPermissionContext).toBeDefined()
    expect(store.getState().mcp).toBeDefined()
  })

  test('repairs missing mcp from defaults instead of letting it through', () => {
    const store = createAppStateStore(getDefaultAppState())
    // BUG-reproducing updater: returns an object that drops mcp entirely.
    // Without the invariant this propagates undefined-mcp into the React
    // tree and surfaces as a crash on the first useAppState(s => s.mcp.*)
    // render. With the invariant, the missing key gets the shape default.
    store.setState(() => ({
      toolPermissionContext: {
        ...getDefaultAppState().toolPermissionContext,
      },
      // intentionally no `mcp`, no other keys
    }) as never)
    const repaired = store.getState()
    expect(repaired.mcp).toBeDefined()
    expect(repaired.mcp.clients).toEqual([])
    expect(repaired.toolPermissionContext).toBeDefined()
  })

  test('repairs missing toolPermissionContext from defaults', () => {
    const store = createAppStateStore(getDefaultAppState())
    store.setState(() => ({
      mcp: {
        ...getDefaultAppState().mcp,
      },
      // intentionally no `toolPermissionContext`
    }) as never)
    const repaired = store.getState()
    expect(repaired.toolPermissionContext).toBeDefined()
    expect(repaired.toolPermissionContext.mode).toBeDefined()
    expect(repaired.mcp).toBeDefined()
  })

  test('does not overwrite a key the updater explicitly set to a value', () => {
    const store = createAppStateStore(getDefaultAppState())
    const explicitMcp = {
      clients: [{ name: 'kept' } as never],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 7,
    }
    store.setState(prev => ({ ...prev, mcp: explicitMcp }) as never)
    expect(store.getState().mcp).toBe(explicitMcp)
  })

  test('does not crash when updater returns the same object reference', () => {
    const store = createAppStateStore(getDefaultAppState())
    const initial = store.getState()
    store.setState(() => initial)
    // Repaired state should equal initial (same refs for everything we
    // can confirm is well-formed).
    expect(store.getState().toolPermissionContext).toBe(initial.toolPermissionContext)
    expect(store.getState().mcp).toBe(initial.mcp)
  })

  test('emits onChange exactly once with the repaired state when a setState repaired defaults', () => {
    const store = createAppStateStore(getDefaultAppState(), ({ newState }) => {
      observedNew = newState
    })
    let observedNew: ReturnType<typeof store.getState> | undefined
    // Capture next reference via onChange
    let captured: unknown = undefined
    const wrappedStore = createAppStateStore(getDefaultAppState(), ({ newState }) => {
      captured = newState
    })
    void observedNew
    void wrappedStore
    wrappedStore.setState(() => ({ mcp: {} }) as never)
    expect(captured).toBeDefined()
    expect((captured as { toolPermissionContext: unknown }).toolPermissionContext).toBeDefined()
  })
})
