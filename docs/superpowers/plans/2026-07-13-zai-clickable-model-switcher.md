# zai Clickable Model Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the model badge in the zai-web chat status bar clickable so users can pick a different model for the active session, with the choice persisted to `transcript.meta.model` and new sessions retaining the env/settings/default fallback chain.

**Architecture:** OpenCC-inspired layered model resolution + per-session override. Server reads `transcript.meta.model` and threads it through `runtime.run({ model })` (already supported by `zai-agent-core`'s `queryEngine`). Settings file gets a `models[]` alias table powering the picker UI; the picked alias is resolved to a full model ID and written back to `transcript.meta.model`.

**Tech Stack:** Express + zod (server), React + antd Popover + zustand (client), vitest + supertest + @testing-library/react + happy-dom.

---

## Global Constraints

- **Model list source:** `~/.zai/settings.json` gets a new top-level `models: ModelEntry[]`. The picker UI is driven exclusively by this array — no hardcoded model list anywhere in the codebase.
- **Persistence format:** `transcript.meta.model` always stores the **resolved full model name** (e.g. `"MiniMax-M3"`), never the alias. Aliases are presentation only.
- **New-session default resolution:** new sessions (via `POST /api/agent/sessions`) keep writing `model: 'unknown'` as a placeholder. `'unknown'` (or null/missing) is treated as "not specified" by `resolveModel` and falls through to the chain.
- **Existing session compatibility:** all sessions created before this change have `meta.model === 'unknown'` or no `meta.model`. `resolveModel` treats both identically — no migration needed.
- **UI styling:** Popover follows the same pattern as `ConversationInfoButton` (click trigger, `placement="topRight"`, `destroyTooltipOnHide`, content wrapped in `<div onClick={stopPropagation}>` to avoid outside-click dismissal).
- **No global default override:** switching a session's model does NOT modify `~/.zai/settings.json → settings.model`. New sessions keep their env/settings-based default.
- **TypeScript path style:** server / web / shared all use `.js` import suffix for TypeScript NodeNext ESM. New shared types live in `src/shared/settings.ts` (alongside existing `events.ts`).
- **Test environment:** vitest. Web tests need `@vitest-environment happy-dom` for hooks that touch the DOM. Server tests mock `node:fs` (for `readZaiSettings`) and `agentRuntime.js` (for transcript store / runtime). Don't refactor existing mocks — extend in place.
- **Existing test compatibility:** `test/server/agentSettings.test.ts` has 5 cases using `expect(res.body).toEqual(...)` exact-match assertions. When extending the response shape, **switch those existing assertions to `expect.objectContaining(...)`** before adding the `models` field — leaving them as exact-match will fail the entire suite.

---

## Resolution chain (per-turn)

For every `/agent/prompt` request, the server resolves the effective model in this order:

| Layer | Source | `source` tag |
|---|---|---|
| 1 | `transcript.meta.model` (only if not `'unknown'`) | `session` |
| 2 | `env.ANTHROPIC_DEFAULT_SONNET_MODEL` | `env_default_sonnet` |
| 3 | `env.ANTHROPIC_SMALL_FAST_MODEL` | `env_small_fast` |
| 4 | `settings.model` | `settings_model` |
| 5 | Built-in fallback | `builtin_fallback` (always returns `"MiniMax-M3"`) |

Layer 5 is non-null by construction.

---

## File structure

**New files:**
- `packages/zai/src/shared/settings.ts` — `ModelEntry` + `ZaiSettings` types
- `packages/zai/src/server/lib/resolveModel.ts` — pure resolver + `BUILTIN_FALLBACK_MODEL`
- `packages/zai/test/server/resolveModel.test.ts` — 6 unit tests
- `packages/zai/src/web/src/components/ModelStatusButton.tsx` — picker popover component
- `packages/zai/test/web/ModelStatusButton.test.tsx` — component tests

**Modified files:**
- `packages/zai/src/server/routes/agentSettings.ts` — return `models[]` in response
- `packages/zai/src/server/routes/agent.ts` — `/agent/prompt` reads meta.model + new PATCH endpoint
- `packages/zai/src/web/src/store/useAgentStore.ts` — `availableModels`, `patchSessionModel`, Session type widening, `loadSessions` extended
- `packages/zai/src/web/src/hooks/useConversationInfo.ts` — `displayLabel` field + alias matcher
- `packages/zai/src/web/src/pages/Agent.tsx` — swap `ModelStatusBadge` → `ModelStatusButton`
- `packages/zai/test/server/agentSettings.test.ts` — extend with `models[]` test (also fix existing exact-match assertions)
- `packages/zai/test/server/agent.test.ts` — extend transcript store mock + add `lastRunOpts.model` assertion
- `packages/zai/test/server/routes-agent.test.ts` — PATCH endpoint tests
- `packages/zai/test/web/useConversationInfo.test.ts` — alias `displayLabel` cases

**Deleted files:**
- `packages/zai/src/web/src/components/ModelStatusBadge.tsx`

---

### Task 1: Shared settings types + resolveModel

**Files:**
- Create: `packages/zai/src/shared/settings.ts`
- Create: `packages/zai/src/server/lib/resolveModel.ts`
- Test: `packages/zai/test/server/resolveModel.test.ts`

**Interfaces:**
- Produces `ModelEntry`, `ZaiSettings` types (consumed by every later task — server routes, store, hook, component).
- Produces `resolveModel(input: ResolveModelInput): ResolveModelResult` + `BUILTIN_FALLBACK_MODEL: 'MiniMax-M3'`.

- [ ] **Step 1: Create shared settings types**

Create `packages/zai/src/shared/settings.ts`:

```ts
/**
 * Alias-table entry powering the model picker UI.
 *
 * - `alias`: short identifier shown in the UI ("M3", "haiku").
 * - `model`: full model ID sent to the upstream API ("MiniMax-M3",
 *   "MiniMax-M2.7-highspeed"). This is the value stored in
 *   transcript.meta.model after a picker selection.
 * - `label` / `description`: optional UI presentation fields.
 */
export interface ModelEntry {
  alias: string
  model: string
  label?: string
  description?: string
}

/** Shape of ~/.zai/settings.json. */
export interface ZaiSettings {
  env?: Record<string, string>
  /** Global default (resolution chain layer 4). */
  model?: string
  /** Alias table powering the picker UI. */
  models?: ModelEntry[]
}
```

- [ ] **Step 2: Create resolveModel**

Create `packages/zai/src/server/lib/resolveModel.ts`:

```ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResolveModelInput {
  /** transcript.meta.model — 'unknown' / null / undefined all mean "not specified". */
  sessionModel: string | null | undefined
  /** Reserved for future cwd-scoped overrides; v1 ignores this. */
  cwd: string
}

export interface ResolveModelResult {
  /** Resolved model ID. Never null/empty. */
  model: string
  source:
    | 'session'
    | 'env_default_sonnet'
    | 'env_small_fast'
    | 'settings_model'
    | 'builtin_fallback'
}

/** Final fallback when nothing else resolves. Used by tests + non-/agent/prompt callers. */
export const BUILTIN_FALLBACK_MODEL = 'MiniMax-M3'

/**
 * Read ~/.zai/settings.json. Returns parsed object or empty object on
 * missing/invalid JSON. Real IO errors are re-thrown for the route's
 * 500 path. Mirrors the same defensive pattern used in
 * src/server/routes/agentSettings.ts:21-29.
 */
function readZaiSettings(): {
  env?: Record<string, string>
  model?: string
} {
  try {
    const p = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    if (err instanceof SyntaxError) return {}
    throw err
  }
}

/**
 * Resolve the effective model for a single turn.
 *
 * Layer order (see spec):
 *   1. sessionModel (if not 'unknown' / empty)
 *   2. env.ANTHROPIC_DEFAULT_SONNET_MODEL
 *   3. env.ANTHROPIC_SMALL_FAST_MODEL
 *   4. settings.model
 *   5. BUILTIN_FALLBACK_MODEL
 *
 * Always returns a non-empty `model`. The `source` field lets the caller
 * log which layer won.
 */
export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  if (input.sessionModel && input.sessionModel !== 'unknown') {
    return { model: input.sessionModel, source: 'session' }
  }
  const settings = readZaiSettings()
  const env = settings.env ?? {}
  if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return { model: env.ANTHROPIC_DEFAULT_SONNET_MODEL, source: 'env_default_sonnet' }
  }
  if (env.ANTHROPIC_SMALL_FAST_MODEL) {
    return { model: env.ANTHROPIC_SMALL_FAST_MODEL, source: 'env_small_fast' }
  }
  if (settings.model) {
    return { model: settings.model, source: 'settings_model' }
  }
  return { model: BUILTIN_FALLBACK_MODEL, source: 'builtin_fallback' }
}
```

- [ ] **Step 3: Write the failing tests**

Create `packages/zai/test/server/resolveModel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Mock fs so we control what ~/.zai/settings.json returns.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, readFileSync: vi.fn() }
})

// Import after mock so resolveModel picks up the mocked fs.
import {
  resolveModel,
  BUILTIN_FALLBACK_MODEL,
} from '../../src/server/lib/resolveModel.js'

function setSettings(contents: object | string) {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents)
  vi.mocked(readFileSync).mockReturnValue(text)
}

beforeEach(() => {
  vi.mocked(readFileSync).mockReset()
})

afterEach(() => {
  // Wipe any process env overrides set by tests.
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
})

describe('resolveModel', () => {
  it('returns session model when it is set and not "unknown"', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'X' } })
    const r = resolveModel({ sessionModel: 'MiniMax-M3', cwd: '/x' })
    expect(r).toEqual({ model: 'MiniMax-M3', source: 'session' })
  })

  it('falls through to env_default_sonnet when sessionModel is "unknown"', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env' } })
    const r = resolveModel({ sessionModel: 'unknown', cwd: '/x' })
    expect(r).toEqual({ model: 'from-env', source: 'env_default_sonnet' })
  })

  it('falls through when sessionModel is null', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env' } })
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: 'from-env', source: 'env_default_sonnet' })
  })

  it('falls through when sessionModel is empty string', () => {
    setSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-env' } })
    const r = resolveModel({ sessionModel: '', cwd: '/x' })
    expect(r).toEqual({ model: 'from-env', source: 'env_default_sonnet' })
  })

  it('uses env_small_fast when SONNET is missing', () => {
    setSettings({ env: { ANTHROPIC_SMALL_FAST_MODEL: 'fast-x' } })
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: 'fast-x', source: 'env_small_fast' })
  })

  it('uses settings_model when no env override', () => {
    setSettings({ model: 'cli-default' })
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: 'cli-default', source: 'settings_model' })
  })

  it('falls back to BUILTIN_FALLBACK_MODEL when nothing is configured', () => {
    setSettings({})
    const r = resolveModel({ sessionModel: null, cwd: '/x' })
    expect(r).toEqual({ model: BUILTIN_FALLBACK_MODEL, source: 'builtin_fallback' })
    expect(BUILTIN_FALLBACK_MODEL).toBe('MiniMax-M3')
  })
})
```

- [ ] **Step 4: Run tests, expect failure (red)**

Run: `cd packages/zai && node_modules/.bin/vitest run test/server/resolveModel.test.ts`
Expected: FAIL — `resolveModel` doesn't exist yet (RED phase).

- [ ] **Step 5: Verify implementation makes tests pass (green)**

Run: `cd packages/zai && node_modules/.bin/vitest run test/server/resolveModel.test.ts`
Expected: 7 passed (GREEN).

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/shared/settings.ts \
        packages/zai/src/server/lib/resolveModel.ts \
        packages/zai/test/server/resolveModel.test.ts
git commit -m "feat(zai-server): shared settings types + resolveModel with 5-layer chain"
```

---

### Task 2: Extend /api/agent/settings to return models[]

**Files:**
- Modify: `packages/zai/src/server/routes/agentSettings.ts` (full file is ~60 lines, rewrite via Edit)
- Modify: `packages/zai/test/server/agentSettings.test.ts` (5 existing cases + 2 new)

**Interfaces:**
- Consumes `resolveModel` (Task 1).
- Consumes `ZaiSettings` / `ModelEntry` types (Task 1).
- Produces extended GET response: `{ defaultModel, baseURL, models }`.

- [ ] **Step 1: Replace exact-match assertions with objectContaining**

In `packages/zai/test/server/agentSettings.test.ts`, change every `expect(res.body).toEqual({...})` to `expect(res.body).toEqual(expect.objectContaining({...}))`. Three assertions need this — the two tests on lines 43-46 and 73-74 of the existing file.

```ts
// before:
expect(res.body).toEqual({
  defaultModel: 'MiniMax-M3',
  baseURL: 'https://api.example.com',
})
// after:
expect(res.body).toEqual(expect.objectContaining({
  defaultModel: 'MiniMax-M3',
  baseURL: 'https://api.example.com',
}))

// before:
expect(res.body).toEqual({ defaultModel: null, baseURL: null })
// after:
expect(res.body).toEqual(expect.objectContaining({ defaultModel: null, baseURL: null }))
```

- [ ] **Step 2: Rewrite the route to use resolveModel + return models[]**

Modify `packages/zai/src/server/routes/agentSettings.ts`. Replace the entire content with:

```ts
import { Router, type IRouter, type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveModel } from '../lib/resolveModel.js'
import type { ModelEntry } from '../../shared/settings.js'

/**
 * Read ~/.zai/settings.json. Returns parsed object or empty object on
 * any failure (missing file, invalid JSON, permission error).
 *
 * Mirrors the same defensive pattern used in resolveModel.ts — the
 * settings file is optional and the server must keep working when it
 * is absent.
 */
function readZaiSettings(): {
  env?: Record<string, string>
  model?: string
  models?: ModelEntry[]
} {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    // Empty file / invalid JSON is fine — fall back to defaults.
    // Real IO errors are surfaced so the route can return 500.
    if (err instanceof SyntaxError) return {}
    throw err
  }
}

const router: IRouter = Router()

/**
 * GET /api/agent/settings — return the runtime defaults + alias table
 * that the picker UI consumes.
 *
 * `defaultModel` is resolved via the same 5-layer chain as
 * resolveModel() — so the UI's fallback display matches what the
 * server will actually pick at runtime when no session override is set.
 *
 * `models` is the alias table straight from settings.json — empty
 * array when unset (the picker shows "未配置 models[]" in that case).
 */
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = readZaiSettings()
    const env = settings.env ?? {}
    const { model: defaultModel } = resolveModel({ sessionModel: null, cwd: '' })
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    const models = settings.models ?? []
    res.json({ defaultModel, baseURL, models })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
```

- [ ] **Step 3: Add a test for models[] in the response**

Append to the `describe('GET /api/agent/settings', ...)` block in `packages/zai/test/server/agentSettings.test.ts`:

```ts
  it('returns models[] from settings.json when present', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3' },
        models: [
          { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' },
          { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速轻量' },
        ],
      }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.models).toEqual([
      { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' },
      { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速轻量' },
    ])
  })

  it('returns models: [] when settings.json omits models', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'X' } }),
    )
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.models).toEqual([])
  })
```

- [ ] **Step 4: Run the full agentSettings test suite**

Run: `cd packages/zai && node_modules/.bin/vitest run test/server/agentSettings.test.ts`
Expected: 7 passed (5 existing + 2 new). The 5 existing now use `objectContaining`, so adding the `models` field doesn't break them.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/agentSettings.ts \
        packages/zai/test/server/agentSettings.test.ts
git commit -m "feat(zai-server): /api/agent/settings returns models[] alias table"
```

---

### Task 3: /agent/prompt reads meta.model + new PATCH endpoint

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts` (lines ~258-296 in POST handler; new PATCH route appended before `router.post('/agent/abort', ...)` at line 430)
- Modify: `packages/zai/test/server/agent.test.ts` (extend transcript mock + add model-resolution tests in the existing /agent/prompt describe)
- Modify: `packages/zai/test/server/routes-agent.test.ts` (append PATCH endpoint describe block)

**Interfaces:**
- Consumes `resolveModel` (Task 1).
- Produces `lastRunOpts.model` being the resolved name (verified by `agent.test.ts`).
- Produces PATCH `/api/agent/sessions/:id` accepting `{ model: string }`.

- [ ] **Step 1: Extend the transcript store mock in agent.test.ts**

In `packages/zai/test/server/agent.test.ts`, replace the inner `read` and `patch` mocks so tests can override `meta.model` and capture `model` patches separately. Find the `vi.mock('../../src/server/services/agentRuntime.js', ...)` block (lines 18-57) and update the `getTranscriptStore` block to:

```ts
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({
      version: 1,
      transcriptId: 'sess-1',
      meta: {
        cwd: '/tmp',
        // mockTranscriptMetaModel controls the meta.model value the
        // route reads when resolving per-session model. Default 'unknown'
        // (matches existing tests).
        model: mockTranscriptMetaModel,
        createdAt: 0,
        updatedAt: 0,
        ...(mockTranscriptHasTitle ? { title: 'existing-title' } : {}),
      },
      messages: [],
    }),
    patch: async (id: string, patch: { title?: string; tags?: string[]; model?: string }) => {
      patchCalls.push({ id, patch })
    },
    remove: async () => {},
    append: async () => {},
  }),
```

Add `let mockTranscriptMetaModel: string = 'unknown'` at the top alongside the other module-level lets (after `let patchCalls: ...` on line 12). Also add `mockTranscriptMetaModel = 'unknown'` reset at the start of each describe block where state could leak — easiest place is the existing `beforeEach` style. Looking at the file, there's no global `beforeEach` — tests reset module-level state inline. Mirror that pattern: reset `mockTranscriptMetaModel = 'unknown'` at the start of any new test that depends on it.

- [ ] **Step 2: Add tests for lastRunOpts.model in agent.test.ts**

Append two new tests inside `describe('POST /api/agent/prompt with contentBlocks', ...)` (or create a new sibling describe block — same mock is in scope). Place them after the existing two tests in that block:

```ts
// 关键: /agent/prompt 必须从 transcript.meta.model 读到 session 选过的
// 模型, 通过 resolveModel 透传给 runtime.run({ model }). 三种情形:
// 1) sessionModel = 'unknown' → 走 fallback (settings/env -> BUILTIN_FALLBACK_MODEL)
// 2) sessionModel = '<resolvedName>' → 直接用它
// 3) meta.model 缺失 (read 抛错) → 走 fallback
describe('POST /api/agent/prompt model resolution', () => {
  it('forwards transcript.meta.model to runtime.run when set', async () => {
    lastRunOpts = null
    mockTranscriptMetaModel = 'MiniMax-M2.7-highspeed'
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess-model-1' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      expect(lastRunOpts.model).toBe('MiniMax-M2.7-highspeed')
    } finally {
      close()
    }
  })

  it('falls back to BUILTIN_FALLBACK_MODEL when transcript.meta.model is "unknown"', async () => {
    lastRunOpts = null
    mockTranscriptMetaModel = 'unknown'
    // 清空 readFileSync 让 resolveModel 走 builtin fallback.
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess-model-2' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts.model).toBe('MiniMax-M3')
    } finally {
      close()
    }
  })
})
```

The test file already imports `vi` so the `vi.mocked(readFileSync)` call works. The `readFileSync` mock comes from the module-level `vi.mock('node:fs', ...)` setup that already exists at the top of the test file (not shown in the read excerpt — verify by looking at the top 5 lines; if it's missing, add it as in `agentSettings.test.ts`).

- [ ] **Step 3: Modify /agent/prompt handler to read meta.model and pass to runtime.run**

In `packages/zai/src/server/routes/agent.ts`, modify the `void (async () => { ... })()` block inside `router.post('/agent/prompt', ...)` to read meta.model and pass `model: resolvedModel` to `getRuntime().run(...)`. The current code at lines 311-317 reads the existing transcript for `titlePatched`; add a parallel `sessionModel` capture alongside it. Then construct the call to `resolveModel`. Find the block beginning with `let titlePatched = false` (around line 311) and replace through the call to `getRuntime().run(...)` (around line 296 — note the call precedes the title block; the edits need to be in two places).

Two surgical edits:

Edit A — replace the block at the top of the IIFE:

```ts
      // 拉 transcript meta.model 给 resolveModel 用. title 判断也复用了这次 read.
      // 文件不存在 (新会话) 是正常路径, 静默忽略 — sessionModel 保持 null,
      // resolveModel 走 fallback 链到 env / settings / builtin.
      let sessionModel: string | null = null
      let titlePatched = false
      try {
        const existing = await getTranscriptStore().read(sessionId)
        if (existing.meta.title) titlePatched = true
        if (existing.meta.model && existing.meta.model !== 'unknown') {
          sessionModel = existing.meta.model
        }
      } catch {
        // 新会话 / 无 transcript — sessionModel 保持 null
      }

      const { model: resolvedModel, source: modelSource } = resolveModel({
        sessionModel,
        cwd,
      })

      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.agent.prompt] resolved model', {
          sessionId, modelSource, resolvedModel,
        })
      }
```

Edit B — pass `model: resolvedModel` to `runtime.run`. Find:

```ts
      const events = getRuntime().run({
        prompt: promptArg,
        cwd,
        transcriptId: sessionId,
        systemPrompt,
        abortSignal: abortController.signal,
      })
```

Replace with:

```ts
      const events = getRuntime().run({
        prompt: promptArg,
        cwd,
        transcriptId: sessionId,
        systemPrompt,
        abortSignal: abortController.signal,
        model: resolvedModel,
      })
```

- [ ] **Step 4: Add PATCH endpoint to agent.ts**

In `packages/zai/src/server/routes/agent.ts`, add the import and the new route. Add `import { z } from 'zod'` (already imported on line 2 — verify; if so skip). Add the route handler immediately before `router.post('/agent/abort', ...)` (around line 430):

```ts
// PATCH /agent/sessions/:id — partial-update a session's transcript meta.
// v1 only supports updating `model`. The body must include a non-empty
// string that's not the placeholder 'unknown' — silently dropping the
// patch when 'unknown' is sent prevents accidentally resetting the
// user's selection back to the env/settings fallback.
const PatchSessionRequest = z.object({
  model: z.string().min(1).max(256).optional(),
})

router.patch('/agent/sessions/:id', async (req: Request, res: Response) => {
  const parsed = PatchSessionRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const sid = req.params.id
  try {
    const store = getTranscriptStore()
    if (parsed.data.model && parsed.data.model !== 'unknown') {
      await store.patch(sid, { model: parsed.data.model })
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

- [ ] **Step 5: Add PATCH endpoint tests in routes-agent.test.ts**

Append to `packages/zai/test/server/routes-agent.test.ts`. The existing file does not mock `agentRuntime.js` — only `routes-agent.test.ts` has it. The PATCH endpoint needs the transcript store mock. Replace the file's mock block (lines 6-30) with an extended one:

```ts
// Mock agentRuntime service — transcript store is needed for PATCH /sessions/:id
let patchCalls: Array<{ id: string; patch: { model?: string; title?: string } }> = []
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  initAgentRuntime: vi.fn(),
  getOrCreateAgentSession: vi.fn().mockResolvedValue('test-session-id'),
  getRuntime: vi.fn().mockReturnValue({
    run: vi.fn().mockImplementation(async function* () {
      yield {
        eventId: 'e1',
        sessionId: 'test-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'assistant.text',
        text: 'Hello!',
      }
      yield {
        eventId: 'e2',
        sessionId: 'test-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'runtime.done',
      }
    }),
    abort: vi.fn().mockResolvedValue(undefined),
  }),
  getCurrentSessionId: () => 'test-session-id',
  setCurrentSessionId: () => {},
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({
      version: 1,
      transcriptId: 'test-session-id',
      meta: { cwd: '/tmp', model: 'unknown', createdAt: 0, updatedAt: 0 },
      messages: [],
    }),
    patch: async (id: string, patch: { model?: string; title?: string }) => {
      patchCalls.push({ id, patch })
    },
    remove: async () => {},
    append: async () => {},
  }),
}))
```

Append a new describe block at the end of the file:

```ts
describe('PATCH /api/agent/sessions/:id', () => {
  beforeEach(() => {
    patchCalls = []
  })

  it('writes model to transcript meta', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 'MiniMax-M3' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(patchCalls).toEqual([{ id: 'sess-1', patch: { model: 'MiniMax-M3' } }])
  })

  it('rejects invalid body (missing or non-string model)', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 123 })
    expect(res.status).toBe(400)
  })

  it('does not write when model is "unknown" placeholder', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 'unknown' })
    expect(res.status).toBe(200)
    expect(patchCalls.length).toBe(0)
  })

  it('accepts empty body (no-op patch)', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({})
    expect(res.status).toBe(200)
    expect(patchCalls.length).toBe(0)
  })
})
```

- [ ] **Step 6: Run server tests**

Run: `cd packages/zai && node_modules/.bin/vitest run test/server/agent.test.ts test/server/routes-agent.test.ts test/server/agentSettings.test.ts`
Expected: all pass. If `agent.test.ts` complains about missing `readFileSync` mock, add the `vi.mock('node:fs', ...)` block at the top of that file matching `agentSettings.test.ts`'s pattern.

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/routes/agent.ts \
        packages/zai/test/server/agent.test.ts \
        packages/zai/test/server/routes-agent.test.ts
git commit -m "feat(zai-server): /agent/prompt reads meta.model + PATCH /sessions/:id"
```

---

### Task 4: Store — availableModels, patchSessionModel, Session type widening

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts` (extend Session interface, AgentState, add action, extend loadSessions)
- Modify: `packages/zai/test/web/useAgentStore.test.ts` (add 2 tests for patchSessionModel + Session type)

**Interfaces:**
- Consumes `ModelEntry` from `src/shared/settings.ts` (Task 1).
- Produces: `availableModels: ModelEntry[]`, `patchSessionModel(sid, model) => Promise<void>`, widened `Session` shape with optional `model` / `cwd` / `createdAt`.

- [ ] **Step 1: Extend Session interface and AgentState**

In `packages/zai/src/web/src/store/useAgentStore.ts`, find the `sessions` declaration on line 57:

```ts
  sessions: Array<{ transcriptId: string; title?: string; updatedAt: number }>
```

Replace with:

```ts
  sessions: Array<{
    transcriptId: string
    title?: string
    updatedAt: number
    /** Resolved model name (from transcript.meta.model). 'unknown' or absent = not set. */
    model?: string
    cwd?: string
    createdAt?: number
  }>
```

Add `ModelEntry` import at the top alongside the existing imports:

```ts
import type { ModelEntry } from '../../../shared/settings.js'
```

Add to `interface AgentState` (around line 99):

```ts
  /** Models list synced from /api/agent/settings → models[]. */
  availableModels: ModelEntry[]
  /** Optimistic PATCH /api/agent/sessions/:id + local session model update. */
  patchSessionModel: (sid: string, model: string) => Promise<void>
```

Add the field initializer to the store impl (alongside `sessionId: null` etc. around line 107):

```ts
  availableModels: [],
```

- [ ] **Step 2: Implement patchSessionModel**

In `packages/zai/src/web/src/store/useAgentStore.ts`, add this implementation alongside the other action implementations (e.g., right after `deleteSession` around line 393):

```ts
  patchSessionModel: async (sid, model) => {
    // Snapshot for revert on failure.
    const prev = get().sessions
    // Optimistic local update so the badge switches immediately.
    set({
      sessions: prev.map((x) =>
        x.transcriptId === sid ? { ...x, model } : x,
      ),
    })
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
        body: JSON.stringify({ model }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Revert the optimistic update.
      set({ sessions: prev })
    }
  },
```

- [ ] **Step 3: Extend loadSessions to populate availableModels**

Find `loadSessions` around line 317. Replace the body with one that also fetches `/api/agent/settings` in parallel:

```ts
  loadSessions: async () => {
    try {
      const token = localStorage.getItem('zai-token') || ''
      const [sessionsRes, settingsRes] = await Promise.all([
        fetch('/api/agent/sessions', { headers: { 'X-Zai-Token': token } }),
        fetch('/api/agent/settings').catch(() => null),
      ])
      const data = await sessionsRes.json()
      const sessions = data.sessions ?? []
      let availableModels: ModelEntry[] = []
      if (settingsRes && settingsRes.ok) {
        const settingsData = await settingsRes.json()
        availableModels = Array.isArray(settingsData.models) ? settingsData.models : []
      }
      set({ sessions, availableModels })
      if (sessions.length > 0) {
        set({ sessionId: sessions[0].transcriptId })
        await get().loadTranscript(sessions[0].transcriptId)
      }
    } catch {
      // ignore — list load is best-effort
    }
  },
```

- [ ] **Step 4: Write tests for the store action**

Append to `packages/zai/test/web/useAgentStore.test.ts` (find the file first — it should exist alongside other web tests). If the file doesn't exist, look at the test file listing. Add these tests:

```ts
import type { ModelEntry } from '../../../src/shared/settings.js'

describe('useAgentStore.patchSessionModel', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('optimistically updates local session.model and POSTs to PATCH endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })
    globalThis.fetch = fetchMock as any

    useAgentStore.setState({
      sessions: [{
        transcriptId: 'sess-1',
        title: 'old',
        updatedAt: 1,
        cwd: '/x',
      }],
    })

    await useAgentStore.getState().patchSessionModel('sess-1', 'MiniMax-M3')

    const updated = useAgentStore.getState().sessions[0]
    expect(updated.model).toBe('MiniMax-M3')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/agent/sessions/sess-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ model: 'MiniMax-M3' })
  })

  it('reverts optimistic update when PATCH returns non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    })
    globalThis.fetch = fetchMock as any

    useAgentStore.setState({
      sessions: [{
        transcriptId: 'sess-1',
        title: 'old',
        updatedAt: 1,
        // No model field set yet.
      }],
    })

    await useAgentStore.getState().patchSessionModel('sess-1', 'MiniMax-M3')

    const after = useAgentStore.getState().sessions[0]
    expect(after.model).toBeUndefined() // revert worked
  })
})

describe('useAgentStore.loadSessions', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('populates availableModels from /api/agent/settings response', async () => {
    const models: ModelEntry[] = [
      { alias: 'M3', model: 'MiniMax-M3' },
      { alias: 'haiku', model: 'MiniMax-M2.7-highspeed' },
    ]
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/agent/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ defaultModel: 'MiniMax-M3', baseURL: null, models }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessions: [] }),
      } as Response)
    }) as any

    await useAgentStore.getState().loadSessions()

    expect(useAgentStore.getState().availableModels).toEqual(models)
  })

  it('keeps availableModels empty when settings fetch fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/agent/settings')) {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessions: [] }),
      } as Response)
    }) as any

    await useAgentStore.getState().loadSessions()

    expect(useAgentStore.getState().availableModels).toEqual([])
  })
})
```

If the existing test file uses `import type { ... }` style for store imports, follow that convention. Add the `ModelEntry` import once at the top.

- [ ] **Step 5: Run web store tests**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/useAgentStore.test.ts`
Expected: all pass (existing tests + 4 new).

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts \
        packages/zai/test/web/useAgentStore.test.ts
git commit -m "feat(zai-web): store adds availableModels + patchSessionModel + Session widening"
```

---

### Task 5: useConversationInfo — displayLabel with alias matcher

**Files:**
- Modify: `packages/zai/src/web/src/hooks/useConversationInfo.ts` (extend ConversationInfo interface, add helper, populate displayLabel)
- Modify: `packages/zai/test/web/useConversationInfo.test.ts` (extend mock fetch + add alias displayLabel tests)

**Interfaces:**
- Consumes `ModelEntry` (Task 1).
- Produces `ConversationInfo.displayLabel: string | null` (alias-aware display text).

- [ ] **Step 1: Extend the hook**

In `packages/zai/src/web/src/hooks/useConversationInfo.ts`, add the import at the top:

```ts
import type { ModelEntry } from '../../../shared/settings.js'
```

Extend the `RuntimeSettings` interface:

```ts
interface RuntimeSettings {
  defaultModel: string | null
  baseURL: string | null
  models: ModelEntry[]
}
```

Extend `ConversationInfo`:

```ts
export interface ConversationInfo {
  // ... existing fields
  /** Alias-aware display label. Falls back: alias.label → alias.alias → model → null. */
  displayLabel: string | null
}
```

Add a helper above the hook:

```ts
function findAliasForModel(model: string | null, models: ModelEntry[]): ModelEntry | null {
  if (!model) return null
  return models.find((m) => m.model === model) ?? null
}
```

Inside `useConversationInfo`, change the `useState<RuntimeSettings>` initializer:

```ts
  const [runtime, setRuntime] = useState<RuntimeSettings>({
    defaultModel: null,
    baseURL: null,
    models: [],
  })
```

Update the fetch success handler to read `models`:

```ts
      .then((data: Partial<RuntimeSettings>) => {
        if (cancelled) return
        setRuntime({
          defaultModel: data.defaultModel ?? null,
          baseURL: data.baseURL ?? null,
          models: Array.isArray(data.models) ? data.models : [],
        })
      })
```

In the `useMemo` body, compute `displayLabel` after `model` and add it to the returned object:

```ts
    const alias = findAliasForModel(model, runtime.models)
    const displayLabel = alias?.label ?? alias?.alias ?? model ?? null

    return {
      sessionId: effectiveSessionId,
      title: sess?.title ?? null,
      startTime: typeof firstTs === 'number' && firstTs > 0 ? firstTs : null,
      lastUpdate: sess?.updatedAt ?? null,
      turnCount: turns,
      messageCount: messages.length,
      status,
      cwd: cwd || sess?.cwd || null,
      model,
      settingsLoaded,
      displayLabel,
    }
```

Add `runtime.models` to the useMemo deps (it's already covered by `runtime` itself).

- [ ] **Step 2: Update the existing test mock to include models**

In `packages/zai/test/web/useConversationInfo.test.ts`, update the fetch mock (around line 67-72) to also include `models`:

```ts
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      defaultModel: 'MiniMax-M3',
      baseURL: 'https://api.x',
      models: [
        { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' },
        { alias: 'haiku', model: 'MiniMax-M2.7-highspeed' },
      ],
    }),
  } as Response)
```

- [ ] **Step 3: Add displayLabel tests**

Append to the integration `describe` block in `packages/zai/test/web/useConversationInfo.test.ts`:

```ts
  it('returns displayLabel = alias.label when model hits an alias with label', async () => {
    const sessionId = 'sess-display-label'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/x',
        model: 'MiniMax-M3', // matches alias.model
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBe('M3 · 默认最强')
  })

  it('falls back to alias.alias when no label is configured', async () => {
    const sessionId = 'sess-display-alias'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/x',
        model: 'MiniMax-M2.7-highspeed', // alias without label
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBe('haiku')
  })

  it('returns displayLabel = raw model when no alias matches', async () => {
    const sessionId = 'sess-display-raw'
    useAgentStore.setState({
      sessionId,
      sessions: [{
        transcriptId: sessionId,
        cwd: '/x',
        model: 'unknown-from-upstream',
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBe('unknown-from-upstream')
  })

  it('returns displayLabel = null when there is no effective model', async () => {
    const { result } = renderHook(() => useConversationInfo())
    await act(async () => { await Promise.resolve() })
    expect(result.current.displayLabel).toBeNull()
  })
```

- [ ] **Step 4: Run the test file**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/useConversationInfo.test.ts`
Expected: 14 passed (10 existing + 4 new). The 3 existing integration tests should still pass with the extended mock fetch.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/hooks/useConversationInfo.ts \
        packages/zai/test/web/useConversationInfo.test.ts
git commit -m "feat(zai-web): useConversationInfo adds displayLabel with alias matching"
```

---

### Task 6: ModelStatusButton component + Agent.tsx swap + delete ModelStatusBadge

**Files:**
- Create: `packages/zai/src/web/src/components/ModelStatusButton.tsx`
- Create: `packages/zai/test/web/ModelStatusButton.test.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx` (one-line import + JSX swap)
- Delete: `packages/zai/src/web/src/components/ModelStatusBadge.tsx`

**Interfaces:**
- Consumes `ConversationInfo` (Task 5: `displayLabel`, `model`, `sessionId`).
- Consumes `availableModels`, `patchSessionModel` (Task 4).

- [ ] **Step 1: Create ModelStatusButton component**

Create `packages/zai/src/web/src/components/ModelStatusButton.tsx`:

```tsx
import { Button, Popover } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * Clickable model badge — replaces the read-only ModelStatusBadge.
 *
 * Click opens a Popover listing the available models from
 * /api/agent/settings → models[]. Selecting one triggers
 * store.patchSessionModel which PATCHes transcript.meta.model.
 *
 * Empty models[] shows a "未配置 models[]" placeholder.
 */
export default function ModelStatusButton() {
  const { displayLabel, model, sessionId } = useConversationInfo()
  const models = useAgentStore((s) => s.availableModels)
  const patchSessionModel = useAgentStore((s) => s.patchSessionModel)

  const content = (
    <div style={{ width: 280 }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginBottom: 8 }}>
        切换当前会话的模型
      </div>
      {models.length === 0 && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
          ~/.zai/settings.json 未配置 models[]
        </div>
      )}
      {models.map((m) => {
        const isCurrent = m.model === model
        return (
          <div
            key={m.alias}
            onClick={() => {
              if (isCurrent || !sessionId) return
              void patchSessionModel(sessionId, m.model)
            }}
            style={{
              padding: '6px 8px',
              borderRadius: 4,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isCurrent ? 'rgba(22,119,255,0.15)' : 'transparent',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: isCurrent ? 600 : 400 }}>
                {m.label ?? m.alias}
              </span>
              {isCurrent && <CheckOutlined style={{ color: '#1677ff', fontSize: 12 }} />}
            </div>
            {m.description && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                {m.description}
              </span>
            )}
          </div>
        )
      })}
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)', marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
        仅作用于当前会话. 新建会话仍按 ~/.zai/settings.json 解析.
      </div>
    </div>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        title={`当前模型: ${displayLabel ?? '未知'}\n点击切换`}
        style={{
          color: model ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.30)',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {displayLabel ?? '未知'}
      </Button>
    </Popover>
  )
}
```

- [ ] **Step 2: Swap import in Agent.tsx + delete ModelStatusBadge**

In `packages/zai/src/web/src/pages/Agent.tsx`, find the import line for `ModelStatusBadge` (added in commit `8653eec`):

```tsx
import ModelStatusBadge from '../components/ModelStatusBadge'
```

Replace with:

```tsx
import ModelStatusButton from '../components/ModelStatusButton'
```

Find the JSX usage (in the lower status bar around line 1428):

```tsx
<ModelStatusBadge />
```

Replace with:

```tsx
<ModelStatusButton />
```

Then delete the old component:

```bash
rm packages/zai/src/web/src/components/ModelStatusBadge.tsx
```

- [ ] **Step 3: Create ModelStatusButton tests**

Create `packages/zai/test/web/ModelStatusButton.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModelStatusButton from '../../src/web/src/components/ModelStatusButton.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { ModelEntry } from '../../src/shared/settings.js'

const models: ModelEntry[] = [
  { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强', description: '最强' },
  { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速' },
]

beforeEach(() => {
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    sessions: [{
      transcriptId: 'sess-1',
      title: 'test',
      updatedAt: 1,
      cwd: '/x',
      // Default to no model set — exercises the unknown / settings-fetched
      // model path. Tests that need a specific model will override.
      model: 'MiniMax-M3',
    }],
    messages: [],
    status: 'idle',
    cwd: '/x',
    availableModels: models,
  })
  // Stub fetch for the useConversationInfo hook's settings call.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      defaultModel: 'MiniMax-M3',
      baseURL: null,
      models,
    }),
  } as Response)
})

describe('ModelStatusButton', () => {
  it('renders the alias.label of the current model', async () => {
    render(<ModelStatusButton />)
    // Wait for the settings fetch to settle so displayLabel resolves.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByText('M3 · 默认最强')).toBeDefined()
  })

  it('opens Popover with the model list on click', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    // Click the badge to open the Popover.
    const badge = screen.getByText('M3 · 默认最强')
    fireEvent.click(badge)
    // The Popover content has a list with both models.
    expect(screen.getAllByText('M2.7 · 快速')).toHaveLength(1)
    expect(screen.getAllByText('M3 · 默认最强')).toHaveLength(1)
  })

  it('calls patchSessionModel when a non-current model is clicked', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强')) // open popover
    fireEvent.click(screen.getByText('M2.7 · 快速'))   // pick the other model
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'MiniMax-M2.7-highspeed')
  })

  it('does not call patchSessionModel when the current model is clicked', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强')) // open popover
    // Clicking the currently-selected model again should be a no-op.
    // Both the badge and the list item render "M3 · 默认最强" — pick the
    // one inside the popover (the list item).
    const matches = screen.getAllByText('M3 · 默认最强')
    fireEvent.click(matches[matches.length - 1]!)
    expect(patchSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run all web tests**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/`
Expected: all pass. New file: 4 cases. Existing tests should be unaffected (ModelStatusBadge was only imported by Agent.tsx, which has no component test for it).

- [ ] **Step 5: Run typecheck**

Run: `cd packages/zai && node_modules/.bin/tsc -b --noEmit`
Expected: clean (no output).

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/ModelStatusButton.tsx \
        packages/zai/test/web/ModelStatusButton.test.tsx \
        packages/zai/src/web/src/pages/Agent.tsx
git rm packages/zai/src/web/src/components/ModelStatusBadge.tsx
git commit -m "feat(zai-web): ModelStatusButton replaces ModelStatusBadge — click to switch model"
```

---

## Final verification

After all 6 tasks:

```bash
cd packages/zai && node_modules/.bin/tsc -b --noEmit
cd packages/zai && node_modules/.bin/vitest run
```

Both should pass clean.

Manual smoke test (user step, not part of plan):
1. Edit `~/.zai/settings.json` to add `models: [{ alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强' }, ...]`
2. Restart zai server.
3. In the chat, click the model badge in the lower status bar — Popover lists models.
4. Pick one — badge updates immediately.
5. Refresh page — model persists.
6. Create a new session — defaults to the env/settings chain (not the previously selected model).

---

## Self-review

**Spec coverage:**
- ✓ Resolution chain (5 layers) — Task 1
- ✓ settings.json schema + `models[]` — Task 1 (types), Task 2 (route returns it)
- ✓ `/agent/prompt` reads `meta.model` + passes to runtime.run — Task 3
- ✓ PATCH `/api/agent/sessions/:id` — Task 3
- ✓ Store: `availableModels` + `patchSessionModel` + Session widening — Task 4
- ✓ `useConversationInfo.displayLabel` — Task 5
- ✓ `ModelStatusButton` popover — Task 6
- ✓ Delete `ModelStatusBadge.tsx` — Task 6
- ✓ Tests for all 5 new files — Tasks 1-6

**Placeholder scan:** No "TBD" / "implement later" / "fill in" / "similar to Task N" references. All code blocks are complete.

**Type consistency:**
- `ModelEntry` defined in Task 1 → used by Task 2 (`readZaiSettings` return), Task 4 (`availableModels`), Task 5 (`runtime.models`), Task 6 (`models` prop).
- `resolveModel` defined in Task 1 → used by Task 2 (`agentSettings` route) and Task 3 (`/agent/prompt`).
- `BUILTIN_FALLBACK_MODEL` exported by Task 1 → asserted in Task 1 test.
- `ConversationInfo.displayLabel` added in Task 5 → consumed by Task 6 (`ModelStatusButton`).
- `availableModels` and `patchSessionModel` added to store in Task 4 → consumed by Task 6.

All consistent.