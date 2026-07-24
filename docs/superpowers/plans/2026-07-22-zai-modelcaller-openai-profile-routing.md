# modelCaller OpenAI-Profile Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `modelCaller.ts` route `provider: 'openai'` profiles (e.g. `OpenAI-Mix` / Wizard AI gateway) through the OpenAI shim instead of the Anthropic SDK, so zhiniao-* models no longer hit a 404/405 from the wrong protocol path.

**Architecture:** Expose a new `createModelCallerClient` factory from `zai-agent-core` that inspects the resolved provider profile and returns either an `Anthropic` SDK client or an `Anthropic`-shaped OpenAI shim. `zai`'s `modelCaller.ts` becomes a thin wrapper: it still owns the stream + retry loop, but delegates client construction to the factory. The thinking block + Anthropic-specific beta headers are gated on `provider === 'anthropic'` so the shim never sees them.

**Tech Stack:** TypeScript, Node, Express, Anthropic SDK, internal OpenAI shim (`createOpenAIShimClient`), Vitest.

---

## Root cause recap

- Session `sess-002fab41-8d38-43a1-9fa9-9b5ad853c2c7` was created with `meta.model = "zhiniao-MiniMax-M2.7-highspeed"` (not `zhiniao-x` — no such string exists anywhere).
- `~/.claude.json → providerProfiles[OpenAI-Mix]` has `provider: "openai"` and `baseUrl: "https://wizard-ai.paic.com.cn/code_pilot/api/v1"` (chat_completions only).
- `zai/src/server/services/modelCaller.ts:182-208` (`getAnthropicClientForModel`) ignores `profile.provider` and constructs an `Anthropic` SDK client pointed at the OpenAI-Mix baseUrl. The SDK sends an Anthropic-shape POST to `/v1/messages` → Wizard AI returns 404 → `messages.create()` throws at `eventCount === 0` → queryLoop writes an empty assistant message and surfaces `runtime.error` to the UI.
- The existing internal path in `zai-agent-core/src/opencc-internals/services/api/client.ts:143-159` already routes `providerOverride` through `createOpenAIShimClient` correctly — the wiring just isn't reachable from zai's `modelCaller.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/zai-agent-core/src/opencc-internals/services/api/client.ts` (modify) | Add `createModelCallerClient({baseURL, apiKey, model, provider, defaultHeaders?})` — returns `Anthropic`-shaped client. Reuses existing `createOpenAIShimClient` path when `provider === 'openai'`; otherwise constructs `Anthropic` SDK. |
| `packages/zai-agent-core/src/opencc-internals/services/api/client.ts` (export new types) | `ModelCallerClientOptions`, `ModelCallerClientProfile` — minimal types for callers. |
| `packages/zai-agent-core/src/runtime/index.ts` (modify) | Re-export `createModelCallerClient` + types from the new public surface. |
| `packages/zai/src/server/services/modelCaller.ts` (modify) | Replace `getAnthropicClientForModel` with a call to `createModelCallerClient`. Gate `thinking: { type: 'enabled', budget_tokens: 4096 }` and the `anthropic-beta` defaultHeaders on `profile.provider !== 'openai'`. |
| `packages/zai-agent-core/test/services/api/createModelCallerClient.test.ts` (create) | Unit tests: anthropic provider → SDK, openai provider → shim, unknown provider → SDK fallback, missing API key error. |
| `packages/zai/test/server/modelCaller-openai-profile.test.ts` (create) | Integration tests: with a profile whose `provider: 'openai'`, modelCaller must call `messages.create` on the shim (not on Anthropic SDK) and must NOT pass `thinking` / `anthropic-beta` header. |

Files that change together: `client.ts` (new factory) ↔ `modelCaller.ts` (consumer). Tests live next to the code they cover.

---

## Global Constraints

- TypeScript strict mode (`@typescript-eslint/no-explicit-any` is a warning; new public API must use real types).
- Test runner: Vitest (`pnpm test` at workspace root runs all packages).
- `zai-agent-core` is published as `@zn-ai/zai-agent-core`; new exports must be added to `src/runtime/index.ts` (single barrel re-export).
- Do NOT remove or rename existing exports in `client.ts` — only add new ones.
- `modelCaller.ts` retry loop (`while (true)` at line 344), `eventCount` tracking, `runtime.retrying` SSE emission, and `break on message_stop` logic must remain byte-for-byte unchanged — only the client construction point and the `thinking`/`anthropic-beta` gating changes.
- `defaultHeaders` filtering for the shim is already done internally by `OpenAIShimMessages` constructor via `filterAnthropicHeaders` (`openaiClient.ts:885`). Do not duplicate this filter at the call site.

---

## Task 1: Expose `createModelCallerClient` factory from `zai-agent-core`

**Files:**
- Modify: `packages/zai-agent-core/src/opencc-internals/services/api/client.ts` (add factory + types at bottom of file)
- Modify: `packages/zai-agent-core/src/runtime/index.ts` (re-export)
- Test: `packages/zai-agent-core/test/services/api/createModelCallerClient.test.ts` (create)

**Interfaces:**
- Consumes: `createOpenAIShimClient` from `./openaiShim/index.js`, `Anthropic` from `@anthropic-ai/sdk`, `filterAnthropicHeaders` from `./openaiShim/openaiClient.ts` (existing internal helpers).
- Produces:
  - `export type ModelCallerClientProfile = { baseURL: string; apiKey: string; model: string; provider?: 'anthropic' | 'openai' | string; defaultHeaders?: Record<string, string> }`
  - `export async function createModelCallerClient(profile: ModelCallerClientProfile): Promise<Anthropic>` — returns Anthropic SDK when `provider === 'anthropic'` or undefined; returns `createOpenAIShimClient(...)` (cast to `Anthropic`) when `provider === 'openai'`.

- [ ] **Step 1: Write the failing test**

Create `packages/zai-agent-core/test/services/api/createModelCallerClient.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'

// Capture which client factory was called and with what.
const shimCalls: any[] = []
const sdkCalls: any[] = []

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: vi.fn(async () => ({})) }
  }
  return {
    default: vi.fn((opts: any) => {
      sdkCalls.push(opts)
      return new FakeAnthropic()
    }),
  }
})

vi.mock(
  '../../src/opencc-internals/services/api/openaiShim/index.js',
  () => ({
    createOpenAIShimClient: vi.fn((opts: any) => {
      shimCalls.push(opts)
      return { __shim: true, opts }
    }),
  }),
)

import { createModelCallerClient } from '../../src/opencc-internals/services/api/client.js'

describe('createModelCallerClient', () => {
  beforeEach(() => {
    shimCalls.length = 0
    sdkCalls.length = 0
  })

  it('routes provider="openai" through createOpenAIShimClient', async () => {
    const client = await createModelCallerClient({
      baseURL: 'https://wizard-ai.paic.com.cn/code_pilot/api/v1',
      apiKey: 'sk-test',
      model: 'zhiniao-MiniMax-M2.7-highspeed',
      provider: 'openai',
    })
    expect(shimCalls).toHaveLength(1)
    expect(shimCalls[0]).toMatchObject({
      providerOverride: {
        baseURL: 'https://wizard-ai.paic.com.cn/code_pilot/api/v1',
        apiKey: 'sk-test',
        model: 'zhiniao-MiniMax-M2.7-highspeed',
      },
    })
    expect(sdkCalls).toHaveLength(0)
    expect((client as any).__shim).toBe(true)
  })

  it('routes provider="anthropic" through Anthropic SDK', async () => {
    await createModelCallerClient({
      baseURL: 'https://zn-nova.paic.com.cn/novai',
      apiKey: 'sk-test',
      model: 'MiniMax-M3',
      provider: 'anthropic',
    })
    expect(sdkCalls).toHaveLength(1)
    expect(sdkCalls[0]).toMatchObject({
      baseURL: 'https://zn-nova.paic.com.cn/novai',
      authToken: 'sk-test',
    })
    expect(shimCalls).toHaveLength(0)
  })

  it('defaults to Anthropic SDK when provider is omitted', async () => {
    await createModelCallerClient({
      baseURL: 'https://zn-nova.paic.com.cn/novai',
      apiKey: 'sk-test',
      model: 'MiniMax-M3',
    })
    expect(sdkCalls).toHaveLength(1)
    expect(shimCalls).toHaveLength(0)
  })

  it('treats unknown provider values as anthropic', async () => {
    await createModelCallerClient({
      baseURL: 'https://example.com',
      apiKey: 'sk-test',
      model: 'm',
      provider: 'custom-thing',
    })
    expect(sdkCalls).toHaveLength(1)
    expect(shimCalls).toHaveLength(0)
  })

  it('throws when apiKey is missing', async () => {
    await expect(
      createModelCallerClient({
        baseURL: 'https://x',
        apiKey: '',
        model: 'm',
        provider: 'openai',
      }),
    ).rejects.toThrow(/api.?key/i)
  })

  it('throws when baseURL is missing', async () => {
    await expect(
      createModelCallerClient({
        baseURL: '',
        apiKey: 'sk-test',
        model: 'm',
        provider: 'openai',
      }),
    ).rejects.toThrow(/base.?url/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/zai-agent-core && pnpm test test/services/api/createModelCallerClient.test.ts`
Expected: FAIL with `Cannot find module '../../src/opencc-internals/services/api/client.js'` or `createModelCallerClient is not a function`.

- [ ] **Step 3: Implement the factory**

Add to the bottom of `packages/zai-agent-core/src/opencc-internals/services/api/client.ts` (do not touch the existing `getAnthropicClient` function):

```typescript
import { createOpenAIShimClient } from './openaiShim/index.js'

export type ModelCallerClientProfile = {
  baseURL: string
  apiKey: string
  model: string
  provider?: 'anthropic' | 'openai' | string
  defaultHeaders?: Record<string, string>
}

/**
 * Build an Anthropic-shaped client for the given profile.
 *
 * - `provider === 'openai'` → OpenAI chat_completions-compatible shim
 *   (used for third-party gateways like Wizard AI / ZhiNiao that host
 *    zhiniao-* models and reject Anthropic-shape POSTs).
 * - anything else (including undefined / 'anthropic' / unknown) → real
 *   Anthropic SDK client.
 *
 * Mirrors the providerOverride branch in getAnthropicClient above so
 * callers don't have to reach into internals.
 */
export async function createModelCallerClient(
  profile: ModelCallerClientProfile,
): Promise<Anthropic> {
  if (!profile.apiKey) throw new Error('createModelCallerClient: apiKey required')
  if (!profile.baseURL) throw new Error('createModelCallerClient: baseURL required')

  if (profile.provider === 'openai') {
    return createOpenAIShimClient({
      ...(profile.defaultHeaders ? { defaultHeaders: profile.defaultHeaders } : {}),
      maxRetries: 0,
      providerOverride: {
        baseURL: profile.baseURL,
        apiKey: profile.apiKey,
        model: profile.model,
      },
    }) as unknown as Anthropic
  }

  return new Anthropic({
    authToken: profile.apiKey,
    baseURL: profile.baseURL,
    maxRetries: 0,
    ...(profile.defaultHeaders ? { defaultHeaders: profile.defaultHeaders } : {}),
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/zai-agent-core && pnpm test test/services/api/createModelCallerClient.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Re-export from runtime barrel**

Edit `packages/zai-agent-core/src/runtime/index.ts`. After the existing `export * from './background/index.js'` line (line 57), add:

```typescript
// Provider-aware ModelCaller client factory (zai modelCaller.ts consumer).
// Routes `provider: 'openai'` profiles through the OpenAI shim so third-party
// gateways (Wizard AI / ZhiNiao) don't get hit with Anthropic-shape POSTs.
export { createModelCallerClient } from '../opencc-internals/services/api/client.js'
export type { ModelCallerClientProfile } from '../opencc-internals/services/api/client.js'
```

- [ ] **Step 6: Run zai-agent-core build + full test suite**

Run: `cd packages/zai-agent-core && pnpm build && pnpm test`
Expected: build succeeds, all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/opencc-internals/services/api/client.ts \
        packages/zai-agent-core/src/runtime/index.ts \
        packages/zai-agent-core/test/services/api/createModelCallerClient.test.ts
git commit -m "feat(zai-agent-core): expose createModelCallerClient for openai-profile routing"
```

---

## Task 2: Switch `modelCaller.ts` to use the factory and gate Anthropic-only fields

**Files:**
- Modify: `packages/zai/src/server/services/modelCaller.ts:182-208` (replace `getAnthropicClientForModel` body)
- Modify: `packages/zai/src/server/services/modelCaller.ts:361-378` (gate `thinking` + `anthropic-beta` on non-openai provider)

**Interfaces:**
- Consumes: `createModelCallerClient` + `ModelCallerClientProfile` from `@zn-ai/zai-agent-core/runtime` (added in Task 1).
- Produces: `getAnthropicClientForModel(model?: string): Promise<Anthropic>` — now `async`, returns shim or SDK based on resolved profile.

- [ ] **Step 1: Write the failing test**

Create `packages/zai/test/server/modelCaller-openai-profile.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track which client type modelCaller ends up using.
const shimClients: any[] = []
const sdkClients: any[] = []

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn((file: string) => {
      if (typeof file === 'string' && file.endsWith('settings.json')) {
        return JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'anthropic-test-token',
            ANTHROPIC_BASE_URL: 'https://zn-nova.example/novai',
            OPENAI_API_KEY: 'openai-test-token',
          },
        })
      }
      if (typeof file === 'string' && file.endsWith('.claude.json')) {
        return JSON.stringify({
          providerProfiles: [
            {
              id: 'anthropic',
              name: 'Anthropic-MIX',
              provider: 'anthropic',
              baseUrl: 'https://zn-nova.example/novai',
              model: 'MiniMax-M3',
            },
            {
              id: 'openai-mix',
              name: 'OpenAI-Mix',
              provider: 'openai',
              baseUrl: 'https://wizard-ai.example/code_pilot/api/v1',
              model: 'zhiniao-MiniMax-M2.7-highspeed',
            },
          ],
        })
      }
      return actual.readFileSync(file)
    }),
  }
})

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn(function (opts: any) {
      sdkClients.push(opts)
      // Minimal Messages stub: yields message_stop immediately.
      return {
        messages: {
          create: vi.fn(async () => ({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'message_stop' }
            },
          })),
        },
      }
    }),
  }
})

vi.mock('@zn-ai/zai-agent-core/runtime', async () => {
  const actual = await vi.importActual<typeof import('@zn-ai/zai-agent-core/runtime')>(
    '@zn-ai/zai-agent-core/runtime',
  )
  return {
    ...actual,
    createModelCallerClient: vi.fn(async (profile: any) => {
      if (profile.provider === 'openai') {
        const c = { __shim: true, profile }
        shimClients.push(c)
        return {
          messages: {
            create: vi.fn(async () => ({
              [Symbol.asyncIterator]: async function* () {
                yield { type: 'message_stop' }
              },
            })),
          },
        }
      }
      // anthropic path → fall through to real SDK via dynamic import would be messy in mock
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      sdkClients.push(profile)
      return new Anthropic({ apiKey: profile.apiKey, baseURL: profile.baseURL })
    }),
  }
})

import { createAnthropicModelCaller } from '../../src/server/services/modelCaller.js'

async function exhaust(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = []
  for await (const ev of generator) events.push(ev)
  return events
}

beforeEach(() => {
  shimClients.length = 0
  sdkClients.length = 0
})

describe('modelCaller with OpenAI profile', () => {
  it('uses the shim client for zhiniao-* models', async () => {
    const call = createAnthropicModelCaller()
    const events = await exhaust(
      call({
        model: 'zhiniao-MiniMax-M2.7-highspeed',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        signal: new AbortController().signal,
      } as any),
    )
    expect(shimClients).toHaveLength(1)
    expect(shimClients[0].profile.provider).toBe('openai')
    expect(events.at(-1)).toEqual({ type: 'message_stop' })
  })

  it('uses the Anthropic SDK for MiniMax-* models', async () => {
    const call = createAnthropicModelCaller()
    await exhaust(
      call({
        model: 'MiniMax-M3',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        signal: new AbortController().signal,
      } as any),
    )
    expect(shimClients).toHaveLength(0)
    // sdkClients[0] holds the profile from createModelCallerClient (anthropic branch).
    expect(sdkClients[0].provider ?? sdkClients[0].baseURL).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/zai && pnpm test test/server/modelCaller-openai-profile.test.ts`
Expected: FAIL — `createModelCallerClient` is not exported from `@zn-ai/zai-agent-core/runtime` yet (it is, after Task 1 Step 5, but `modelCaller.ts` still uses `new Anthropic(...)`, so shim is never selected). Most likely failure: `shimClients` is empty.

- [ ] **Step 3: Replace `getAnthropicClientForModel` body**

In `packages/zai/src/server/services/modelCaller.ts`:

At the top of the file, after the existing imports (around line 24), add:

```typescript
import {
  createModelCallerClient,
  type ModelCallerClientProfile,
} from '@zn-ai/zai-agent-core/runtime'
```

Replace the entire `getAnthropicClientForModel` function (lines 182-208) with:

```typescript
let _client: { client: unknown; key: string } | null = null

async function getAnthropicClientForModel(
  model?: string,
): Promise<Anthropic> {
  // Reuse cached client when the model resolves to the same provider profile.
  const cacheKey = model ?? '__default__'
  if (_client && _client.key === cacheKey) return _client.client as Anthropic

  const { baseURL, apiKey, profile } = resolveProviderForModel(model)

  if (!apiKey) throw new Error('API key not found for selected model')
  if (!baseURL) throw new Error('Base URL not found for selected model')

  // Anthropic-only defaultHeaders: 'anthropic-beta' / 'interleaved-thinking-*'.
  // OpenAI-compatible gateways reject unknown headers (or worse, echo them
  // back), so we only attach them when we're definitely talking Anthropic.
  const provider = profile?.provider ?? 'anthropic'
  const anthropicOnlyHeaders =
    provider === 'openai'
      ? undefined
      : {
          'anthropic-beta':
            'anthropic-tot-control,interleaved-thinking-2025-05-14',
        }

  const clientOpts: ModelCallerClientProfile = {
    baseURL,
    apiKey,
    model: model ?? '',
    provider,
    ...(anthropicOnlyHeaders ? { defaultHeaders: anthropicOnlyHeaders } : {}),
  }

  const client = await createModelCallerClient(clientOpts)
  _client = { client, key: cacheKey }
  return client
}
```

- [ ] **Step 4: Make `getAnthropicClient()` async too (or keep it sync via SDK fallback)**

In the same file, `getAnthropicClient()` (lines 210-240) is still called from any code path that doesn't pass a model. Make it async-compatible by changing the return type to `Promise<Anthropic>` and awaiting the SDK construction inline. Find every call site with:

```bash
grep -n "getAnthropicClient()" packages/zai/src/server/services/modelCaller.ts
```

Only the default-Anthropic-SDK path inside `createAnthropicModelCaller` uses `getAnthropicClientForModel` now (per Step 3). If `getAnthropicClient` has no remaining callers, delete it. Otherwise keep it and add `async` + `await new Anthropic({...})`.

Likely outcome: no remaining callers — delete `getAnthropicClient`.

- [ ] **Step 5: Gate the `thinking` block on non-openai provider**

In `packages/zai/src/server/services/modelCaller.ts`, locate `client.messages.create({...})` around lines 361-378. The block currently passes `thinking: { type: 'enabled', budget_tokens: 4096 }` unconditionally. Change to:

```typescript
// Determine effective provider from the model so we can decide whether
// `thinking` is safe to send. Anthropic accepts it; OpenAI shim will
// forward it as a body field and Wizard AI will 400.
const effectiveProvider = resolveProviderForModel(resolvedModel).profile?.provider ?? 'anthropic'
const wantsThinking = effectiveProvider !== 'openai'

const stream = await client.messages.create(
  {
    model: resolvedModel,
    max_tokens: 8192,
    ...(wantsThinking
      ? { thinking: { type: 'enabled', budget_tokens: 4096 } }
      : {}),
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
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cd packages/zai && pnpm test test/server/modelCaller-openai-profile.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Run existing modelCaller tests for regression**

Run: `cd packages/zai && pnpm test test/server/modelCaller-string-array.test.ts`
Expected: PASS. If it fails because the test mocks `@anthropic-ai/sdk` and expects the SDK constructor to be called, the new code path through `createModelCallerClient` may not invoke it. Adjust the mock to also mock `@zn-ai/zai-agent-core/runtime`'s `createModelCallerClient` to forward to the mocked Anthropic SDK (similar pattern as the new test).

- [ ] **Step 8: Run full zai test suite**

Run: `cd packages/zai && pnpm test`
Expected: all tests pass. Investigate any failures case-by-case.

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/server/services/modelCaller.ts \
        packages/zai/test/server/modelCaller-openai-profile.test.ts
git commit -m "fix(zai): route openai-profile models through OpenAI shim

Previously getAnthropicClientForModel ignored profile.provider and
constructed an Anthropic SDK client pointed at the OpenAI-Mix profile's
Wizard AI baseUrl. The SDK POSTed Anthropic-shape requests to a
chat_completions-only gateway, hitting 404 at create() and producing
empty assistant transcripts.

Replace direct SDK construction with createModelCallerClient from
zai-agent-core, which routes provider=openai through createOpenAIShimClient.
Gate the Anthropic-only 'thinking' parameter and 'anthropic-beta' default
header on provider !== 'openai' so the shim never sees them.

Fixes the LLM-unavailable failure on sess-002fab41-... and any other
session that picked a zhiniao-* model from providerProfiles."
```

---

## Task 3: Manual smoke test against a real Wizard AI session

**Files:** none (verification only)

- [ ] **Step 1: Start zai server with the patched build**

```bash
cd packages/zai-agent-core && pnpm build
cd ../zai && pnpm build
pnpm dev
```

Verify the dev server boots with no startup errors. Expected: same startup output as before.

- [ ] **Step 2: Open a new session with `zhiniao-MiniMax-M2.7-highspeed`**

In the UI: create a new session, select the `zhiniao-MiniMax-M2.7-highspeed` model from the picker, send `hello`.

Expected: assistant responds with text (not empty / not a red error Card). The exact response content depends on the model but it must NOT be `content: []` followed by `runtime.error: API Error 404`.

- [ ] **Step 3: Verify the transcript on disk**

```bash
ls -lt ~/.zai/transcripts/ | head -3
cat "$(ls -t ~/.zai/transcripts/*.json | head -1)"
```

Expected: `meta.model = "zhiniao-MiniMax-M2.7-highspeed"`, `messages` contains the user prompt plus a non-empty assistant message (`content: [{type:'text', text:'...'}]` or with a thinking block). NOT an empty assistant message.

- [ ] **Step 4: Verify the Anthropic-default session still works**

Send a message in a session using `MiniMax-M3` (Anthropic profile). Expected: normal response.

- [ ] **Step 5: Verify dev-server logs show shim routing**

Look for log lines from `[zai.modelCaller]` with `model: "zhiniao-..."`. Expected: modelCaller reports the model name and stream stages; no `404` / `model_not_found` errors.

If any step fails: stop, capture the failure (logs + transcript snippet + which model + which profile), and report. Do not proceed to "fix forward" without a verified reproduction.

- [ ] **Step 6: No commit (verification only)**

If all steps pass, the fix is complete. If you added any debug-only logging, remove it before the next commit and re-verify.

---

## Self-Review

**Spec coverage:**
- Root cause fix (Anthropic SDK vs OpenAI shim routing) → Task 2 Steps 3-5.
- Public API surface from `zai-agent-core` so `zai` can consume the factory → Task 1.
- Unit test for factory routing logic → Task 1 Step 1.
- Integration test for `modelCaller` behavior → Task 2 Step 1.
- Manual smoke test against real Wizard AI session → Task 3.
- `thinking` / `anthropic-beta` gating for non-Anthropic providers → Task 2 Step 5.

**Placeholder scan:** No TBDs, no "implement later". Every step shows exact file paths, exact code, exact commands.

**Type consistency:**
- `ModelCallerClientProfile` defined Task 1 Step 3 with `{baseURL, apiKey, model, provider?, defaultHeaders?}` and used consistently in Task 2 Step 3 and the test in Task 2 Step 1.
- `createModelCallerClient(profile)` returns `Promise<Anthropic>` in Task 1 Step 3; `getAnthropicClientForModel` in Task 2 Step 3 also returns `Promise<Anthropic>`. The existing `await client.messages.create(...)` call (Task 2 Step 5) is unchanged in shape.

**Risk callouts:**
- Existing test `packages/zai/test/server/modelCaller-string-array.test.ts` mocks `@anthropic-ai/sdk` directly. After this change, the Anthropic SDK is constructed inside `createModelCallerClient` (mocked in the new test). If the existing test fails in Step 7, follow the migration pattern from the new test's mock setup.
- The `_client` cache key changes from `model ?? '__default__'` (string) to `{ client, key }` (object). Existing cached clients will be invalidated once, which is fine — startup cost only.
- `getAnthropicClient()` may have zero callers after this change. Step 4 deletes it. If it has callers, they need `await` added.