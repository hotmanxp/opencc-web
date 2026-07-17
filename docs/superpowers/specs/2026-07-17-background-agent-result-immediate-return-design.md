# BackgroundAgentResultTool — Immediate-return semantics

**Status:** Draft
**Date:** 2026-07-17
**Scope:** `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.ts`

## Problem

`BackgroundAgentResultTool` blocks until the referenced background task finishes, even when the caller passes `waitMs=0`. The blocking path is `BackgroundAgentResultTool.ts:116`:

```ts
for await (const ev of runtime.events(input.shortId)) {
  events.push(ev)
}
```

`runtime.events()` (`DefaultBackgroundRuntime.ts:137-194`) replays historical events from the store, then — if the task is still `running` or `queued` — enters a **live-tail loop** that `await wakeup`s until the emitter fires `done`. The loop has no timeout and the call site does not pass `ctx.abortSignal`, so the loop only exits when the background task terminates.

For an LLM that wants a quick status check ("is task X done yet?") this is wrong: the tool call hangs for the entire duration of the background task, blocking the parent agent's turn.

## Goal

`BackgroundAgentResultTool` returns immediately when the caller does not ask to wait. The LLM gets a status-only response and can decide whether to:
- stop checking and continue other work (fire-and-forget — task notification will arrive later),
- poll again later,
- explicitly opt in to a bounded wait by passing `waitMs > 0`.

## Behavior contract

| Input | Task state | Behavior | Response time |
|-------|-----------|----------|---------------|
| `waitMs=0` (default) | `running` / `queued` | Call `runtime.get()` only. Return status + resultText + error. **Do NOT call `runtime.events()`.** | <10ms |
| `waitMs=0` | terminal (`completed` / `failed` / `cancelled`) | Same status-only response. | <10ms |
| `waitMs>0` | `running` / `queued` | `await waitOrAbort(waitMs, ctx.abortSignal)` then call `runtime.events(shortId, 0, ctx.abortSignal)` and collect events until terminal or abort. | ≤ waitMs + ~50ms |
| `waitMs>0` | terminal | Call `runtime.events(shortId, 0, ctx.abortSignal)` once (no live tail) and return full tail output. | <100ms |
| any | `runtime.get()` returns null | Return `task not found: <shortId>` with `isError=true`. | <5ms |

### Status-only output format (waitMs=0)

```
id: <shortId>
status: <running|queued|completed|failed|cancelled>
prompt: <first 100 chars>
createdAt: <ISO>
startedAt: <ISO>      # only if set
finishedAt: <ISO>     # only if set
error: <msg> (<category>)   # only if task.error
resultText: <text>     # only if set
```

No `--- output (tail) ---` block — the caller did not ask for events.

### Full output format (waitMs>0)

Same as today's contract: status header + `--- output (tail) ---` + tail of eventsToText.

## Implementation outline

Inside `BackgroundAgentResultTool.ts`:

1. After the existing `runtime.get()` + `task not found` early-return, branch on `input.waitMs === 0`:
   - Build the status-only output via a new private `buildStatusOnlyHeader(task)` helper.
   - Return immediately. `runtime.events()` is never invoked on this path.
2. For `waitMs > 0`:
   - If `task.status` is `running` or `queued`, `await waitOrAbort(input.waitMs, ctx.abortSignal)` (new private helper).
   - Replace the existing `for await (const ev of runtime.events(input.shortId))` with `for await (const ev of runtime.events(input.shortId, 0, ctx.abortSignal))` so the iterator can be aborted.
3. Existing `eventsToText` / `tailLines` / full-output header logic stays unchanged.

### `waitOrAbort(ms, signal)`

```ts
async function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}
```

Resolve on either timeout or abort — never reject. The downstream `runtime.events(id, 0, signal)` will respect the same signal and exit early when aborted.

### `buildStatusOnlyHeader(task)`

Mirrors the existing header array (`id`, `status`, `prompt`, `createdAt`, `startedAt`, `finishedAt`, `events`, `error`, `resultText`) but **omits** the trailing `--- output (tail) ---` marker and the events tail. Used only on the `waitMs=0` path.

## Prompt update

`prompt.ts` must reflect that `waitMs=0` means "return immediately with status only" rather than "don't wait but still read events". New wording:

```
查询后台任务的状态与输出。

用法:
- 传 shortId(BackgroundAgent 派发时返回的 ID)
- 可选 tailLines:返回输出末尾多少行(默认 200)。仅 waitMs > 0 时生效。
- 可选 waitMs:
    - 0(默认):立即返回 status + resultText, 不读 events, 不阻塞。任务在跑也立即返回。
    - >0:等待 N 毫秒或任务完成(取先到)后读 events 返回。

返回:
- status:queued / running / completed / failed / cancelled
- 终态 + waitMs>0:events 流的尾部输出
- 任意状态 + waitMs=0:仅 status + resultText + error
- error:如果有失败原因
```

## Tests

New file: `packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts`.

Use the existing mock-Runtime pattern (see `packages/zai/src/server/routes/tasks.test.ts`). The mock's `events()` MUST return an AsyncIterable that never resolves on its own — this is the canary that proves the `waitMs=0` path is not entering the live tail.

Cases:

1. `waitMs=0 + running task` → mock.events() never invoked, output is status-only, completes in <50ms.
2. `waitMs=0 + completed task` → mock.events() never invoked, output includes resultText, no `--- output (tail) ---` marker.
3. `waitMs=0 + failed task` → `isError=true`, status-only output.
4. `waitMs=0 + cancelled task` → `isError=false`, status-only output.
5. `waitMs>0 + running task that completes within waitMs` → events() invoked with abortSignal; full output includes `--- output (tail) ---`.
6. `waitMs>0 + running task + ctx.abortSignal aborts mid-wait` → returns within 200ms with whatever events were collected so far (status still `running`).
7. `waitMs>0 + already-completed task` → events() invoked without entering live tail, full output returned.
8. `shortId not found` → `task not found: <id>` with `isError=true`, events() never invoked.
9. `hasBackgroundRuntime() === false` → existing not-initialized error path unchanged.

Run: `cd packages/zai-agent-core && bun test test/tools/BackgroundAgentResultTool/`.

## Out of scope

- `TaskOutputTool` (`src/tools/TaskOutputTool/`) — uses its own `block + timeout` loop and is intentionally different (aligned with opencc's TaskOutput). No change.
- `runtime.events()` interface — unchanged. The fix lives in `BackgroundAgentResultTool` and only adds `signal` threading on the existing `events(id, fromSeq, signal)` signature.
- Frontend SSE route `packages/zai/src/server/routes/tasks.ts` — calls `runtime.events()` independently for live updates; unaffected.
- Schema (`BackgroundAgentResultInputSchema`) — fields and defaults stay (`waitMs` already defaults to 0).

## Migration / compatibility

- Public schema unchanged. Any caller that today relies on `BackgroundAgentResult` blocking until completion must explicitly pass `waitMs >= 60000` to recover the previous behavior. This is the intended behavior shift and is documented in the prompt string.
- No persisted state or wire-protocol change.

## Files touched

- `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.ts` — branching logic, two new private helpers, signal threading into `runtime.events`.
- `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/prompt.ts` — updated wording.
- `packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts` — new test file.