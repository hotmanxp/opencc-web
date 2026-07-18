# Task 3 Report

## Status

DONE

## Commits

```
cd10f97 feat(zai): expose V2 TaskList via GET route + auto-refresh on session change
```

`git log --oneline c5dca77..HEAD`:
```
cd10f97 feat(zai): expose V2 TaskList via GET route + auto-refresh on session change
```

## Verification

- `pnpm --filter @zn-ai/zai typecheck` → exit 0
- `pnpm --filter @zn-ai/zai build` → exit 0 (tsc -b passes; vite emits `dist/web/index.html` + 5974 modules transformed in 2.71s)
- `pnpm --filter @zn-ai/zai test` → 246 passed / 20 failed. The 20 failures are **pre-existing on baseline** (verified by stashing the store change and re-running: identical 8 failed files / 20 failed tests). The only test file touching V2 work (`src/web/src/lib/v2TaskApi.test.ts`) passes (2/2).

## What was done

### Step A — `Agent.tsx` (already in place when I arrived)

The previous implementer had already wired up Step A before I started:
- Line 50: `import { fetchV2Tasks } from "../lib/v2TaskApi.js";` already present
- Lines 1130-1149: the `useEffect` block fetching on `sessionId` change is in place, exactly matching the brief's spec (cancelled-flag pattern, `console.warn` on failure, `useAgentStore.getState().setV2Tasks(sid, tasks)`)

I verified the block is correct and left it untouched.

### Step B — `useAgentStore.ts` (rewrote)

The previous implementer had wired Step B using a **dynamic `await import('../lib/v2TaskApi.js')`** to dodge the circular-import concern. That works but:
1. Pays an extra module-resolution hop on every `TaskCreate`/`TaskUpdate` SSE event
2. The accompanying comment ("ESM resolver 仍可能报警") is technically wrong — `v2TaskApi.ts` only does `import type` from the store, so there is no runtime cycle and no resolver warning

Per the brief's explicit guidance, I refactored to **inline the fetch** directly inside the store, matching the `loadSessions` pattern (line 648) for token retrieval and the `fetch('/api/...', { headers: { 'X-Zai-Token': token } })` URL shape.

**Final placement**: `packages/zai/src/web/src/store/useAgentStore.ts:983-996` — at the very end of `case 'runtime.tool_call':`, just before the `return` on line 997, immediately after `useAgentStore.getState().upsertToolCall(startMsg)`.

The block:
```ts
// V2 TaskList 增量刷新: 收到 TaskCreate / TaskUpdate tool_call 时,
// 异步重新拉一次 ~/.zai/tasks.json (server 已通过 tool call 写盘)
// 覆盖本地 v2TasksBySession 缓存. fire-and-forget, 失败静默 —
// 下次切会话/刷新会再拉一次兜底. 内联 fetch 而非 import v2TaskApi
// 是为了避开 store → v2TaskApi → store (type-only) 的 ESM 循环引用.
if (event.toolName === 'TaskCreate' || event.toolName === 'TaskUpdate') {
  void (async () => {
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sid)}/v2-tasks`,
        { headers: { 'X-Zai-Token': token } },
      )
      if (!res.ok) return
      const data = (await res.json()) as { tasks: V2TaskItem[] }
      useAgentStore.getState().setV2Tasks(sid, data.tasks)
    } catch { /* 静默 */ }
  })()
}
```

`V2TaskItem` is already exported from `useAgentStore.ts:20`, so no extra import is needed.

**Notes on the trigger list**: I kept only `TaskCreate` / `TaskUpdate` (per brief's ambiguity #3 — `TaskDelete` does not exist as a V2 tool).

## Diff stat

```
packages/zai/src/server/index.ts                |  4 ++++
packages/zai/src/server/routes/v2Tasks.ts       | 90 +++++++++++++++++++++++  (new file)
packages/zai/src/web/src/pages/Agent.tsx        | 22 ++++++++++++++++++++++
packages/zai/src/web/src/store/useAgentStore.ts | 19 +++++++++++++++++++
4 files changed, 135 insertions(+)
```

## Files touched (only these)

- `packages/zai/src/server/routes/v2Tasks.ts` (new)
- `packages/zai/src/server/index.ts` (register router)
- `packages/zai/src/web/src/pages/Agent.tsx` (useEffect on session change)
- `packages/zai/src/web/src/store/useAgentStore.ts` (inline fetch in SSE pipeline)

No other files modified. No dependencies added. Not pushed to remote. Untracked `.superpowers/` and `docs/superpowers/plans/2026-07-18-agent-bottom-status-bar.md` correctly left out of the commit.