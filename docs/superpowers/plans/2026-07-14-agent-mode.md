# Agent Permission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OpenCC 的 5 个 permission mode 暴露到 zai 平台，底栏 popover 切换当前 session 的 mode，per-session 持久化到 `transcript.meta.permissionMode`，下次发消息时透传到 runtime。

**Architecture:** 在 `zai-agent-core` 加 `QueryOptions.permissionMode` 字段；zai server 读 transcript meta 解析 mode 传给 runtime；zai web 底栏加 `ModeStatusButton` popover + shift+tab 快捷键，PATCH `/api/agent/sessions/:id` 写回 transcript。Runtime 无状态；transcript 是 mode 的唯一真源。

**Tech Stack:** TypeScript 5 / Zod / Express 4 / React 18 / Ant Design 5 / Zustand / Vitest

**Spec:** `docs/superpowers/specs/2026-07-14-agent-mode-design.md`

## Global Constraints

- **Mode 集**: `'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan'`（5 个，re-export from `opencc-internals/types/permissions.ts`）
- **Cycle order**: `default → acceptEdits → plan → bypassPermissions → dontAsk → default`
- **Persistence**: 写到 `transcript.meta.permissionMode`（per-session），新会话读 `~/.zai/settings.json` 的 `defaultMode`（缺省 `'default'`）
- **生效时机**: 切 mode 不中断正在 streaming 的 turn；下次发消息读最新 mode
- **shift+tab**: 在 input 焦点 + `status === 'idle'` 时响应；streaming 时不响应
- **Commit 格式**: `HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`
- **Type 改动**: zai-agent-core 的 `permissionMode` 字段是 optional，向后兼容

---

## File Map

### New files (4)
- `packages/zai-agent-core/src/runtime/permissionMode.ts` — `PermissionMode` re-export
- `packages/zai/src/web/src/components/ModeStatusButton.tsx` — 底栏 popover
- `packages/zai/test/web/ModeStatusButton.test.tsx` — 单元测试
- `packages/zai/test/server/agentSettingsMode.test.ts` — PATCH 路由测试

### Modified files (8)
- `packages/zai-agent-core/src/runtime/types.ts` — `QueryOptions` + `RuntimeConfig` 加 `permissionMode`
- `packages/zai-agent-core/src/transcript/types.ts` — `TranscriptFile.meta` + `TranscriptMeta` 加 `permissionMode`
- `packages/zai-agent-core/src/transcript/store.ts` — `create()` + `patch()` 接受 `permissionMode`
- `packages/zai-agent-core/src/transcript/serialization.ts` — `extractMeta` 透传 `permissionMode`
- `packages/zai-agent-core/src/runtime/queryEngine.ts` — 读 `options.permissionMode`，create 时写入
- `packages/zai/src/server/services/agentRuntime.ts` — 暴露 `resolveSessionMode` 辅助
- `packages/zai/src/server/routes/agent.ts` — PATCH 接受 `permissionMode`；GET sessions 返回；POST 用 defaultMode
- `packages/zai/src/web/src/store/useAgentStore.ts` — `sessions[].permissionMode` + `patchSessionMode`
- `packages/zai/src/web/src/pages/Agent.tsx` — 底栏用 `<ModeStatusButton />` + shift+tab cycle

---

## Task 1: zai-agent-core — PermissionMode type & transcript schema

**Files:**
- Create: `packages/zai-agent-core/src/runtime/permissionMode.ts`
- Modify: `packages/zai-agent-core/src/runtime/types.ts:87-114`
- Modify: `packages/zai-agent-core/src/transcript/types.ts:1-43`
- Modify: `packages/zai-agent-core/src/transcript/store.ts:12-86`
- Modify: `packages/zai-agent-core/src/transcript/serialization.ts:23-36`

**Interfaces:**
- Produces: `PermissionMode` type, `QueryOptions.permissionMode?: PermissionMode`, `TranscriptFile.meta.permissionMode?: PermissionMode`, `TranscriptMeta.permissionMode?: PermissionMode`, `TranscriptStore.create()` accepts `permissionMode`, `TranscriptStore.patch()` accepts `permissionMode`

- [ ] **Step 1: Create the PermissionMode re-export module**

Create `packages/zai-agent-core/src/runtime/permissionMode.ts`:

```ts
// Re-export the 5 user-addressable permission modes from upstream OpenCC
// internals. We expose a narrower surface than EXTERNAL_PERMISSION_MODES so
// the rest of the codebase doesn't have to know about 'auto' / 'bubble'
// (internal-only experimental modes).
export type { PermissionMode } from '../opencc-internals/types/permissions.js'
export { PERMISSION_MODES } from '../opencc-internals/types/permissions.js'
```

Then in `packages/zai-agent-core/src/runtime/index.ts`, add to the top of the file (after the existing re-exports):

```ts
export { PERMISSION_MODES } from './permissionMode.js'
export type { PermissionMode } from './permissionMode.js'
```

This makes the type importable as `import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'` (using the existing `./runtime` subpath export in `package.json`).

- [ ] **Step 2: Add `permissionMode` to `QueryOptions` and `RuntimeConfig`**

In `packages/zai-agent-core/src/runtime/types.ts`, add at the top of the file (after the existing type imports):

```ts
import type { PermissionMode } from './permissionMode.js'
```

Then in `RuntimeConfig` (line 41), add field after `defaultMaxTurns`:

```ts
  /** Default permission mode for new sessions. Falls back to 'default'. */
  defaultPermissionMode?: PermissionMode
```

Then in `QueryOptions` (line 87), add field after `skillsDirs`:

```ts
  /** Override the permission mode for this query. Higher priority than transcript meta. */
  permissionMode?: PermissionMode
```

- [ ] **Step 3: Run typecheck to verify it compiles**

Run: `cd packages/zai-agent-core && pnpm exec tsc --noEmit`
Expected: PASS (no errors). If errors about `PermissionMode` not found, re-check the import in Step 1.

- [ ] **Step 4: Extend `TranscriptFile.meta` and `TranscriptMeta` with `permissionMode`**

In `packages/zai-agent-core/src/transcript/types.ts`, add at top:

```ts
import type { PermissionMode } from '../runtime/permissionMode.js'
```

Update `TranscriptFile.meta` (line 4) to add `permissionMode?: PermissionMode` after `subagentType`:

```ts
  meta: {
    cwd: string
    model: string
    createdAt: number
    updatedAt: number
    title?: string
    tags?: string[]
    parentSessionId?: string
    subagentType?: string
    permissionMode?: PermissionMode
  }
```

Update `TranscriptMeta` (line 30) similarly:

```ts
export type TranscriptMeta = {
  transcriptId: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  title?: string
  tags?: string[]
  messageCount: number
  parentSessionId?: string
  subagentType?: string
  permissionMode?: PermissionMode
}
```

- [ ] **Step 5: Update `extractMeta` to pass through `permissionMode`**

In `packages/zai-agent-core/src/transcript/serialization.ts`, add field to the returned object (after `subagentType`):

```ts
    permissionMode: file.meta.permissionMode,
```

- [ ] **Step 6: Update `TranscriptStore.create` and `patch` to accept `permissionMode`**

In `packages/zai-agent-core/src/transcript/store.ts`:

Change `create` signature (line 12) to include `permissionMode`:

```ts
  async create(meta: Pick<TranscriptFile['meta'], 'cwd' | 'model' | 'permissionMode'> & {
    parentSessionId?: string
    subagentType?: string
  }, id?: string): Promise<string> {
```

In the body of `create` (line 21), pass through `permissionMode`:

```ts
      meta: { ...meta, createdAt: Date.now(), updatedAt: Date.now() },
```

(`...meta` already spreads `permissionMode` if present.)

Change `patch` signature (line 72) to include `permissionMode`:

```ts
  async patch(transcriptId: string, patch: { title?: string; tags?: string[]; model?: string; permissionMode?: string }): Promise<void> {
```

In the body of `patch` (line 78-80), add the `permissionMode` handler after the `model` branch:

```ts
      if (patch.title !== undefined) file.meta.title = patch.title
      if (patch.tags !== undefined) file.meta.tags = patch.tags
      if (patch.model !== undefined) file.meta.model = patch.model
      if (patch.permissionMode !== undefined) file.meta.permissionMode = patch.permissionMode as TranscriptFile['meta']['permissionMode']
```

- [ ] **Step 7: Run typecheck**

Run: `cd packages/zai-agent-core && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai-agent-core/src/runtime/permissionMode.ts \
        packages/zai-agent-core/src/runtime/types.ts \
        packages/zai-agent-core/src/transcript/types.ts \
        packages/zai-agent-core/src/transcript/store.ts \
        packages/zai-agent-core/src/transcript/serialization.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 暴露 PermissionMode + transcript meta 字段

新增 PermissionMode re-export (5 个 user-facing mode), 在 QueryOptions
和 RuntimeConfig 加 permissionMode 字段, transcript meta 也加这个
字段用于 per-session 持久化。TranscriptStore.create/patch 同步支持。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: zai-agent-core — queryEngine 写入新 session 的 permissionMode

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts:84-94`

**Interfaces:**
- Consumes: `QueryOptions.permissionMode` (from Task 1)
- Produces: 新建 transcript 时 `meta.permissionMode` 等于 `options.permissionMode ?? config.defaultPermissionMode ?? 'default'`

- [ ] **Step 1: Read the current `store.create()` call site**

In `packages/zai-agent-core/src/runtime/queryEngine.ts:84-94`, the relevant block:

```ts
  if (!options.transcriptId && !options.resumeFromTranscriptId) {
    await store.create({
      cwd: options.cwd,
      model: options.model ?? config.defaultModel ?? 'default',
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.subagentType ? { subagentType: options.subagentType } : {}),
    }, sessionId)
  }
```

- [ ] **Step 2: Add `permissionMode` to the `store.create` call**

Replace the block with:

```ts
  if (!options.transcriptId && !options.resumeFromTranscriptId) {
    await store.create({
      cwd: options.cwd,
      model: options.model ?? config.defaultModel ?? 'default',
      permissionMode: options.permissionMode ?? config.defaultPermissionMode ?? 'default',
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.subagentType ? { subagentType: options.subagentType } : {}),
    }, sessionId)
  }
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/zai-agent-core && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run existing tests to confirm no regression**

Run: `cd packages/zai-agent-core && pnpm test -- --run`
Expected: All existing tests pass (the new field is optional, backward-compatible).

- [ ] **Step 5: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai-agent-core/src/runtime/queryEngine.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 新建 session 时写入 permissionMode

store.create 时把 options.permissionMode 透传, fallback 顺序为
options > config.defaultPermissionMode > 'default'。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: zai server — 读 settings.defaultMode 并校验

**Files:**
- Modify: `packages/zai/src/server/routes/agentSettings.ts:16-30`
- Create: `packages/zai/src/server/services/permissionMode.ts`

**Interfaces:**
- Produces: `getDefaultMode(): PermissionMode` — 读 `~/.zai/settings.json` 的 `defaultMode` 字段，校验后返回，缺省/非法值返回 `'default'`

- [ ] **Step 1: Create the resolver service**

Create `packages/zai/src/server/services/permissionMode.ts`:

```ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PERMISSION_MODES, type PermissionMode } from '@zn-ai/zai-agent-core'

const VALID_MODES: ReadonlySet<PermissionMode> = new Set(PERMISSION_MODES)

/**
 * Read the default permission mode from ~/.zai/settings.json.
 *
 * Resolution order:
 *   1. settings.defaultMode (if present and in the 5 valid modes)
 *   2. 'default' (hardcoded fallback)
 *
 * File IO errors other than ENOENT / SyntaxError are silently treated
 * as "no defaultMode configured" — same defensive pattern as the rest
 * of the zai server.
 */
export function getDefaultMode(): PermissionMode {
  try {
    const path = join(homedir(), '.zai', 'settings.json')
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { defaultMode?: unknown }
    const candidate = parsed.defaultMode
    if (typeof candidate === 'string' && VALID_MODES.has(candidate as PermissionMode)) {
      return candidate as PermissionMode
    }
  } catch (err) {
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Real IO error — fall through to default.
    }
  }
  return 'default'
}
```

- [ ] **Step 2: Extend `/api/agent/settings` to return `defaultMode`**

In `packages/zai/src/server/routes/agentSettings.ts`, add the import at the top:

```ts
import { getDefaultMode } from '../services/permissionMode.js'
```

In the GET handler (line 45-56), add `defaultMode` to the response object:

```ts
router.get('/agent/settings', async (_req: Request, res: Response) => {
  try {
    const settings = readZaiSettings()
    const env = settings.env ?? {}
    const { model: defaultModel } = resolveModel({ sessionModel: null, cwd: '' })
    const baseURL = env.ANTHROPIC_BASE_URL ?? null
    const models = settings.models ?? []
    res.json({ defaultModel, baseURL, models, defaultMode: getDefaultMode() })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/zai && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/server/services/permissionMode.ts \
        packages/zai/src/server/routes/agentSettings.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai): 读 ~/.zai/settings.json 的 defaultMode

新增 getDefaultMode() 辅助, 校验后返回, 缺省/非法值回退 'default'。
GET /api/agent/settings 响应新增 defaultMode 字段供前端使用。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: zai server — PATCH /api/agent/sessions/:id 接受 permissionMode

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts:548-572`
- Modify: `packages/zai/src/server/routes/agent.ts:489-499` (GET sessions list)
- Modify: `packages/zai/src/server/routes/agent.ts:501-513` (POST new session)
- Create: `packages/zai/test/server/agentSettingsMode.test.ts`

**Interfaces:**
- Produces: PATCH `/api/agent/sessions/:id` 接受 `{ permissionMode: PermissionMode }` 并写回 transcript；GET sessions 返回的每条都含 `permissionMode`；POST sessions 用 `defaultMode` 初始化

- [ ] **Step 1: Write the failing test**

Create `packages/zai/test/server/agentSettingsMode.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TranscriptStore } from '@zn-ai/zai-agent-core'

// We need a fake cwd to feed the routes — agent.ts routes read req.app.locals.instanceContext.
let tmpDir: string
let dataDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'zai-mode-test-'))
  dataDir = path.join(tmpDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  vi.doMock('../../src/server/services/agentRuntime.js', () => ({
    getRuntime: () => { throw new Error('not used in this test') },
    getTranscriptStore: () => new TranscriptStore(dataDir),
    getCurrentSessionId: () => null,
    setCurrentSessionId: () => {},
    abortAgentSession: async () => {},
  }))
  vi.doMock('../../src/server/services/permissionMode.js', () => ({
    getDefaultMode: () => 'acceptEdits',
  }))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  vi.doUnmock('../../src/server/services/agentRuntime.js')
  vi.doUnmock('../../src/server/services/permissionMode.js')
})

async function loadAgentRouter() {
  const mod = await import('../../src/server/routes/agent.js')
  return mod.default
}

function buildApp(router: express.Router) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req.app.locals as any).instanceContext = { cwd: tmpDir, cwdName: 'test' }
    next()
  })
  app.use(router)
  return app
}

describe('PATCH /api/agent/sessions/:id permissionMode', () => {
  it('accepts a valid mode and persists it', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const store = new TranscriptStore(dataDir)
    const id = await store.create({ cwd: tmpDir, model: 'unknown' })

    const res = await request(app)
      .patch(`/api/agent/sessions/${id}`)
      .send({ permissionMode: 'plan' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const reloaded = await store.read(id)
    expect(reloaded.meta.permissionMode).toBe('plan')
  })

  it('rejects an invalid mode with 400', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const store = new TranscriptStore(dataDir)
    const id = await store.create({ cwd: tmpDir, model: 'unknown' })

    const res = await request(app)
      .patch(`/api/agent/sessions/${id}`)
      .send({ permissionMode: 'garbage' })

    expect(res.status).toBe(400)
    const reloaded = await store.read(id)
    expect(reloaded.meta.permissionMode).toBeUndefined()
  })

  it('returns 500 for unknown session id', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const res = await request(app)
      .patch('/api/agent/sessions/sess-does-not-exist')
      .send({ permissionMode: 'plan' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('GET /api/agent/sessions includes permissionMode', () => {
  it('returns the permissionMode field for each session', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const store = new TranscriptStore(dataDir)
    await store.create({ cwd: tmpDir, model: 'unknown', permissionMode: 'plan' })

    const res = await request(app).get('/api/agent/sessions')
    expect(res.status).toBe(200)
    expect(res.body.sessions.length).toBeGreaterThan(0)
    expect(res.body.sessions[0].permissionMode).toBe('plan')
  })
})

describe('POST /api/agent/sessions uses defaultMode', () => {
  it('initializes new sessions with the configured defaultMode', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const res = await request(app).post('/api/agent/sessions').send({})
    expect(res.status).toBe(200)
    expect(res.body.sessionId).toBeTruthy()
    const store = new TranscriptStore(dataDir)
    const transcript = await store.read(res.body.sessionId)
    expect(transcript.meta.permissionMode).toBe('acceptEdits')
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/zai && pnpm test -- agentSettingsMode.test.ts --run`
Expected: All tests FAIL (the route does not yet handle `permissionMode`).

- [ ] **Step 3: Extend the PATCH route to accept `permissionMode`**

In `packages/zai/src/server/routes/agent.ts:548-572`, add the import:

```ts
import { PERMISSION_MODES, type PermissionMode } from '@zn-ai/zai-agent-core'
```

Update the Zod schema (line 553-555) to include the new field:

```ts
const PatchSessionRequest = z.object({
  model: z.string().min(1).max(256).optional(),
  permissionMode: z.enum(PERMISSION_MODES as readonly [PermissionMode, ...PermissionMode[]]).optional(),
});
```

Update the handler (line 557-572) to apply the patch and return the updated meta:

```ts
router.patch("/agent/sessions/:id", async (req: Request, res: Response) => {
  const parsed = PatchSessionRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body" });
  }
  const sid = req.params.id;
  try {
    const store = getTranscriptStore();
    if (parsed.data.model && parsed.data.model !== "unknown") {
      await store.patch(sid, { model: parsed.data.model });
    }
    if (parsed.data.permissionMode) {
      await store.patch(sid, { permissionMode: parsed.data.permissionMode });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 4: Run the test to confirm PATCH cases pass**

Run: `cd packages/zai && pnpm test -- agentSettingsMode.test.ts --run`
Expected: The two PATCH cases PASS. The GET / POST cases still FAIL.

- [ ] **Step 5: Update GET /api/agent/sessions to surface `permissionMode`**

The existing `extractMeta` (in `transcript/serialization.ts`) already passes `permissionMode` through from Task 1 Step 5. The route at line 489-499 just returns `store.list(ctx.cwd)` — so `permissionMode` is already included automatically.

- [ ] **Step 6: Update POST /api/agent/sessions to use `getDefaultMode()`**

In `packages/zai/src/server/routes/agent.ts:501-513`, add the import:

```ts
import { getDefaultMode } from '../services/permissionMode.js'
```

Update the POST handler (line 504) to use the default:

```ts
router.post("/agent/sessions", async (req: Request, res: Response) => {
  try {
    const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
    const store = getTranscriptStore()
    const sessionId = await store.create({
      cwd: ctx.cwd,
      model: 'unknown',
      permissionMode: getDefaultMode(),
    })
    res.json({ sessionId })
```

- [ ] **Step 7: Run all the new tests**

Run: `cd packages/zai && pnpm test -- agentSettingsMode.test.ts --run`
Expected: All 4 test cases PASS.

- [ ] **Step 8: Run the full zai test suite to confirm no regression**

Run: `cd packages/zai && pnpm test -- --run`
Expected: All existing tests still pass.

- [ ] **Step 9: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/server/routes/agent.ts \
        packages/zai/test/server/agentSettingsMode.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai): PATCH/GET/POST sessions 支持 permissionMode

- PATCH 接受 permissionMode 字段, Zod 校验 5 个合法 mode
- POST 新建 session 时用 getDefaultMode() 初始化
- GET sessions 自动通过 extractMeta 返回 permissionMode

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: zai server — agentRuntime 服务把 mode 透传到 runtime.query()

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts:28-54` (PromptRequest Zod schema + main handler)

**Interfaces:**
- Produces: 当 handler 调 `runtime.run({ ... })` 时，把 `permissionMode` 从 `transcript.meta.permissionMode ?? getDefaultMode()` 透传

- [ ] **Step 1: Find the runtime.run() call site**

In `packages/zai/src/server/routes/agent.ts`, locate the main prompt handler — search for `runtime.run` or `getRuntime().run`. Around line 200-300 (the main prompt handler invokes the runtime).

- [ ] **Step 2: Add `permissionMode` to the runtime.run() call**

The handler in `agent.ts` reads the existing transcript (when resuming) and stores new messages via `append()`. We need to pass `permissionMode` to the runtime when starting a query. Locate the `getRuntime().run(...)` call and add a `permissionMode` field.

The exact location depends on the existing code. Apply this edit to the QueryOptions object passed to `runtime.run`:

```ts
      permissionMode:
        (transcript?.meta?.permissionMode as PermissionMode | undefined)
        ?? getDefaultMode(),
```

If the existing `transcript` variable is not in scope (i.e. the handler only creates sessions on first message), use:

```ts
      permissionMode: getDefaultMode(),
```

The zai-agent-core `QueryOptions` accepts `permissionMode` as optional (Task 1), so passing it as a literal is type-safe.

- [ ] **Step 3: Run typecheck**

Run: `cd packages/zai && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the full zai test suite**

Run: `cd packages/zai && pnpm test -- --run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/server/routes/agent.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai): 发消息时透传 permissionMode 到 runtime

runtime.run() 调用前从 transcript.meta 读 mode, 缺省走
getDefaultMode()。这样切换 mode 后下次发消息立即生效, 不需要
重启 runtime。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: zai web — useAgentStore 加 sessions[].permissionMode 和 patchSessionMode action

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:56-117` (interface)
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:413-434` (add patchSessionMode)

**Interfaces:**
- Produces: `sessions[].permissionMode?: PermissionMode`, `patchSessionMode(sid, mode): Promise<void>` action（mirror patchSessionModel）

- [ ] **Step 1: Add `PermissionMode` import**

In `packages/zai/src/web/src/store/useAgentStore.ts`, add at the top (after the existing imports):

```ts
import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'
```

- [ ] **Step 2: Add `permissionMode` to the session shape in the AgentState interface**

In the `AgentState` interface (around line 56-67), update the `sessions` array type:

```ts
  sessions: Array<{
    transcriptId: string
    title?: string
    updatedAt: number
    /** Resolved model name (from transcript.meta.model). 'unknown' or absent = not set. */
    model?: string
    /** Per-session permission mode (default/acceptEdits/plan/bypassPermissions/dontAsk). */
    permissionMode?: PermissionMode
    cwd?: string
    createdAt?: number
    messageCount?: number
  }>
```

- [ ] **Step 3: Add `patchSessionMode` to the action interface**

In the `AgentState` interface (after the existing `patchSessionModel`), add:

```ts
  /** Optimistic PATCH /api/agent/sessions/:id + local session mode update. */
  patchSessionMode: (sid: string, mode: PermissionMode) => Promise<void>
```

- [ ] **Step 4: Implement `patchSessionMode` action**

After the existing `patchSessionModel` action (around line 434), add:

```ts
  patchSessionMode: async (sid, mode) => {
    // Snapshot for revert on failure.
    const prev = get().sessions
    // Optimistic local update so the badge switches immediately.
    set({
      sessions: prev.map((x) =>
        x.transcriptId === sid ? { ...x, permissionMode: mode } : x,
      ),
    })
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
        body: JSON.stringify({ permissionMode: mode }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Revert the optimistic update.
      set({ sessions: prev })
    }
  },
```

- [ ] **Step 5: Update `session.created` SSE reducer to also store mode**

The existing `session.created` reducer (line 742-753) creates a session entry with `{ transcriptId, title, updatedAt }`. Update the inline cast and the push to include `permissionMode`:

```ts
      case 'session.created': {
        const list = state.sessions as Array<{ transcriptId: string; title?: string; updatedAt: number; permissionMode?: PermissionMode }>
        if (list.some((x) => x.transcriptId === sid)) return state
        return {
          ...state,
          sessions: [{ transcriptId: sid, title: event.title, updatedAt: Date.now() }, ...list],
        }
      }
```

(For the `session.deleted` reducer the type cast also needs the new field — extend it the same way.)

- [ ] **Step 6: Run typecheck**

Run: `cd packages/zai && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Run existing useAgentStore tests**

Run: `cd packages/zai && pnpm test -- useAgentStore --run`
Expected: All existing tests pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-web): useAgentStore 加 patchSessionMode action

sessions 元素新增 permissionMode 字段, 新增 patchSessionMode action
（mirror patchSessionModel: optimistic update + 失败回滚）。PATCH
调用现有的 /api/agent/sessions/:id 端点。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: zai web — ModeStatusButton popover 组件

**Files:**
- Create: `packages/zai/src/web/src/components/ModeStatusButton.tsx`
- Create: `packages/zai/test/web/ModeStatusButton.test.tsx`

**Interfaces:**
- Consumes: `useAgentStore` (current session + patchSessionMode)
- Produces: 底栏按钮 + popover，5 个 mode 列表，点选触发 patchSessionMode

- [ ] **Step 1: Write the failing test (render)**

Create `packages/zai/test/web/ModeStatusButton.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ModeStatusButton from '../../src/web/src/components/ModeStatusButton.jsx'

// Minimal store stub
const sessions = [{ transcriptId: 's1', permissionMode: 'default' }]
const patchSessionMode = vi.fn()

vi.mock('../../src/web/src/store/useAgentStore.js', () => ({
  useAgentStore: (selector: any) => selector({
    sessions,
    activeSessionId: 's1',
    sessionId: 's1',
    patchSessionMode,
  }),
}))

describe('ModeStatusButton', () => {
  beforeEach(() => {
    patchSessionMode.mockReset()
  })

  it('renders the current mode label as the badge text', () => {
    render(<ModeStatusButton />)
    expect(screen.getByRole('button', { name: /default/i })).toBeTruthy()
  })

  it('opens popover with all 5 modes on click', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByRole('button', { name: /default/i }))
    const popover = screen.getByTestId('mode-picker-content')
    expect(within(popover).getByText('default')).toBeTruthy()
    expect(within(popover).getByText('accept edits')).toBeTruthy()
    expect(within(popover).getByText('plan')).toBeTruthy()
    expect(within(popover).getByText('bypass on')).toBeTruthy()
    expect(within(popover).getByText("don't ask")).toBeTruthy()
  })

  it('calls patchSessionMode with the picked mode on click', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByRole('button', { name: /default/i }))
    const popover = screen.getByTestId('mode-picker-content')
    fireEvent.click(within(popover).getByText('plan'))
    expect(patchSessionMode).toHaveBeenCalledWith('s1', 'plan')
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd packages/zai && pnpm test -- ModeStatusButton --run`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the ModeStatusButton component**

Create `packages/zai/src/web/src/components/ModeStatusButton.tsx`:

```tsx
import { useMemo, useRef, useState } from 'react'
import { Button, Popover } from 'antd'
import { useAgentStore } from '../store/useAgentStore.js'
import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'

// Canonical cycle order (matches OpenCC TUI shift+tab order).
const MODE_CYCLE: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
]

// Display labels and color tints. Red is reserved for the two high-risk
// modes (bypassPermissions / dontAsk) — same as OpenCC TUI.
const MODE_META: Record<PermissionMode, { label: string; color: string }> = {
  default:        { label: 'default',      color: 'rgba(255,255,255,0.65)' },
  acceptEdits:    { label: 'accept edits', color: 'rgba(255,255,255,0.65)' },
  plan:           { label: 'plan',         color: 'rgba(255,255,255,0.65)' },
  bypassPermissions: { label: 'bypass on', color: '#f43f5e' },
  dontAsk:        { label: "don't ask",    color: '#f43f5e' },
}

export const MODE_CYCLE_ORDER = MODE_CYCLE

export default function ModeStatusButton() {
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const sessionId = useAgentStore((s) => s.sessionId)
  const patchSessionMode = useAgentStore((s) => s.patchSessionMode)

  const currentSessionId = sessionId ?? activeSessionId ?? null
  const currentSession = useMemo(
    () => sessions.find((s) => s.transcriptId === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )
  const currentMode: PermissionMode = currentSession?.permissionMode ?? 'default'
  const meta = MODE_META[currentMode]

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = MODE_CYCLE.indexOf(currentMode)
    return idx === -1 ? 0 : idx
  })
  // Keep selectedIndex in sync with the actual current mode (e.g. when
  // a PATCH response lands and the store updates while the popover is open).
  const lastSeenModeRef = useRef(currentMode)
  if (lastSeenModeRef.current !== currentMode) {
    lastSeenModeRef.current = currentMode
    const idx = MODE_CYCLE.indexOf(currentMode)
    if (idx !== -1 && idx !== selectedIndex) setSelectedIndex(idx)
  }

  const pick = (mode: PermissionMode) => {
    if (mode === currentMode) return
    if (!currentSessionId) return
    void patchSessionMode(currentSessionId, mode)
  }

  const content = (
    <div
      data-testid="mode-picker-content"
      tabIndex={-1}
      style={{
        width: 280,
        background: '#1f1f1f',
        color: '#fff',
        borderRadius: 6,
        padding: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.55)' }}>
          Select mode
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>esc</span>
      </div>
      {MODE_CYCLE.map((m, i) => {
        const isCurrent = m === currentMode
        const isSelected = i === selectedIndex
        return (
          <div
            key={m}
            data-testid={`mode-row-${m}`}
            data-current={isCurrent ? 'true' : 'false'}
            data-selected={isSelected ? 'true' : 'false'}
            onClick={() => pick(m)}
            onMouseEnter={() => setSelectedIndex(i)}
            style={{
              padding: '5px 8px',
              borderRadius: 4,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isSelected ? 'rgba(168, 139, 250, 0.15)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ color: '#a78bfa', fontSize: 12, width: 7, lineHeight: 1 }}>
              {isCurrent ? '●' : ''}
            </span>
            <span
              style={{
                fontSize: 13,
                color: MODE_META[m].color,
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              {MODE_META[m].label}
            </span>
          </div>
        )
      })}
      <div
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.30)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          paddingTop: 6,
          marginTop: 4,
        }}
      >
        click to select · shift+tab to cycle
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        data-testid="mode-status-button"
        title={`当前 mode: ${meta.label}\n点击切换`}
        style={{
          color: meta.color,
          opacity: 0.9,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          padding: '0 6px',
        }}
      >
        ▶▶ {meta.label}
      </Button>
    </Popover>
  )
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd packages/zai && pnpm test -- ModeStatusButton --run`
Expected: All 3 test cases PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/components/ModeStatusButton.tsx \
        packages/zai/test/web/ModeStatusButton.test.tsx
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-web): ModeStatusButton 底栏 popover

仿 ModelStatusButton 的视觉风格, 列出 5 个 mode + 颜色区分
（高风险 mode 红色）。点击触发 patchSessionMode。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: zai web — Agent.tsx 底栏接入 + shift+tab cycle

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1849-1874` (bottom bar)
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1344-1373` (handleKeyDown)

**Interfaces:**
- Produces: 底栏显示当前 mode（点开 popover 可切）；shift+tab 在 input 焦点 + idle 时循环切 mode

- [ ] **Step 1: Replace the static `▶▶ zai` text in the bottom bar with `<ModeStatusButton />`**

In `packages/zai/src/web/src/pages/Agent.tsx`, add the import (around line 45-47, where `ModelStatusButton` is imported):

```tsx
import ModeStatusButton from "../components/ModeStatusButton";
```

In the bottom bar (line 1849-1874), replace the line that renders the static `▶▶ zai` span:

Old:
```tsx
            <span style={{ color: "#f43f5e" }}>▶▶ zai</span>
```

New:
```tsx
            <ModeStatusButton />
```

Also remove the `<span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>` immediately after it (the popover now occupies the visual slot; the dot separator was for the static label).

- [ ] **Step 2: Add shift+tab cycle to handleKeyDown**

In `packages/zai/src/web/src/pages/Agent.tsx:1344-1373`, locate `handleKeyDown`. Add the shift+tab branch **before** the existing `Enter` check (so it gets first chance to handle Tab and prevent default):

```tsx
    // shift+tab: cycle permission mode (only when idle, not while streaming)
    if (e.key === "Tab" && e.shiftKey && status === "idle" && sessionId) {
      e.preventDefault();
      const currentMode =
        sessions.find((s) => s.transcriptId === sessionId)?.permissionMode
        ?? "default";
      const idx = MODE_CYCLE_ORDER.indexOf(currentMode);
      const next = MODE_CYCLE_ORDER[(idx + 1) % MODE_CYCLE_ORDER.length]!;
      void patchSessionMode(sessionId, next);
      return;
    }
```

Add the import for `MODE_CYCLE_ORDER` at the top:

```tsx
import ModeStatusButton, { MODE_CYCLE_ORDER } from "../components/ModeStatusButton";
```

Add the store hook in the component body (alongside the other `useAgentStore` calls at the top of the function — search for `useAgentStore((s) => s.sessions)` and add near it):

```tsx
  const patchSessionMode = useAgentStore((s) => s.patchSessionMode);
```

(The `sessions` and `status` / `sessionId` selectors are already in scope; verify by reading the existing destructuring at the top of the Agent component.)

- [ ] **Step 3: Run typecheck**

Run: `cd packages/zai && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run all zai tests**

Run: `cd packages/zai && pnpm test -- --run`
Expected: All tests pass (ModeStatusButton tests from Task 7 included).

- [ ] **Step 5: Manual smoke check via dev server**

Run: `cd packages/zai && pnpm dev` in one terminal, then open `http://localhost:9888` in the browser.

Verify:
- [ ] Agent page loads without console errors
- [ ] Bottom bar shows the current mode (default or whatever `settings.defaultMode` is)
- [ ] Clicking the mode button opens a popover with 5 entries
- [ ] Clicking "plan" updates the badge text to "▶▶ plan"
- [ ] Pressing shift+tab in the input (while idle) cycles to the next mode
- [ ] Refreshing the page preserves the selected mode
- [ ] Switching session in the sidebar shows the new session's mode (default unless previously changed)

- [ ] **Step 6: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-web): 底栏接入 ModeStatusButton + shift+tab cycle

底栏静态 "▶▶ zai" 替换为 <ModeStatusButton />, input 焦点下按
shift+tab 在 5 个 mode 间循环。Streaming 时 shift+tab 不响应,
避免与 LLM 输出冲突。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 全量回归 + 提交

**Files:** (无)

- [ ] **Step 1: 跑全 monorepo 测试**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm test`
Expected: All tests pass across zai and zai-agent-core.

- [ ] **Step 2: 跑构建**

Run: `cd /Users/liangxuechao572/code/opencc-web && pnpm -r run build`
Expected: Both `zai-agent-core` and `zai` build successfully.

- [ ] **Step 3: 验证 git log 是干净的（每 task 一个 commit）**

Run: `cd /Users/liangxuechao572/code/opencc-web && git log --oneline -10`
Expected: 6 new commits on top of `64c7f78`, all matching the `HRMSV3-ZN-WEBSITE#668` prefix and following the conventional-commit format.

- [ ] **Step 4: (Optional) 手动端到端冒烟**

启动 `pnpm --filter @zn-ai/zai dev` → 浏览器打开 → 走一遍 Task 8 Step 5 的 checklist。

- [ ] **Step 5: 报告完成**

报告里列：
- 总 commit 数（应为 6 个）
- 跑通的测试数（zai + zai-agent-core 加起来）
- 手动冒烟结果

---

## Self-Review Checklist

After all tasks are complete, verify:

- [ ] **Spec coverage**:
  - [ ] `QueryOptions` / `RuntimeConfig` 加 `permissionMode` ✓ Task 1
  - [ ] queryEngine 写入新 session 的 mode ✓ Task 2
  - [ ] settings.defaultMode 读取 + 校验 ✓ Task 3
  - [ ] PATCH /api/agent/sessions/:id 接受 mode ✓ Task 4
  - [ ] GET sessions 返回 mode ✓ Task 4
  - [ ] POST sessions 用 defaultMode ✓ Task 4
  - [ ] 发消息时透传 mode 到 runtime ✓ Task 5
  - [ ] useAgentStore patchSessionMode action ✓ Task 6
  - [ ] ModeStatusButton 组件 ✓ Task 7
  - [ ] 底栏接入 + shift+tab ✓ Task 8
- [ ] **No placeholders**: Each step has actual code (not "TODO").
- [ ] **Type consistency**: `PermissionMode` type used consistently across files; `MODE_CYCLE_ORDER` exported once and imported in Agent.tsx.
- [ ] **Backward compat**: All new fields are optional; old transcripts without `permissionMode` resolve to `defaultMode ?? 'default'`.
- [ ] **Tests cover**: PATCH happy / 400 / 404; GET returns mode; POST uses default; ModeStatusButton render/click.
- [ ] **No lint regressions**: `pnpm exec eslint .` (if configured) passes.
