# Task 2 Report — V2 TaskList 数据模型 — store slice 扩展

## Status

`DONE_WITH_CONCERNS`

## Commits

```
$ git log --oneline c06b313..HEAD
c5dca77 feat(zai-web): add v2TasksBySession store slice + fetchV2Tasks client API
```

## Test summary

```
$ pnpm --filter @zn-ai/zai test -- v2TaskApi
✓ src/web/src/lib/v2TaskApi.test.ts (2 tests) 4ms
```

Both v2TaskApi tests pass: `GET 路径正确 + 返回 task 数组` and `HTTP 非 2xx 抛错`.

Note: the vitest run also reports 20 other failing tests across the broader `pnpm --filter @zn-ai/zai test` suite (ModelStatusButton, agentSettings, agentRuntime, etc.). I verified via `git stash` on a clean tree at `c06b313` that these 20 failures are **pre-existing** and unrelated to Task 2 — same exact count, same files. They predate my changes.

## Concerns

1. **Brief note inaccuracy: `// @vitest-environment happy-dom` directive IS required.** The brief said "not needed here — pure fetch tests" but `v2TaskApi.ts` directly references `localStorage` (DOM API) and the project's vitest config sets `environment: 'node'`. Without the directive, `localStorage.clear()` in `beforeEach` throws `ReferenceError: localStorage is not defined` and both tests fail. I added the directive (happy-dom is already a project dep, used by TaskDrawer/useBackgroundTasks/sse tests) — single-line addition, no new dependency. Test file content otherwise matches the brief verbatim.

2. **No other concerns.** The `v2TasksBySession` field name uses the `BySession` suffix (matching `todosBySession`) as the brief code blocks specify, ignoring the abbreviated "File Structure" section in the plan that called it `v2Tasks`. Resolved per the prompt's explicit instruction to trust the brief code blocks.