# P3 12-path 真机验收重跑报告

**日期**: 2026-08-30
**环境**: zai dev on port 8102/7715, ZAI_RUNTIME_CORE=repl (explicit)
**分支**: feat/regression-tests, HEAD `bad02d28`
**核心**: runtimeCore='repl'

## Summary
- Paths tested: 1/12 (Path 1 only — blocker found immediately)
- **PASS: 0**
- **FAIL: 1** (Path 1 — new regression)
- **SKIPPED: 11** (blocked by Path 1 regression)
- **Net change vs P2**: REGRESSION — Path 1 was PASS in P2, now FAIL

## Path 1: Single prompt multi-turn
- **Status: FAIL (REGRESSION from P2)**
- Evidence: Browser shows `runtime.error (internal)` immediately after submitting "hi"
- Server log: `[ReplRuntime] submit threw: Cannot read properties of undefined (reading 'mode')`
- Screenshot: `path-1-regression.png`

### Root Cause Analysis

P2 baseline (HEAD `610b2635`) passed Path 1. P3 (HEAD `bad02d28`) introduced a regression.

**P2 behavior**: `createReplSession.runTurn()` called `query()` with `toolUseContext: {} as any` — an empty object. Vendor code path never accessed `appState.toolPermissionContext.mode`.

**P3 behavior**: P3 Task 0 ("populate full ToolUseContext") added:
1. Dynamic vendor tool context loading via `import('../../opencc-src/tools.js')`
2. `fallbackTools = vendorCtx.getTools({ mode: 'acceptEdits', ... })`
3. Full `toolUseContext` object passed to `query()`

Inside vendor `getTools()` → `assembleToolPool()` → permission checks, the code accesses `appState.toolPermissionContext.mode`. But in the zai server context, `getAppState()` returns `{}` (no `toolPermissionContext` key), so `appState.toolPermissionContext` is `undefined`, and accessing `.mode` on `undefined` throws:

```
Cannot read properties of undefined (reading 'mode')
```

This is caught by `session.submit(...).catch()` in `agentRuntime.repl.ts:74` and surfaced as `runtime.error (internal)` to the browser.

**P2 code (passed)**:
```typescript
// runTurn called query() with empty context
toolUseContext: {} as any  // never accessed appState.toolPermissionContext
```

**P3 code (broken)**:
```typescript
// P3 added full ToolUseContext population
toolUseContext: {
  options: { tools: fallbackTools, ... },
  getAppState: () => (opts.getAppState?.() ?? {}) as any,
  ...
}
```

When vendor code calls `getAppState().toolPermissionContext.mode`, it fails because the `{}` returned by `getAppState()` has no `toolPermissionContext` key.

## Comparison to P2 baseline

| Path | P2 | P3 | Δ |
|------|----|----|---|
| 1 | PASS | FAIL | REGRESSION |
| 2 | FAIL | SKIPPED | blocked |
| 3 | FAIL | SKIPPED | blocked |
| 4 | FAIL | SKIPPED | blocked |
| 5 | SKIPPED | SKIPPED | unchanged |
| 6 | PASS | SKIPPED | blocked |
| 7 | FAIL | SKIPPED | blocked |
| 8 | FAIL | SKIPPED | blocked |
| 9 | FAIL | SKIPPED | blocked |
| 10 | FAIL | SKIPPED | blocked |
| 11 | SKIPPED | SKIPPED | unchanged |
| 12 | SKIPPED | SKIPPED | unchanged |

## Blocking Issue

**P3 introduced a new crash in the basic "hi" prompt path.** Even a simple text message now triggers `runtime.error (internal)` due to `appState.toolPermissionContext` being undefined in the zai server context.

The fix requires either:
1. Provide a proper `toolPermissionContext` in the `toolUseContext` passed to `query()`, or
2. Guard the `appState.toolPermissionContext.mode` access in vendor code with a fallback

## Verdict

**BLOCKED**

The Path 1 regression makes all other paths inaccessible. The P3 "populate full ToolUseContext" change introduced a dependency on `appState.toolPermissionContext.mode` that the zai server context cannot satisfy with its current `getAppState() ?? {}` fallback.

## Screenshots

- `path-1-regression.png` — Browser showing `runtime.error (internal)` for "hi" prompt

## Next Actions

1. Fix `appState.toolPermissionContext` initialization in zai server's `createReplSession` call
2. OR add defensive `?.` guards in vendor code before accessing `appState.toolPermissionContext.mode`
3. Re-run Path 1 verification after fix
4. Then re-run remaining paths
