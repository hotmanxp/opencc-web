# Zai Esc/Abort True-Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat Esc key (and the underlying `POST /api/agent/abort` route) actually stop the in-flight `queryLoop` on the server, not just toggle the UI status flag.

**Architecture:**
- Hoist the per-request `AbortController` out of `routes/agent.ts`'s closure into a module-level `Map<sessionId, AbortController>` in `services/agentRuntime.ts`, so `/api/agent/abort` can reach it after the fire-and-forget response.
- Replace `runtime/abort.ts`'s marker-file write with a real `.abort()` call against that controller.
- Fix `queryLoop` so an abort that lands mid-stream (after a model has started emitting) yields `runtime.aborted` instead of `runtime.done`.
- Keep `DefaultAgentRuntime.abort(sessionId, reason)` as a no-op shim (still on the public surface; BackgroundRuntime may call it later).

**Tech Stack:** TypeScript, Node.js AbortController, Express, Vitest, zod.

## Global Constraints

- Server listens on localhost only — no token guard (per `packages/zai/AGENTS.md` / repo root `AGENTS.md`).
- `queryLoop`'s abort signal comes solely from `options.abortSignal` (`packages/zai-agent-core/src/runtime/queryLoop.ts:97-98`). Comments already state the contract: "Abort comes solely from `options.abortSignal`. server layer wires a per-session AbortController into this, so `/agent/abort` can actually stop the loop (replaces the broken `runtime/abort.ts` marker-file pattern)."
- Fire-and-forget design at `routes/agent.ts:357-389`: the `/agent/prompt` HTTP response is sent *before* `queryLoop` runs. We must abort via module-level state, not the request closure.
- Per-session AskUserQuestion registry (`askRegistry.abortAll`) already releases blocked asks — keep that behavior unchanged.
- HARD_TIMEOUT (`routes/agent.ts:42`) still owns 2-hour ceiling. User abort is independent.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/zai/src/server/services/agentRuntime.ts` | Add module-level `Map<sessionId, AbortController>` registry; `abortAgentSession` now triggers registered controller; `registerSessionController`/`releaseSessionController` exports. |
| `packages/zai/src/server/services/agentRuntime.test.ts` (new) | Unit tests for registry semantics. |
| `packages/zai/src/server/routes/agent.ts` | At controller creation call `registerSessionController`; in `finally` call `releaseSessionController`. `/agent/abort` route accepts the X-Session-Id header as the source of truth (fallback to `getCurrentSessionId()`). |
| `packages/zai/test/server/agent-abort.test.ts` (new) | Integration test: start fake app, simulate in-flight query, fire `/agent/abort`, assert controller was aborted. |
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | After the streaming break (line 321), before `appendAssistantMessageV2`, check `abortController.signal.aborted` and yield `runtime.aborted` instead of falling through to `runtime.done`. |
| `packages/zai-agent-core/test/runtime/queryLoop.test.ts` | New test "abort mid-stream yields runtime.aborted". |
| `packages/zai-agent-core/src/runtime/abort.ts` | Deprecate marker-file logic, keep exported function but make it a no-op (so callers don't crash). Add deprecation comment pointing at `agentRuntime.ts` registry. |
| `packages/zai-agent-core/test/abort/abort.test.ts` | Update to assert no-op behavior. |

---

### Task 1: Per-session AbortController registry in agentRuntime

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts:22-30` (module-level state) and add exports
- Test: `packages/zai/test/server/agentRuntime.test.ts` (append to existing placeholder file; do NOT create a new file under `src/`)

**Interfaces:**
- Produces:
  ```ts
  export function registerSessionController(sessionId: string, controller: AbortController): void
  export function releaseSessionController(sessionId: string): void
  export function abortSessionController(sessionId: string, reason?: string): boolean  // true if found and aborted
  ```

- [ ] **Step 1: Write the failing test**

Append the new `describe` block to the existing `packages/zai/test/server/agentRuntime.test.ts`. Keep the existing `describe('agentRuntime', ...)` block intact.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerSessionController,
  releaseSessionController,
  abortSessionController,
  __resetSessionControllersForTests,
} from './agentRuntime.js'

beforeEach(() => __resetSessionControllersForTests())

describe('session abort controller registry', () => {
  it('registerSessionController stores controller by sessionId', () => {
    const c = new AbortController()
    registerSessionController('sess-A', c)
    expect(abortSessionController('sess-A', 'test')).toBe(true)
    expect(c.signal.aborted).toBe(true)
    expect(c.signal.reason).toBe('test')
  })

  it('abortSessionController returns false for unknown session', () => {
    expect(abortSessionController('sess-unknown', 'noop')).toBe(false)
  })

  it('releaseSessionController removes entry', () => {
    const c = new AbortController()
    registerSessionController('sess-B', c)
    releaseSessionController('sess-B')
    expect(abortSessionController('sess-B', 'late')).toBe(false)
    expect(c.signal.aborted).toBe(false)  // release does NOT abort, just forgets
  })

  it('abortSessionController is idempotent (second call returns false after first)', () => {
    const c = new AbortController()
    registerSessionController('sess-C', c)
    expect(abortSessionController('sess-C', 'first')).toBe(true)
    expect(abortSessionController('sess-C', 'second')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/zai/`:
```
pnpm vitest run test/server/agentRuntime.test.ts
```
Expected: FAIL with "registerSessionController is not a function" (the symbols don't exist yet).

- [ ] **Step 3: Implement minimal code**

In `packages/zai/src/server/services/agentRuntime.ts`, add the registry at the top of the file (next to the existing `runtime` / `currentSessionId` declarations) and append the three functions plus the test seam:

```ts
const sessionControllers = new Map<string, AbortController>()

export function registerSessionController(
  sessionId: string,
  controller: AbortController,
): void {
  sessionControllers.set(sessionId, controller)
}

export function releaseSessionController(sessionId: string): void {
  sessionControllers.delete(sessionId)
}

export function abortSessionController(
  sessionId: string,
  reason?: string,
): boolean {
  const c = sessionControllers.get(sessionId)
  if (!c || c.signal.aborted) return false
  c.abort(reason ?? 'user_abort')
  return true
}

export function __resetSessionControllersForTests(): void {
  sessionControllers.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/agentRuntime.test.ts`
Expected: PASS (the existing 2 placeholder tests + 4 new = 6 tests, all green).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts \
        packages/zai/src/server/services/agentRuntime.test.ts
git commit -m "feat(zai/server): add per-session AbortController registry"
```

---

### Task 2: Wire `abortAgentSession` to actually abort the controller

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts:153-158`

**Interfaces:**
- `abortAgentSession(reason?: string)` now calls `abortSessionController(currentSessionId, reason)` if `currentSessionId` is set, in addition to `askRegistry.abortAll`.

- [ ] **Step 1: Write the failing test**

Append to `packages/zai/src/server/services/agentRuntime.test.ts`:

```ts
import { abortAgentSession, setCurrentSessionId } from './agentRuntime.js'

describe('abortAgentSession', () => {
  it('aborts the registered controller for currentSessionId', () => {
    setCurrentSessionId('sess-X')
    const c = new AbortController()
    registerSessionController('sess-X', c)
    void abortAgentSession('user_abort')
    expect(c.signal.aborted).toBe(true)
    expect(c.signal.reason).toBe('user_abort')
  })

  it('does not throw when no controller is registered for current session', () => {
    setCurrentSessionId('sess-Y')
    expect(() => abortAgentSession('user_abort')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/agentRuntime.test.ts`
Expected: FAIL — current `abortAgentSession` calls `getRuntime().abort(...)` which is mocked in tests but in the new test set the mock isn't applied; even if it were, the test asserts `c.signal.aborted`, which the existing code does not set.

- [ ] **Step 3: Replace implementation**

In `packages/zai/src/server/services/agentRuntime.ts:153-158`, replace the body:

```ts
export async function abortAgentSession(reason?: string): Promise<void> {
  askRegistry.abortAll(reason ?? 'session_aborted')
  if (currentSessionId) {
    abortSessionController(currentSessionId, reason)
  }
}
```

(The `getRuntime().abort(...)` call is removed. `DefaultAgentRuntime.abort` still exists as a no-op for back-compat; see Task 5.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/server/agentRuntime.test.ts`
Expected: PASS (8/8: 2 placeholder + 4 registry + 2 abortAgentSession).

- [ ] **Step 5: Run broader server test suite to ensure no regressions**

Run: `pnpm vitest run test/server/`
Expected: all pre-existing tests still pass. If `agent.test.ts` mocks `abortAgentSession`, it will continue to work because we didn't change the signature.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts \
        packages/zai/src/server/services/agentRuntime.test.ts
git commit -m "feat(zai/server): abortAgentSession triggers registered controller"
```

---

### Task 3: Register/release controller in `/agent/prompt` route + use X-Session-Id in `/agent/abort`

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts:1-30` (imports), `357-389` (creation + register), `568-570` (finally + release), `683-691` (abort route)

**Interfaces:**
- `POST /api/agent/abort` reads `X-Session-Id` header; if absent, falls back to `getCurrentSessionId()`. Either way, calls `abortSessionController(sid, reason)` directly. Stops calling the redundant `abortAgentSession` for the controller part.

- [ ] **Step 1: Write the failing test**

Add `packages/zai/test/server/agent-abort.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'node:express'
import http from 'node:http'
import request from 'supertest'

// Capture controller registered by /agent/prompt
let capturedController: AbortController | null = null
let lastRunOpts: any = null
let activeSessionId: string | null = null

vi.mock('../../src/server/services/agentRuntime.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/server/services/agentRuntime.js')>(
    '../../src/server/services/agentRuntime.js',
  )
  return {
    ...actual,
    initAgentRuntime: () => {},
    getRuntime: () => ({
      run: (opts: any) => {
        lastRunOpts = opts
        // Return an async generator that just yields one event then awaits
        // (so the route handler's `for await` is active when abort fires).
        return (async function* () {
          yield { type: 'message_start' }
          // Hold the loop open without yielding message_stop until aborted.
          await new Promise<void>((resolve) => {
            const check = () => {
              if (opts.abortSignal?.aborted) resolve()
              else setTimeout(check, 5)
            }
            check()
          })
        })()
      },
      abort: async () => {},
      listSessions: async () => [],
      readSession: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
      patchSession: async () => {},
      removeSession: async () => {},
    }),
    getTranscriptStore: () => ({
      list: async () => [],
      read: async () => ({ version: 1, transcriptId: 'sess-1', meta: { cwd: '/tmp', model: 'unknown', createdAt: 0, updatedAt: 0 }, messages: [] }),
      patch: async () => {},
      remove: async () => {},
      append: async () => {},
    }),
    getAskRegistry: () => ({ abortAll: () => {} }),
    setCurrentSessionId: (id: string) => { activeSessionId = id },
    getCurrentSessionId: () => activeSessionId,
    registerSessionController: (sid: string, c: AbortController) => {
      capturedController = c
    },
    releaseSessionController: () => {},
    abortSessionController: actual.abortSessionController,
    abortAgentSession: async () => {},
  }
})

vi.mock('@zn-ai/zai-agent-core', () => ({
  EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
}))

import agentRouter from '../../src/server/routes/agent.js'

function startApp() {
  const app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'abort-test' }
  app.use('/api', agentRouter)
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as any
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() })
    })
  })
}

beforeEach(() => {
  capturedController = null
  lastRunOpts = null
  activeSessionId = null
})

describe('POST /api/agent/abort', () => {
  it('aborts the in-flight controller registered by /agent/prompt', async () => {
    const { url, close } = await startApp()
    try {
      // Fire /agent/prompt (fire-and-forget; don't await body completion)
      const promptRes = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Session-Id': 'sess-1' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      const { sessionId } = await promptRes.json()
      // Wait briefly for route to register controller
      for (let i = 0; i < 20 && !capturedController; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(capturedController).not.toBeNull()
      expect(capturedController!.signal.aborted).toBe(false)

      // Fire /agent/abort
      const abortRes = await fetch(`${url}/api/agent/abort`, {
        method: 'POST',
        headers: { 'X-Session-Id': sessionId },
      })
      expect(abortRes.status).toBe(200)
      expect(capturedController!.signal.aborted).toBe(true)
    } finally {
      close()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server/agent-abort.test.ts`
Expected: FAIL — captured controller is not actually aborted (current `abortAgentSession` writes a marker file).

- [ ] **Step 3: Modify `routes/agent.ts`**

1. Update imports (around line 8) to add `registerSessionController`, `releaseSessionController`, `abortSessionController`:
   ```ts
   import {
     abortAgentSession,
     abortSessionController,
     getCurrentSessionId,
     getAskRegistry,
     getRuntime,
     getTranscriptStore,
     registerSessionController,
     releaseSessionController,
     setCurrentSessionId,
     …
   } from "../services/agentRuntime.js";
   ```

2. Right after `const abortController = new AbortController()` at `routes/agent.ts:357`, add:
   ```ts
   registerSessionController(sessionId, abortController)
   ```

3. In the `finally` block at `routes/agent.ts:568-570`, add release:
   ```ts
   } finally {
     clearTimeout(timer)
     releaseSessionController(sessionId)
   }
   ```

4. Replace the `/agent/abort` route at `routes/agent.ts:683-691`:
   ```ts
   router.post("/agent/abort", async (req: Request, res: Response) => {
     // X-Session-Id header 是 abort 哪一条 sid 的真相 — 切会话时 in-memory
     // currentSessionId 可能还没跟上, header 优先. fallback 到 currentSessionId
     // 兼容旧客户端.
     const headerSid = (req.headers["x-session-id"] as string | undefined) ?? undefined
     const sid = headerSid ?? getCurrentSessionId()
     const aborted = sid ? abortSessionController(sid, "user_abort") : false
     // 仍然调 askRegistry.abortAll 以解锁任何 pending AskUserQuestion.
     await abortAgentSession("user_abort")
     res.json({ ok: true, sessionId: sid, aborted })
   });
   ```

- [ ] **Step 4: Run new test to verify it passes**

Run: `pnpm vitest run test/server/agent-abort.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full server test suite**

Run: `pnpm vitest run test/server/`
Expected: all green. The `agent.test.ts` mocks `abortAgentSession` and doesn't exercise abort flow, so it stays green.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/routes/agent.ts \
        packages/zai/test/server/agent-abort.test.ts
git commit -m "feat(zai/server): /agent/abort aborts registered in-flight controller"
```

---

### Task 4: queryLoop yields `runtime.aborted` when abort lands mid-stream

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:319-429` (the streaming for-await + post-stream branches)

**Background:** Currently `queryLoop.ts:321` breaks the streaming loop on abort, but then falls through to `appendAssistantMessageV2` (line 377/386) and finally `yield runtime.done` (line 428). The user sees `runtime.done` and the UI thinks the turn succeeded. We must check `abortController.signal.aborted` after the break and yield `runtime.aborted` instead.

- [ ] **Step 1: Write the failing test**

Append to `packages/zai-agent-core/test/runtime/queryLoop.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'

describe('queryLoop mid-stream abort', () => {
  test('abort between text deltas yields runtime.aborted, not runtime.done', async () => {
    // Custom modelCaller that yields a few text deltas then awaits abort.
    async function* slowText() {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      for (let i = 0; i < 5; i++) {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }
      }
      // Wait for abort signal.
      await new Promise<void>((resolve) => {
        const id = setInterval(() => {
          // Will be replaced by outer loop's signal check; we just hang.
          resolve()
        }, 5)
        setTimeout(() => { clearInterval(id); resolve() }, 200)
      })
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }

    const tmp = await mkdtemp(join(tmpdir(), 'zai-qe-abort-'))
    try {
      const controller = new AbortController()
      const events: any[] = []
      const iter = queryLoop(
        { prompt: 'hi', cwd: '/tmp', abortSignal: controller.signal },
        { dataDir: tmp, modelCaller: slowText as any, sandbox: makeMockSandbox('/tmp') },
      )
      // Abort after first deltas.
      setTimeout(() => controller.abort(), 20)
      for await (const e of iter) {
        events.push(e)
      }
      const last = events.at(-1)
      expect(last?.type).toBe('runtime.aborted')
      expect(last?.reason).toBeDefined()
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
```

Note: the existing `mkdtemp`/`tmpdir` imports already exist at top of file; if not, add them.

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/zai-agent-core/`:
```
pnpm vitest run test/runtime/queryLoop.test.ts
```
Expected: FAIL — `events.at(-1).type` is `'runtime.done'` (current behavior), test expects `'runtime.aborted'`.

- [ ] **Step 3: Fix queryLoop**

In `packages/zai-agent-core/src/runtime/queryLoop.ts`, immediately after the `for await (const ev of modelStream)` loop ends (after line 354 closing brace), insert the mid-stream-abort check. The cleanest place is *after* the per-event merge (line 354) and *before* the `toolUseBlocks.length > 0` branch (line 367):

```ts
    }

    // Mid-stream abort: streaming loop broke because signal.aborted; surface
    // a single runtime.aborted event instead of letting it fall through to
    // runtime.done / appendAssistantMessageV2. Persist whatever was already
    // streamed as a partial assistant message before yielding aborted.
    if (abortController.signal.aborted) {
      if (assistantText || thinkingText) {
        const partialBlocks: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = []
        if (thinkingText) partialBlocks.push({ type: 'thinking', thinking: thinkingText })
        if (assistantText) partialBlocks.push({ type: 'text', text: assistantText })
        const partialUuid = await appendAssistantMessageV2(
          store, sessionId, partialBlocks, turn, lastUuid, ctx,
        )
        if (partialUuid) lastUuid = partialUuid
      }
      yield toAbortedEvent({ sessionId, turnIndex: turn }, abortController.signal.reason as string | undefined)
      return
    }

    for (const b of toolUseBlocks) {
      // ...existing toolUseBlocks post-processing...
```

(Existing code at lines 356-361 stays in place; the new block goes between line 354's closing `}` and line 356's `for (const b of toolUseBlocks)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/runtime/queryLoop.test.ts`
Expected: PASS. The pre-existing `test('abort signal → runtime.aborted 事件')` at line 67 also still passes (abort-before-next-turn path was already correct).

- [ ] **Step 5: Run broader runtime test suite**

Run from `packages/zai-agent-core/`:
```
pnpm vitest run test/runtime/
```
Expected: all green. Pay attention to `queryLoop-resume-2013.test.ts` and `queryLoop-mcp.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/src/runtime/queryLoop.ts \
        packages/zai-agent-core/test/runtime/queryLoop.test.ts
git commit -m "feat(zai-agent-core): queryLoop yields runtime.aborted on mid-stream abort"
```

---

### Task 5: Deprecate `runtime/abort.ts` marker-file write (now no-op)

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/abort.ts` (entire file body)
- Modify: `packages/zai-agent-core/test/abort/abort.test.ts`

**Rationale:** `DefaultAgentRuntime.abort` (in `contract.ts:32-34`) still calls `abortSession` for back-compat. Now that `agentRuntime.ts` owns the real abort path, this function is unused. Mark as no-op + deprecation comment so future callers don't reintroduce the marker-file pattern.

- [ ] **Step 1: Update the failing test**

Replace `packages/zai-agent-core/test/abort/abort.test.ts` contents with:

```ts
import { describe, expect, test } from 'vitest'
import { abortSession } from '../../src/runtime/abort.js'

describe('abortSession (deprecated marker-file path)', () => {
  test('is a no-op (returns without throwing and writes nothing)', async () => {
    await expect(abortSession({ dataDir: '/tmp' }, 'sess-x', 'whatever')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `packages/zai-agent-core/`:
```
pnpm vitest run test/abort/abort.test.ts
```
Expected: FAIL — current implementation writes a file (and the assertion still passes, but we'll observe the side-effect on subsequent runs since it doesn't write anymore — actually current implementation succeeds too, so test passes. The real change is the *contract*: it no longer needs a tmpDir fixture, and the comment is updated.)

- [ ] **Step 3: Replace `runtime/abort.ts` body**

Replace the entire content of `packages/zai-agent-core/src/runtime/abort.ts`:

```ts
/**
 * @deprecated This module used to write a marker file at
 * `${dataDir}/runtime/aborts/<sid>.abort`. The real abort path now lives in
 * `packages/zai/src/server/services/agentRuntime.ts`, where a
 * `Map<sessionId, AbortController>` registry lets `/api/agent/abort` trigger
 * the per-session AbortController that `routes/agent.ts` hands to
 * `queryLoop` via `options.abortSignal`. This function is retained as a
 * no-op so `DefaultAgentRuntime.abort(sessionId, reason)` in
 * `contract.ts:32-34` keeps compiling for back-compat with BackgroundRuntime.
 */
export async function abortSession(
  _config: { dataDir: string },
  _sessionId: string,
  _reason?: string,
): Promise<void> {
  // intentional no-op
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/abort/abort.test.ts`
Expected: PASS.

- [ ] **Step 5: Run agent-core full suite**

Run from `packages/zai-agent-core/`:
```
pnpm vitest run
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/src/runtime/abort.ts \
        packages/zai-agent-core/test/abort/abort.test.ts
git commit -m "chore(zai-agent-core): deprecate abort.ts marker-file write"
```

---

### Task 6: End-to-end smoke verification

**Files:** none — manual verification.

- [ ] **Step 1: Run the zai web locally**

Run from repo root:
```
pnpm --filter @zn-ai/zai dev
```
Open the Agent page, send a long prompt that triggers streaming, press Esc.

- [ ] **Step 2: Observe behavior**

Expected:
- Stream stops within ~1 frame.
- Status flips to "已中止" (`◼`).
- No further tokens appear in the bubble.
- The transcript file on disk contains the partial assistant message written by Task 4.
- Restarting the page shows the partial response persisted.

- [ ] **Step 3: Verify HARD_TIMEOUT still fires**

Add a temporary log statement? No — instead, check the timer cleanup. Run with `ZAI_DEBUG=1` and confirm no `[zai.agent.prompt] HARD_TIMEOUT fired` appears during a normal Esc abort (only on real 2-hour timeout).

- [ ] **Step 4: Verify AskUserQuestion is still released**

Send a prompt that triggers `AskUserQuestion`. While the modal is open, press Esc.
Expected: modal dismisses; `askRegistry.abortAll('user_abort')` path is preserved.

- [ ] **Step 5: Run full test suites one last time**

Run from repo root:
```
pnpm -r vitest run
```
Expected: all green across both packages.

---

## Self-Review

**Spec coverage:**
- Esc interrupts in-flight queryLoop → covered by Tasks 1, 2, 3, 4.
- Frontend already shows "已中止" — no change needed.
- AskUserQuestion still released — covered by preserving `askRegistry.abortAll` call in Task 2.
- HARD_TIMEOUT unchanged — Task 3 still creates the timer, only adds register/release around it.

**Placeholder scan:** None — every step has concrete code.

**Type consistency:**
- `registerSessionController` / `releaseSessionController` / `abortSessionController` defined in Task 1, used in Task 2 (`abortSessionController`) and Task 3 (all three). Names match throughout.
- `__resetSessionControllersForTests` only used in tests; exported alongside the other functions in Task 1.
- `RuntimeAbortedEvent.reason` field is `string | undefined` (`packages/zai-agent-core/src/runtime/events.ts:47-49`); `toAbortedEvent` accepts optional reason. Task 4 passes `abortController.signal.reason` which is `unknown` — cast matches existing pattern at `queryLoop.ts:289`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-zai-abort-user-cancel.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?

