# zai modelCaller 业务级 529/429/5xx 自动重试 — 实现 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap `createAnthropicModelCaller` generator with a while-retry loop so transient 529/429/5xx errors at SDK create stage auto-recover with exponential backoff, mirroring `DefaultBackgroundRuntime` semantics. Emit a `runtime.retrying` SSE event between attempts so the frontend shows progress.

**Architecture:** 3 layers — (1) zod schema adds `runtime.retrying` to `RuntimeEvent` union so the SSE contract is type-safe end-to-end; (2) `useAgentStore.applyRuntimeEvent` consumes `runtime.retrying` and shows a toast + sets `status='retrying'`; (3) the `createAnthropicModelCaller` generator wraps `client.messages.create` + `for-await` in a while loop that imports `classifyRetryableError` / `getRetryDelay` / `retrySleep` / `RETRY_POLICY` from `@zn-ai/zai-agent-core/runtime` (already re-exported via `runtime/index.ts:58`).

**Tech Stack:** TypeScript ESM, vitest (both packages), zod 3.x, `@anthropic-ai/sdk` 0.52.x, `node:fs` / `node:os` for settings mocking.

## Global Constraints
- **Budget** — `RETRY_POLICY.max529Retries = 3` (consecutive 529/429 cap) and `RETRY_POLICY.maxRetries = 10` (5xx total attempt cap). Imported as constants, not hardcoded.
- **Backoff** — `RETRY_POLICY.baseDelayMs = 500` → `RETRY_POLICY.maxDelayMs = 32_000`, 25% jitter via `getRetryDelay(attempt)`.
- **Scope** — Only retry the SDK create stage (`eventCount === 0`). Mid-stream throws (`eventCount > 0`) **do NOT retry** to avoid discarding already-streamed deltas.
- **Abort** — `signal.aborted` is checked at while-loop top and after `retrySleep`. Abort throws `DOMException(reason, 'AbortError')`, not a generic Error.
- **Reuse** — All retry helpers come from `@zn-ai/zai-agent-core/runtime` (already exports `./background/index.js`). Do NOT duplicate `classifyRetryableError` / `getRetryDelay` / `retrySleep`.
- **No new deps** — `package.json` is not touched.
- **Mock SDK** — `vi.mock('@anthropic-ai/sdk', ...)` + `vi.mock('node:os', ...)` to redirect `homedir()` to a tmp dir containing `~/.zai/settings.json`. Each test queues throw/stream responses.
- **SDK `maxRetries: 2`** stays as-is (per spec §2.5). The new business layer wraps around it.
- **Conventional commits** — `feat(zai/...)` for new behavior, `test(zai/...)` if test-only.

---

### Task 1: Add `runtime.retrying` to RuntimeEvent zod schema + TypeScript type

**Files:**
- Modify: `packages/zai/src/shared/events.ts:49-62` (insert new zod variant before `runtime.compacted`)
- Test: `packages/zai/test/shared/events-runtime-retrying.test.ts` (new)

**Interfaces:**
- Consumes: existing `Base = z.object({...})` pattern (`packages/zai/src/shared/events.ts:3`)
- Produces: `RuntimeEventSchema` zod union + inferred TS type now includes a `runtime.retrying` variant with required fields `attempt`, `delayMs`, `nextAttemptAtMs`, `category`

- [ ] **Step 1: Write the failing test**

Create `packages/zai/test/shared/events-runtime-retrying.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { RuntimeEventSchema } from '../../../src/shared/events.js'

describe('RuntimeEventSchema — runtime.retrying variant', () => {
  it('parses a valid runtime.retrying event', () => {
    const ev = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: 'sess-1',
      ts: 1000,
      turnIndex: 0,
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: 1500,
      category: 'llm_provider_overloaded',
    }
    const parsed = RuntimeEventSchema.parse(ev)
    expect(parsed).toMatchObject({
      type: 'runtime.retrying',
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: 1500,
      category: 'llm_provider_overloaded',
    })
  })

  it('accepts llm_provider_server and llm_provider_rate_limit categories', () => {
    for (const category of ['llm_provider_overloaded', 'llm_provider_server', 'llm_provider_rate_limit']) {
      const ev = {
        type: 'runtime.retrying',
        eventId: 'evt-1',
        sessionId: 'sess-1',
        ts: 1000,
        turnIndex: 0,
        attempt: 2,
        delayMs: 1000,
        nextAttemptAtMs: 2000,
        category,
      }
      expect(() => RuntimeEventSchema.parse(ev)).not.toThrow()
    }
  })

  it('rejects when required field "attempt" is missing', () => {
    const ev = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: 'sess-1',
      ts: 1000,
      turnIndex: 0,
      delayMs: 500,
      nextAttemptAtMs: 1500,
      category: 'llm_provider_overloaded',
    }
    expect(() => RuntimeEventSchema.parse(ev)).toThrow(/attempt/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/zai && pnpm vitest run test/shared/events-runtime-retrying.test.ts`
Expected: FAIL — `RuntimeEventSchema` is a `z.discriminatedUnion`; `runtime.retrying` is not a registered discriminator, so parse throws "Invalid discriminator value".

- [ ] **Step 3: Add `runtime.retrying` zod variant**

Modify `packages/zai/src/shared/events.ts`. Locate the `runtime.error` block (around line 49) and insert this new variant IMMEDIATELY AFTER it (before `runtime.compacted`):

```ts
  z.object({
    ...Base.shape,
    type: z.literal('runtime.retrying'),
    attempt: z.number().int().min(1),
    delayMs: z.number().int().min(0),
    nextAttemptAtMs: z.number().int(),
    category: z.string(),
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/zai && pnpm vitest run test/shared/events-runtime-retrying.test.ts`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/shared/events.ts packages/zai/test/shared/events-runtime-retrying.test.ts
git commit -m "feat(zai/shared): add runtime.retrying to RuntimeEvent zod union"
```

---

### Task 2: Add `runtime.retrying` case to useAgentStore.applyRuntimeEvent

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:1325-1326` (insert new case before `runtime.error` in the switch)
- Test: `packages/zai/test/web/useAgentStore-retrying.test.ts` (new)

**Interfaces:**
- Consumes: `applyRuntimeEvent(event: ServerEvent)` (`useAgentStore.ts:1190`) — already gates on `event.sessionId` and on `runtime.compacted` special-case before the main switch
- Produces: when `event.type === 'runtime.retrying'`, store `status` becomes `'retrying'` and exactly one `runtime.retrying` toast message lives in `messages` (latest attempt replaces previous, no spam)

- [ ] **Step 1: Write the failing test**

Create `packages/zai/test/web/useAgentStore-retrying.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

beforeEach(() => {
  useAgentStore.setState({ messages: [], status: 'idle' } as any)
})

describe('useAgentStore.applyRuntimeEvent — runtime.retrying', () => {
  it('sets status to "retrying" and pushes a toast message', () => {
    const sid = 'sess-1'
    const event = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: sid,
      ts: Date.now(),
      turnIndex: 0,
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: Date.now() + 500,
      category: 'llm_provider_overloaded',
    }
    useAgentStore.getState().applyRuntimeEvent(event as any)
    expect(useAgentStore.getState().status).toBe('retrying')
    const toasts = useAgentStore.getState().messages.filter(
      (m: any) => m.type === 'runtime.retrying',
    )
    expect(toasts).toHaveLength(1)
    expect(toasts[0].attempt).toBe(1)
    expect(toasts[0].category).toBe('llm_provider_overloaded')
  })

  it('replaces the previous retrying toast (no spam)', () => {
    const sid = 'sess-1'
    const base = {
      type: 'runtime.retrying',
      sessionId: sid,
      ts: Date.now(),
      turnIndex: 0,
      delayMs: 500,
      nextAttemptAtMs: Date.now() + 500,
    }
    useAgentStore.getState().applyRuntimeEvent({ ...base, eventId: 'evt-1', attempt: 1, category: 'llm_provider_overloaded' } as any)
    useAgentStore.getState().applyRuntimeEvent({ ...base, eventId: 'evt-2', attempt: 2, category: 'llm_provider_overloaded' } as any)
    const toasts = useAgentStore.getState().messages.filter(
      (m: any) => m.type === 'runtime.retrying',
    )
    expect(toasts).toHaveLength(1)
    expect(toasts[0].attempt).toBe(2)
    expect(toasts[0].eventId).toBe('evt-2')
  })

  it('drops events without a string sessionId (defense-in-depth parity with main switch)', () => {
    const event = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: 123 as any, // not a string
      ts: Date.now(),
      turnIndex: 0,
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: Date.now() + 500,
      category: 'llm_provider_overloaded',
    }
    useAgentStore.getState().applyRuntimeEvent(event)
    expect(useAgentStore.getState().status).toBe('idle')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/zai && pnpm vitest run test/web/useAgentStore-retrying.test.ts`
Expected: FAIL — `applyRuntimeEvent` falls through to `default:` (return), neither `status` nor `messages` updates.

- [ ] **Step 3: Implement the case**

Modify `packages/zai/src/web/src/store/useAgentStore.ts`. Find the switch inside `applyRuntimeEvent` (the one that handles `runtime.aborted` and `runtime.error`, around line 1325). Insert this `case` IMMEDIATELY BEFORE `case 'runtime.error':`:

```ts
      case 'runtime.retrying': {
        // 替换前一条 retrying toast(每次 retry 不堆消息)
        const messages = useAgentStore.getState().messages.filter(
          (m) => (m as { type?: string }).type !== 'runtime.retrying',
        )
        useAgentStore.setState({
          status: 'retrying',
          messages: [
            ...messages,
            {
              eventId: event.eventId,
              sessionId: sid,
              ts: event.ts,
              turnIndex: event.turnIndex,
              type: 'runtime.retrying',
              attempt: typeof (event as { attempt?: unknown }).attempt === 'number'
                ? (event as { attempt: number }).attempt
                : 0,
              category: typeof (event as { category?: unknown }).category === 'string'
                ? (event as { category: string }).category
                : 'unknown',
              delayMs: typeof (event as { delayMs?: unknown }).delayMs === 'number'
                ? (event as { delayMs: number }).delayMs
                : 0,
            },
          ],
        })
        return
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/zai && pnpm vitest run test/web/useAgentStore-retrying.test.ts`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/test/web/useAgentStore-retrying.test.ts
git commit -m "feat(zai/store): handle runtime.retrying event (status=retrying + toast)"
```

---

### Task 3: Wrap `createAnthropicModelCaller` generator with while-retry loop

**Files:**
- Modify: `packages/zai/src/server/services/modelCaller.ts:13-18` (add import line) and `:308-378` (replace SDK call + for-await block with while-retry loop)
- Modify: same file, add helper `logAndThrow` near top (after `readZaiSettings`)
- Test: `packages/zai/test/services/modelCaller.test.ts` (new)

**Interfaces:**
- Consumes: existing `createAnthropicModelCaller(): ModelCaller` factory contract (`packages/zai/src/server/services/modelCaller.ts:213`)
- Consumes: `classifyRetryableError`, `getRetryDelay`, `retrySleep`, `RETRY_POLICY` from `@zn-ai/zai-agent-core/runtime`
- Produces: generator that yields `runtime.retrying` events between SDK attempts; same external contract otherwise (yields SDK stream events unchanged)

- [ ] **Step 1: Add import + helper to modelCaller.ts**

Modify `packages/zai/src/server/services/modelCaller.ts`.

Add this import block immediately AFTER the existing `import type { ModelCaller } from '@zn-ai/zai-agent-core/runtime'` line (~line 18):

```ts
import {
  RETRY_POLICY,
  classifyRetryableError,
  getRetryDelay,
  retrySleep,
} from '@zn-ai/zai-agent-core/runtime'
```

Add this helper function immediately AFTER the `readZaiSettings` function (after line 58):

```ts
function logAndThrow(err: unknown, model: string, eventCount: number, signal: AbortSignal): never {
  if (signal.aborted) {
    throw new DOMException(signal.reason ?? 'aborted', 'AbortError')
  }
  const e = err as {
    status?: number
    requestID?: string | null
    code?: string
    name?: string
    headers?: Headers
  }
  console.error('[zai.modelCaller] ← error', JSON.stringify({
    model,
    stage: eventCount === 0 ? 'create' : 'stream',
    eventCount,
    status: e?.status,
    requestID: e?.requestID,
    name: e?.name,
    message: (err as Error).message,
    ...(process.env.ZAI_DEBUG === '1' && {
      headers:
        e?.headers && typeof (e.headers as Headers).entries === 'function'
          ? Object.fromEntries((e.headers as Headers).entries())
          : undefined,
      stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
    }),
  }))
  throw err
}
```

- [ ] **Step 2: Write the test fixture file (header + shared helpers)**

Create `packages/zai/test/services/modelCaller.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type MockResponse =
  | { kind: 'throw'; error: Error }
  | { kind: 'stream'; events: any[] }

const mockResponses: MockResponse[] = []
const mockClient = { messages: { create: vi.fn() } }

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => mockClient),
}))

let tmpHome = ''
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => tmpHome,
  }
})

function make529Error() {
  const err = new Error(
    '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
  ) as Error & { status: number }
  err.status = 529
  return err
}

function make503Error() {
  const err = new Error('service unavailable') as Error & { status: number }
  err.status = 503
  return err
}

function make401Error() {
  const err = new Error('unauthorized') as Error & { status: number }
  err.status = 401
  return err
}

async function setupMockHome() {
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-mc-test-'))
  mkdirSync(join(tmpHome, '.zai'), { recursive: true })
  writeFileSync(
    join(tmpHome, '.zai', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://test.invalid',
      },
    }),
  )
}

function resetMockQueue() {
  mockResponses.length = 0
  mockClient.messages.create.mockReset()
  mockClient.messages.create.mockImplementation(() => {
    const r = mockResponses.shift()
    if (!r) throw new Error('mock queue empty')
    if (r.kind === 'throw') return Promise.reject(r.error)
    return {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          async next() {
            if (i < r.events.length) return { value: r.events[i++], done: false }
            return { value: undefined, done: true }
          },
        }
      },
    }
  })
}

beforeEach(async () => {
  await setupMockHome()
  resetMockQueue()
})

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
})

async function callModelCaller() {
  // dynamic import AFTER vi.mock is hoisted (vitest hoists vi.mock to top of file)
  const { createAnthropicModelCaller } = await import(
    '../../src/server/services/modelCaller.js'
  )
  const caller = createAnthropicModelCaller()
  const controller = new AbortController()
  const collected: any[] = []
  let thrown: unknown = null
  try {
    for await (const ev of caller({
      model: 'MiniMax-M3',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: controller.signal,
    } as any)) {
      collected.push(ev)
    }
  } catch (e) {
    thrown = e
  }
  return { collected, thrown, controller }
}
```

- [ ] **Step 3: Add T1 — 529 → 3 retries → 4th success**

Append to the test file:

```ts
describe('createAnthropicModelCaller — 529 retry loop', () => {
  it('T1: retries 3 times on consecutive 529, succeeds on 4th attempt', async () => {
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({
      kind: 'stream',
      events: [
        { type: 'message_start', message: { id: 'm1' } },
        { type: 'message_stop' },
      ],
    })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeNull()
    expect(mockClient.messages.create).toHaveBeenCalledTimes(4)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(3)
    expect(retrying[0].attempt).toBe(1)
    expect(retrying[0].category).toBe('llm_provider_overloaded')
    expect(retrying[2].attempt).toBe(3)
    expect(collected.some((e) => e.type === 'message_start')).toBe(true)
    expect(collected.some((e) => e.type === 'message_stop')).toBe(true)
  })
})
```

- [ ] **Step 4: Run T1 to verify it fails (TDD red)**

Run: `cd packages/zai && pnpm vitest run test/services/modelCaller.test.ts`
Expected: FAIL — `mockClient.messages.create` called once (current modelCaller has no retry); `runtime.retrying` events never emitted; 3 extra mock responses left unused.

- [ ] **Step 5: Wrap modelCaller with while-retry loop**

Modify `packages/zai/src/server/services/modelCaller.ts`. Replace the block from `const stream = await client.messages.create(` (line 308) through `throw err` at the end of the catch (line 378) with:

```ts
    let attempt = 0
    let consecutive529 = 0
    let eventCount = 0
    let retryCounter = 0
    while (true) {
      if (signal.aborted) {
        throw new DOMException(signal.reason ?? 'aborted', 'AbortError')
      }
      attempt++
      try {
        const stream = await client.messages.create(
          {
            model: resolvedModel,
            max_tokens: 8192,
            thinking: { type: 'enabled', budget_tokens: 4096 },
            system: systemBlocks,
            messages: sdkMessages,
            tools: tools.length > 0
              ? (tools.map((t) => ({
                  name: t.name,
                  description: t.description ?? '',
                  input_schema: buildAnthropicInputSchema(t.inputSchema),
                })) as Anthropic.Messages.ToolUnion[])
              : undefined,
            stream: true,
          },
          { signal },
        )
        eventCount = 0
        for await (const event of stream) {
          eventCount++
          if (signal.aborted) break
          if (process.env.ZAI_DEBUG === '1' && (eventCount <= 3 || (event as any).type === 'message_stop')) {
            console.error('[zai.modelCaller] yield', { n: eventCount, type: (event as any).type, model: resolvedModel })
          }
          yield event as unknown as StreamEvent
          if ((event as any).type === 'message_stop') {
            if (process.env.ZAI_DEBUG === '1') {
              console.error('[zai.modelCaller] break on message_stop', { eventCount, model: resolvedModel })
            }
            break
          }
        }
        if (process.env.ZAI_DEBUG === '1') {
          console.error('[zai.modelCaller] stream done normally', { eventCount, model: resolvedModel })
        }
        return  // generator return → for-await 上层拿到 done
      } catch (err) {
        if (signal.aborted) {
          throw new DOMException(signal.reason ?? 'aborted', 'AbortError')
        }
        if (eventCount > 0) {
          // 流中途抛错: 不重试(避免丢弃已送出 delta)
          logAndThrow(err, resolvedModel, eventCount, signal)
        }
        const e = err as {
          status?: number
          requestID?: string | null
          code?: string
          name?: string
          headers?: Headers
        }
        console.error('[zai.modelCaller] ← error', JSON.stringify({
          model: resolvedModel,
          stage: 'create',
          eventCount: 0,
          attempt,
          status: e?.status,
          requestID: e?.requestID,
          name: e?.name,
          message: (err as Error).message,
        }))
        const decision = classifyRetryableError(err)
        if (!decision.retryable) {
          throw err  // 401/403/429 quota — 不重试
        }
        if (decision.isTransientCapacity) {
          consecutive529++
          if (consecutive529 > RETRY_POLICY.max529Retries) {
            throw err  // 529 连续超 3
          }
        } else if (attempt > RETRY_POLICY.maxRetries) {
          throw err  // 5xx 总尝试超 10
        }
        // ★ emit runtime.retrying 让前端可见
        retryCounter++
        const delayMs = getRetryDelay(consecutive529 > 0 ? consecutive529 : attempt)
        const ts = Date.now()
        yield {
          type: 'runtime.retrying',
          eventId: `retry-${retryCounter}`,
          sessionId: '',
          ts,
          turnIndex: 0,
          attempt,
          delayMs,
          nextAttemptAtMs: ts + delayMs,
          category: decision.category,
        }
        await retrySleep(delayMs, signal)
      }
    }
```

- [ ] **Step 6: Run T1 to verify it passes (TDD green)**

Run: `cd packages/zai && pnpm vitest run test/services/modelCaller.test.ts`
Expected: PASS — T1 green. SDK called 4 times, 3 `runtime.retrying` events yielded, 2 stream events flowed through.

- [ ] **Step 7: Add T2 — 529 exhausts after 4 attempts**

Append to the test file:

```ts
  it('T2: throws SDKError after 4 consecutive 529 (3 retries exhausted)', async () => {
    for (let i = 0; i < 4; i++) mockResponses.push({ kind: 'throw', error: make529Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(529)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(4)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(3)
  })
```

- [ ] **Step 8: Add T3 — 503 total limit (11 attempts)**

Append to the test file:

```ts
  it('T3: throws after 11 consecutive 503 (5xx total limit)', async () => {
    for (let i = 0; i < 12; i++) mockResponses.push({ kind: 'throw', error: make503Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(503)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(11)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(10)
  })
```

- [ ] **Step 9: Add T4 — stream-mid 529 does NOT retry**

Append to the test file:

```ts
  it('T4: does NOT retry when 529 fires mid-stream (eventCount > 0)', async () => {
    mockClient.messages.create.mockReset()
    mockClient.messages.create.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'message_start', message: { id: 'm1' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ]
        let i = 0
        return {
          async next() {
            if (i < events.length) return { value: events[i++], done: false }
            throw make529Error()
          },
        }
      },
    }))

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(529)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(0)
  })
```

- [ ] **Step 10: Add T5 — abort signal interrupts retry**

Append to the test file:

```ts
  it('T5: aborts immediately when signal is set during retry sleep', async () => {
    mockClient.messages.create.mockReset()
    mockClient.messages.create.mockImplementation(async () => {
      throw make529Error()
    })

    const { createAnthropicModelCaller } = await import(
      '../../src/server/services/modelCaller.js'
    )
    const caller = createAnthropicModelCaller()
    const controller = new AbortController()
    setTimeout(() => controller.abort('user cancelled'), 20)

    const collected: any[] = []
    let thrown: unknown = null
    try {
      for await (const ev of caller({
        model: 'MiniMax-M3',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: controller.signal,
      } as any)) {
        collected.push(ev)
      }
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe('AbortError')
    expect(mockClient.messages.create.mock.calls.length).toBeLessThanOrEqual(2)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying.length).toBeLessThanOrEqual(1)
  })
```

- [ ] **Step 11: Add T6 — 401/403 don't retry**

Append to the test file:

```ts
  it('T6: does NOT retry on 401 (auth error)', async () => {
    mockResponses.push({ kind: 'throw', error: make401Error() })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).status).toBe(401)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(1)
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying).toHaveLength(0)
  })
```

- [ ] **Step 12: Add T7 — retry event field shape**

Append to the test file:

```ts
  it('T7: runtime.retrying event has attempt / delayMs / nextAttemptAtMs / category fields', async () => {
    mockResponses.push({ kind: 'throw', error: make529Error() })
    mockResponses.push({
      kind: 'stream',
      events: [{ type: 'message_start', message: { id: 'm1' } }, { type: 'message_stop' }],
    })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeNull()
    const retrying = collected.find((e) => e.type === 'runtime.retrying')!
    expect(retrying.attempt).toBe(1)
    expect(retrying.delayMs).toBeGreaterThanOrEqual(500)
    expect(retrying.delayMs).toBeLessThanOrEqual(32_000)
    expect(retrying.nextAttemptAtMs).toBe(retrying.ts + retrying.delayMs)
    expect(retrying.category).toBe('llm_provider_overloaded')
  })
```

- [ ] **Step 13: Add T8 — backoff never exceeds maxDelayMs**

Append to the test file:

```ts
  it('T8: backoff delayMs never exceeds RETRY_POLICY.maxDelayMs across attempts', async () => {
    // 5 throws → 5 retrying events with growing delays
    for (let i = 0; i < 5; i++) mockResponses.push({ kind: 'throw', error: make503Error() })
    mockResponses.push({
      kind: 'stream',
      events: [{ type: 'message_start', message: { id: 'm1' } }, { type: 'message_stop' }],
    })

    const { collected, thrown } = await callModelCaller()
    expect(thrown).toBeNull()
    const retrying = collected.filter((e) => e.type === 'runtime.retrying')
    expect(retrying.length).toBe(5)
    for (const r of retrying) {
      expect(r.delayMs).toBeLessThanOrEqual(32_000)
    }
    // monotone non-decreasing (with jitter, may fluctuate slightly)
    expect(retrying[4].delayMs).toBeGreaterThanOrEqual(retrying[0].delayMs)
  })
```

- [ ] **Step 14: Run all modelCaller tests**

Run: `cd packages/zai && pnpm vitest run test/services/modelCaller.test.ts`
Expected: PASS — all 8 cases (T1–T8) green.

- [ ] **Step 15: Typecheck the whole zai package**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors. If modelCaller's new `throw new DOMException` needs DOM lib, see `tsconfig.json` — the package targets `ES2022` and `lib` defaults include `DOM` for TS, but verify by running typecheck.

- [ ] **Step 16: Commit**

```bash
git add packages/zai/src/server/services/modelCaller.ts packages/zai/test/services/modelCaller.test.ts
git commit -m "feat(zai/modelCaller): while-retry loop for 529/429/5xx at SDK create stage"
```

---

## Spec coverage self-review

| Spec § | Requirement | Covered by |
|---|---|---|
| §1.3 #1 | auto-retry 529/429/5xx with backoff | Task 3 (T1, T2, T3, T7, T8) |
| §1.3 #2 | frontend visibility via `runtime.retrying` | Task 1 (zod) + Task 2 (store) + Task 3 (yield) |
| §1.3 #3 | abort signal interrupts retry | Task 3 (T5) + `retrySleep(signal)` reuse |
| §1.3 #4 | stream-mid 529 NOT retried | Task 3 (T4) — `if (eventCount > 0) logAndThrow` |
| §1.3 #5 | reuse `zai-agent-core/retryPolicy` | Task 3 import statement; no duplication |
| §2.2 | `runtime.retrying` schema | Task 1 (zod) + Task 2 (consumer) + Task 3 (producer) |
| §2.3 | reuse constants | Task 3 imports `RETRY_POLICY` |
| §2.4 | error contract (529/429/5xx/401/quota/stream-mid/abort) | Task 3 (T1–T8) covers each row |
| §2.5 | only touch modelCaller / events / store | Tasks 1, 2, 3 — queryLoop, routes, transcript untouched |
| §3 B1–B8 | behavior list | Task 3 (T1–T8 covers B1–B8 1:1) |
| §4.1 | retryPolicy contract tests | Already covered by `packages/zai-agent-core/test/background/retryPolicy.test.ts:91-104` — no new test needed in zai-agent-core |
| §4.2 | 8 modelCaller tests | Task 3 (T1–T8) |
| §5 | acceptance gate (test + typecheck + manual) | Task 3 Step 14 + Step 15 + manual per spec §5 |

**Type consistency check:** `runtime.retrying` event shape defined once in Task 1 (zod), used in Task 2 (store case), produced in Task 3 (yield) — same `attempt` / `delayMs` / `nextAttemptAtMs` / `category` field names throughout. `RETRY_POLICY.max529Retries = 3` / `maxRetries = 10` imported in Task 3, not re-declared.

**Placeholder scan:** No "TBD", no "fill in", no "similar to Task N". Every code block is complete and runnable.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-zai-modelcaller-529-retry.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
