# BackgroundAgentResultTool Immediate-Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `BackgroundAgentResultTool` so `waitMs=0` (the default) returns immediately with status only, never blocking on the live-tail of `runtime.events()`. `waitMs>0` must thread `ctx.abortSignal` into `runtime.events()` and exit on either the timer or abort.

**Architecture:** Branch the existing `call()` body on `input.waitMs === 0` before any call to `runtime.events()`. Introduce two small private helpers (`buildStatusOnlyHeader`, `waitOrAbort`) to keep the call site readable. Update the prompt string to describe the new semantics. Add a vitest suite that proves the `waitMs=0` path never invokes `runtime.events()` (using a mock whose `events()` is intentionally non-resolving).

**Tech Stack:** TypeScript, vitest, `DefaultBackgroundRuntime` (from `@zn-ai/zai-agent-core`), bun test runner.

## Global Constraints

- `BackgroundAgentResultInputSchema` fields and defaults stay unchanged (`shortId: required`, `tailLines: default 200`, `waitMs: default 0`).
- Public tool name `BackgroundAgentResult` stays unchanged.
- `runtime.events()` interface (`BackgroundRuntime.ts`) stays unchanged.
- `TaskOutputTool` is out of scope and stays unchanged.
- Style: keep edits inside `BackgroundAgentResultTool.ts` and `prompt.ts`; do not restructure the file.
- Tests use vitest (matching `packages/zai-agent-core/test/tools/AgentTool.test.ts` style).
- The mock `events()` in the new test file must return an `AsyncIterable` that **never resolves on its own** — that is the canary proving the `waitMs=0` path skips `events()`.

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.ts` | Modify | Branch call() on waitMs, add two helpers, thread signal into runtime.events |
| `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/prompt.ts` | Modify | Document new waitMs semantics |
| `packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts` | Create | Vitest suite with 9 cases covering waitMs=0/waitMs>0/not-found/not-initialized |

---

### Task 1: Failing tests for new behavior

**Files:**
- Create: `packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts`

**Interfaces:**
- Consumes: `BackgroundAgentResultTool` (existing), `BackgroundRuntime` interface, `setBackgroundRuntime`/`getBackgroundRuntime` registry, `hasBackgroundRuntime` helper.
- Produces: a vitest suite that fails until Task 2 lands.

- [ ] **Step 1: Create test file with mock runtime skeleton**

Write `packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import {
  BackgroundAgentResultTool,
} from '../../../src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.js'
import type { ToolContext } from '../../../src/tools/Tool.js'
import {
  setBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../../src/runtime/background/index.js'
import type {
  BackgroundRuntime,
  BackgroundTask,
  DispatchInput,
  TaskEvent,
} from '../../../src/runtime/background/index.js'

/**
 * Mock runtime whose events() is intentionally non-resolving.
 * If BackgroundAgentResultTool's waitMs=0 path ever awaits it,
 * the test will time out — which is exactly the canary we want.
 */
function makeRuntime(task: BackgroundTask | null, opts: { eventsCalls: number[] }): BackgroundRuntime {
  return {
    async dispatch(_input: DispatchInput): Promise<BackgroundTask> {
      throw new Error('not used')
    },
    async get(id: string): Promise<BackgroundTask | null> {
      return task && task.id === id ? task : null
    },
    async list() {
      return task ? [task] : []
    },
    async cancel() {
      return { ok: false }
    },
    events(id: string, _fromSeq = 0, _signal?: AbortSignal): AsyncIterable<TaskEvent> {
      opts.eventsCalls.push(Date.now())
      return (async function* () {
        await new Promise<never>(() => {})
      })()
    },
    async shutdown() {},
  }
}

function makeTask(overrides: Partial<BackgroundTask> & { id: string; status: BackgroundTask['status'] }): BackgroundTask {
  const base: BackgroundTask = {
    id: overrides.id,
    status: overrides.status,
    input: { prompt: 'do something', cwd: '/tmp', agent: 'general-purpose' },
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: undefined,
    resultText: overrides.resultText,
    error: overrides.error,
  }
  return { ...base, ...overrides }
}

function makeCtx(): ToolContext {
  return {
    cwd: '/tmp',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/tmp',
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    __runtimeConfig: {} as any,
    __defaultModel: 'test',
    __maxTurns: 1,
    parentSessionId: 'sess-test',
  } as ToolContext
}

let runtime: BackgroundRuntime
let eventsCalls: number[]

beforeEach(() => {
  eventsCalls = []
})

afterEach(() => {
  setBackgroundRuntime(null)
})

describe('BackgroundAgentResultTool — immediate return (waitMs=0)', () => {
  test('waitMs=0 + running task returns status without calling events()', async () => {
    const task = makeTask({ id: 'abc', status: 'running' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(r.isError).toBeFalsy()
    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: running')
    expect(r.output as string).not.toContain('--- output (tail) ---')
  })

  test('waitMs=0 + completed task returns status + resultText without calling events()', async () => {
    const task = makeTask({ id: 'abc', status: 'completed', resultText: 'final answer' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: completed')
    expect(r.output as string).toContain('resultText: final answer')
    expect(r.output as string).not.toContain('--- output (tail) ---')
  })

  test('waitMs=0 + failed task returns isError=true without calling events()', async () => {
    const task = makeTask({
      id: 'abc',
      status: 'failed',
      error: { category: 'llm_provider', message: 'boom', recoverable: false },
    })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(r.isError).toBe(true)
    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: failed')
    expect(r.output as string).toContain('error: boom')
  })

  test('waitMs=0 + cancelled task returns isError=false without calling events()', async () => {
    const task = makeTask({ id: 'abc', status: 'cancelled' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(r.isError).toBe(false)
    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: cancelled')
  })

  test('waitMs>0 + running task calls events() with ctx.abortSignal', async () => {
    const calls: { fromSeq?: number; signal?: AbortSignal }[] = []
    const task = makeTask({ id: 'abc', status: 'running' })
    runtime = {
      ...makeRuntime(task, { eventsCalls }),
      events(id, fromSeq, signal) {
        calls.push({ fromSeq, signal })
        return (async function* () {
          yield {
            seq: 1, id: 'abc', type: 'message_start',
            ts: Date.now(), data: {},
          } as unknown as TaskEvent
          await new Promise<never>(() => {})
        })()
      },
    }
    setBackgroundRuntime(runtime)

    const ac = new AbortController()
    const ctx = { ...makeCtx(), abortSignal: ac.signal }
    const callPromise = BackgroundAgentResultTool.call(
      { shortId: 'abc', waitMs: 50 },
      ctx,
    )
    setTimeout(() => ac.abort(), 100)
    const r = await callPromise

    expect(calls[0]?.signal).toBe(ctx.abortSignal)
    expect(r.output as string).toContain('status: running')
  })

  test('waitMs>0 + already-completed task calls events() and returns full tail output', async () => {
    const task = makeTask({ id: 'abc', status: 'completed', resultText: 'done' })
    runtime = {
      ...makeRuntime(task, { eventsCalls }),
      events(id, fromSeq, signal) {
        return (async function* () {
          yield {
            seq: 1, id: 'abc', type: 'content_block_delta',
            ts: Date.now(),
            data: { delta: { type: 'text_delta', text: 'partial work' } },
          } as unknown as TaskEvent
          yield {
            seq: 2, id: 'abc', type: 'runtime.done',
            ts: Date.now(), data: { text: 'final' },
          } as unknown as TaskEvent
        })()
      },
    }
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 50 }, makeCtx())

    expect(r.output as string).toContain('--- output (tail) ---')
    expect(r.output as string).toContain('partial work')
    expect(r.output as string).toContain('final')
  })

  test('ctx.abortSignal aborts waitMs>0 path within bounded time', async () => {
    const task = makeTask({ id: 'abc', status: 'running' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const ac = new AbortController()
    const ctx = { ...makeCtx(), abortSignal: ac.signal }

    const start = Date.now()
    const p = BackgroundAgentResultTool.call(
      { shortId: 'abc', waitMs: 60000 },
      ctx,
    )
    setTimeout(() => ac.abort(), 100)
    const r = await p
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(r.output as string).toContain('status: running')
  })

  test('shortId not found returns task-not-found with isError=true, no events() call', async () => {
    runtime = makeRuntime(null, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'missing', waitMs: 0 }, makeCtx())

    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('task not found: missing')
    expect(eventsCalls.length).toBe(0)
  })

  test('hasBackgroundRuntime()=false returns the not-initialized error path', async () => {
    setBackgroundRuntime(null)
    expect(hasBackgroundRuntime()).toBe(false)
    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('未初始化')
  })
})
```

- [ ] **Step 2: Run the new test file and verify it fails pre-fix**

Run: `cd packages/zai-agent-core && bun test test/tools/BackgroundAgentResultTool/immediate-return.test.ts`

Expected behavior pre-fix:
- Cases 1-4 hang because the current `call()` enters `for await (const ev of runtime.events(...))` even when `waitMs=0`, and the mock's `events()` never yields.
- Case 5 fails on `calls[0].signal` because the current code does not thread `ctx.abortSignal`.
- Case 6 passes by accident (mock yields events promptly).
- Case 7 hangs ~60s before failing on elapsed assertion.
- Cases 8-9 pass.

If the suite hangs as a whole, kill it after ~30s and proceed — partial failure is enough evidence the bug is real. The goal is to demonstrate failures, not a clean run.

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/test/tools/BackgroundAgentResultTool/immediate-return.test.ts
git commit -m "test(zai-agent-core): failing cases for BackgroundAgentResultTool waitMs=0 immediate return"
```

---

### Task 2: Implement waitMs=0 branch + helpers + signal threading

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.ts`
- Modify: `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/prompt.ts`

**Interfaces:**
- Consumes: `BackgroundAgentResultInput` (from schema), `BackgroundRuntime` interface, `TaskEvent`, `BackgroundTask` types.
- Produces: two new private helpers `buildStatusOnlyHeader(task)` and `waitOrAbort(ms, signal?)`, and a `call()` that branches on `input.waitMs`.

- [ ] **Step 1: Add `BackgroundTask` to imports**

In `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.ts`, replace the import block at the top:

```ts
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../runtime/background/index.js'
```

with:

```ts
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
  type BackgroundTask,
} from '../../runtime/background/index.js'
```

- [ ] **Step 2: Add `buildStatusOnlyHeader` helper above the tool definition**

Immediately above `export const BackgroundAgentResultTool`, insert:

```ts
/**
 * Status-only output for the waitMs=0 path. Omits the `--- output (tail) ---`
 * block because the caller did not ask for events.
 */
function buildStatusOnlyHeader(task: BackgroundTask): string {
  const lines: string[] = [
    `id: ${task.id}`,
    `status: ${task.status}`,
    `prompt: ${task.input.prompt.slice(0, 100)}`,
    `createdAt: ${new Date(task.createdAt).toISOString()}`,
    task.startedAt ? `startedAt: ${new Date(task.startedAt).toISOString()}` : '',
    task.finishedAt ? `finishedAt: ${new Date(task.finishedAt).toISOString()}` : '',
    task.error ? `error: ${task.error.message} (${task.error.category})` : '',
    task.resultText ? `resultText: ${task.resultText}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}
```

- [ ] **Step 3: Add `waitOrAbort` helper next to `buildStatusOnlyHeader`**

```ts
/**
 * Wait up to `ms` milliseconds. Resolves early on `signal.abort`.
 * Never rejects — abort is a normal exit path.
 */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}
```

- [ ] **Step 4: Refactor the body of `call()` to branch on `waitMs === 0`**

Replace the existing `async call(rawInput, ctx) { ... }` body inside `BackgroundAgentResultTool` with:

```ts
async call(rawInput, ctx) {
  const input = rawInput as BackgroundAgentResultInput
  if (!hasBackgroundRuntime()) {
    return {
      output:
        'BackgroundAgentResult 当前不可用:BackgroundRuntime 未初始化。',
      isError: true,
    }
  }
  try {
    const runtime = getBackgroundRuntime()
    const task = await runtime.get(input.shortId)
    if (!task) {
      return {
        output: `task not found: ${input.shortId}`,
        isError: true,
      }
    }

    // waitMs=0: 立即返回 status, 不进入 runtime.events()(其 live tail 会阻塞到任务结束)
    if (input.waitMs === 0) {
      return {
        output: buildStatusOnlyHeader(task),
        isError: task.status === 'failed',
      }
    }

    // waitMs>0: 等待指定时长(或 abort), 再读 events
    if (task.status === 'running' || task.status === 'queued') {
      await waitOrAbort(input.waitMs, ctx.abortSignal)
    }

    const events: TaskEvent[] = []
    for await (const ev of runtime.events(input.shortId, 0, ctx.abortSignal)) {
      events.push(ev)
    }

    const text = eventsToText(events)
    const tail = tailLines(text, input.tailLines)

    const header = [
      `id: ${task.id}`,
      `status: ${task.status}`,
      `prompt: ${task.input.prompt.slice(0, 100)}`,
      `createdAt: ${new Date(task.createdAt).toISOString()}`,
      task.startedAt ? `startedAt: ${new Date(task.startedAt).toISOString()}` : '',
      task.finishedAt ? `finishedAt: ${new Date(task.finishedAt).toISOString()}` : '',
      `events: ${events.length}`,
      task.error ? `error: ${task.error.message} (${task.error.category})` : '',
      task.resultText ? `resultText: ${task.resultText}` : '',
      '--- output (tail) ---',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      output: `${header}\n${tail}`,
      isError: task.status === 'failed',
    }
  } catch (err) {
    return {
      output: `BackgroundAgentResult failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}
```

- [ ] **Step 5: Update the prompt to describe the new semantics**

Replace the body of `renderBackgroundAgentResultPrompt()` in `packages/zai-agent-core/src/tools/BackgroundAgentResultTool/prompt.ts` with:

```ts
export function renderBackgroundAgentResultPrompt(): string {
  return [
    '查询后台任务的状态与输出。',
    '',
    '用法:',
    '- 传 shortId(BackgroundAgent 派发时返回的 ID)',
    '- 可选 tailLines:返回输出末尾多少行(默认 200)。仅 waitMs > 0 时生效。',
    '- 可选 waitMs:',
    '    - 0(默认):立即返回 status + resultText, 不读 events, 不阻塞。任务在跑也立即返回。',
    '    - >0:等待 N 毫秒或任务完成(取先到)后读 events 返回。父 agent 主动 abort 时也会提前返回。',
    '',
    '返回:',
    '- status:queued / running / completed / failed / cancelled',
    '- 终态 + waitMs>0:events 流的尾部输出',
    '- 任意状态 + waitMs=0:仅 status + resultText + error,不含 events 段',
    '- error:如果有失败原因',
  ].join('\n')
}
```

- [ ] **Step 6: Run the new tests and verify all 9 cases pass**

Run: `cd packages/zai-agent-core && bun test test/tools/BackgroundAgentResultTool/immediate-return.test.ts`

Expected: `9 pass, 0 fail`. Total runtime should be < 1s — if any test takes >2s, the canary is failing and a waitMs=0 path is wrongly entering `runtime.events()`.

- [ ] **Step 7: Run the full zai-agent-core test suite to confirm no regressions**

Run: `cd packages/zai-agent-core && bun test 2>&1 | tail -10`

Expected: pre-existing failures unrelated to this change remain (e.g. `GrepTool vi.resetModules`), but no NEW failures introduced. Confirm transcript v2 tests still pass:

```bash
cd /Users/ethan/code/opencc-web/packages/zai-agent-core && bun test test/transcript/serialization-v2.test.ts test/transcript/types-v2.test.ts
```

Expected: `7 pass, 0 fail`.

- [ ] **Step 8: Commit the fix**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.ts \
        packages/zai-agent-core/src/tools/BackgroundAgentResultTool/prompt.ts
git commit -m "fix(zai-agent-core): BackgroundAgentResultTool returns immediately when waitMs=0

waitMs=0 (default) path now calls runtime.get() and returns status only,
never invoking runtime.events() — whose live-tail loop blocks until the
background task finishes. waitMs>0 path threads ctx.abortSignal into
both waitOrAbort() and runtime.events(id, 0, signal) so a parent abort
exits the iterator promptly instead of waiting on the timer."
```

- [ ] **Step 9: Push the two commits**

```bash
cd /Users/ethan/code/opencc-web
git push origin main
```

---

## Self-Review

**Spec coverage:**
- ✅ Behavior contract table (6 branches) → Task 2 step 4 implements all six via the `waitMs === 0` branch + `waitOrAbort` + signal-threaded events.
- ✅ Status-only output format → Task 2 step 2 (`buildStatusOnlyHeader`).
- ✅ Full output format unchanged → Task 2 step 4 keeps the existing header + tail logic verbatim.
- ✅ `waitOrAbort` semantics (resolve on timer or abort, never reject) → Task 2 step 3.
- ✅ Prompt update (default waitMs=0 returns status only, no events) → Task 2 step 5.
- ✅ 9 test cases enumerated in spec → Task 1 step 1 covers all 9.
- ✅ Out of scope items (`TaskOutputTool`, `runtime.events()` interface, schema defaults, frontend SSE route) — left untouched; listed in Global Constraints.

**Placeholder scan:** No `TBD`/`TODO`/`similar to`/`appropriate`/`fill in details`. Every code block is complete. Commands include expected output.

**Type consistency:**
- `BackgroundAgentResultInput` from schema (unchanged) — used identically to current code.
- `BackgroundTask` from `../../runtime/background/index.js` — Task 2 step 1 adds it to imports.
- `TaskEvent` already imported in the file.
- `ctx.abortSignal` already present on `ToolContext` per existing usage in `call()`.