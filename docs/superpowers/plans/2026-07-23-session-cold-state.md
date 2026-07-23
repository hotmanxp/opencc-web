# Session Cold-State Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /api/agent/sessions/:id/state` aggregated endpoint and `useAgentStore.hydrateSessionState(sid)` action so the web UI shows cwd / v2 tasks / bash tasks / agent tasks immediately on session open or switch, before the first SSE event arrives.

**Architecture:** Single REST endpoint fans out 4-way parallel read from `CwdStore` + `TaskListStore` + `BashBackgroundTracker` + `BackgroundRuntime`, each with independent try/catch so any one failure silently degrades that field only. Client action `hydrateSessionState(sid)` writes the 4 fields into the existing per-session maps in `useAgentStore`. SSE remains the source of truth — REST only fills cold-start gap. Two trigger sites: `useEventStream` on `server.connected` (after SSE per-sid slice is registered) and `useAgentStore.setCurrentSession` (parallel with SSE reconnect).

**Tech Stack:** TypeScript, Express, vitest, Zustand, fetch.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-session-cold-state-design.md` — all fields, routes, and reducer invariants defined there.
- Per-task reducer invariant from existing code: `cwdBySession[sid]` (string, NOT `{cwd, updatedAt}`), `v2TasksBySession[sid]` (V2TaskItem[]), `bashTasksBySession[sid]` (BashTaskInfo[]), `agentTasksBySession[sid]` (BackgroundTaskSummary[]).
- BashTracker list signature (already exists, do not re-add): `list(filter?: { sessionId?: string; limit?: number }): BashTaskInfo[]` at `packages/zai-agent-core/src/tools/BashTool/bashTracker.ts:312`. Returns sorted by `startedAt desc`, default limit 200.
- `BackgroundRuntime.list()` returns `Promise<BackgroundTask[]>`, takes optional `TaskListFilter` with `status` + `limit` only (no `parentSessionId`). Filter by `parentSessionId` post-hoc in route handler.
- `getTaskListStore().list(sid)` returns `Promise<TaskItem[]>` already filtered by sessionId + auto-excludes `_internal` / `deleted`. Trim `metadata` + `sessionId` in the route to match `routes/v2Tasks.ts:33-43` shape.
- `CwdStore.get(sid)` returns `string | undefined` — use `.has()` first to disambiguate "not set" vs "set to empty string" (not actually possible, but defensive).
- `setCurrentSession` is **synchronous** (`useAgentStore.ts:976`), returns void. Fire-and-forget with `void get().hydrateSessionState(sid)`.
- All server unit tests live in `packages/zai/src/server/routes/` directly (sibling of `agent.cwd.test.ts`), NOT in a `test/unit/routes/` subdir — pattern mismatch will break the test runner.
- All client unit tests live in `packages/zai/src/web/src/<target>.test.ts` (sibling of source, e.g. `useAgentStore.test.ts` if it exists). Verify with `Glob` before creating new file.
- Server test command (from `packages/zai/`): `npx vitest run src/server/routes/<file>.test.ts`
- Web test command (from `packages/zai/`): `npx vitest run src/web/<path>/<file>.test.ts`
- Always commit in feature branch `feat/session-cold-state` (create from main if absent). Two commits total: server (Tasks 1+2) and web (Tasks 3+4+5).

---

## File Structure

**New:**
- `packages/zai/src/server/routes/sessionState.ts` — Express router, single GET handler
- `packages/zai/src/server/routes/sessionState.test.ts` — vitest unit, covers 8 cases from spec §7.1

**Modified:**
- `packages/zai/src/server/index.ts` — register `sessionStateRouter` (2 lines)
- `packages/zai/src/web/src/store/useAgentStore.ts` — add `hydrateSessionState` action (~30 lines), call from `setCurrentSession` (1 line)
- `packages/zai/src/web/src/store/useEventStream.ts` — call `hydrateSessionState` in `server.connected` case (3 lines)

**Untouched** (per spec §9): all 4 `apply*Changed` reducers, `lib/eventSource.ts`, `CwdStore` / `TaskListStore` / `JsonTaskStore`, the 3 consumer hooks.

---

### Task 1: Branch + Server Endpoint Skeleton

**Files:**
- Create: `packages/zai/src/server/routes/sessionState.ts`
- Modify: `packages/zai/src/server/index.ts`

**Interfaces:**
- Consumes: `CwdStore` (from `@zn-ai/zai-agent-core/runtime`), `getTaskListStore()` (from `@zn-ai/zai-agent-core/taskListStore`), `bashBackgroundTracker` (from `@zn-ai/zai-agent-core/bashTracker`), `getBackgroundRuntime()` (from `../services/backgroundRuntime.js`)
- Produces: `sessionStateRouter` (Express `IRouter`), `GET /api/agent/sessions/:id/state`

- [ ] **Step 1: Create feature branch**

Run: `git checkout -b feat/session-cold-state`
Expected: `Switched to a new branch 'feat/session-cold-state'`

- [ ] **Step 2: Verify dependencies are importable**

Run: `cd packages/zai && grep -E "(CwdStore|taskListStore|bashBackgroundTracker|backgroundRuntime)" src/server/routes/agent.ts src/server/routes/v2Tasks.ts src/server/routes/bashTasks.ts | head -20`
Expected: At least 4 matches showing existing imports of these names.

- [ ] **Step 3: Create `packages/zai/src/server/routes/sessionState.ts`**

Write:
```ts
import { Router, type IRouter, type Request, type Response } from 'express'
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
import { getTaskListStore } from '@zn-ai/zai-agent-core/taskListStore'
import { bashBackgroundTracker } from '@zn-ai/zai-agent-core/bashTracker'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

const router: IRouter = Router()

interface V2TaskItemWire {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: string
  blocks: string[]
  blockedBy: string[]
  owner?: string
  updatedAt: number
}

function trimV2Task(t: {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: string
  blocks: string[]
  blockedBy: string[]
  owner?: string
  updatedAt: number
}): V2TaskItemWire {
  return {
    id: t.id,
    subject: t.subject,
    description: t.description,
    activeForm: t.activeForm,
    status: t.status,
    blocks: t.blocks,
    blockedBy: t.blockedBy,
    owner: t.owner,
    updatedAt: t.updatedAt,
  }
}

/**
 * GET /api/agent/sessions/:id/state
 *
 * 返回 session 当前的 cold-start 快照 (cwd + v2 tasks + bash tasks + agent tasks),
 * 给前端 useAgentStore.hydrateSessionState(sid) 用,填补 SSE 第一条 *.changed 到达前
 * 的 UI 空窗。任一字段失败 → 静默降级 (null / []),不影响其它字段。
 *
 * SSE 仍是 source of truth — 这个端点只在首次打开/切换 session 时被调用一次,
 * 后续 SSE 推送的 state.* 事件会通过现有 reducer 覆盖写入 store。
 *
 * 详见 docs/superpowers/specs/2026-07-23-session-cold-state-design.md。
 */
router.get('/agent/sessions/:id/state', async (req: Request, res: Response) => {
  const sid = req.params.id

  const [cwdResult, v2Result, bashResult, agentResult] = await Promise.all([
    Promise.resolve()
      .then(() => {
        // CwdStore 不存 updatedAt, 用 Date.now() 占位 — 服务端重启后 cwd
        // 全清, 这个 updatedAt 只用于客户端去重/debug, 精度不重要。
        const cwd = CwdStore.has(sid) ? CwdStore.get(sid) : null
        return cwd ? { cwd, updatedAt: Date.now() } : null
      })
      .catch((err: unknown) => {
        console.warn('[sessionState] cwd failed', err)
        return null
      }),

    getTaskListStore()
      .list(sid)
      .then((tasks) => tasks.map(trimV2Task))
      .catch((err: unknown) => {
        console.warn('[sessionState] v2 failed', err)
        return [] as V2TaskItemWire[]
      }),

    Promise.resolve()
      .then(() => bashBackgroundTracker.list({ sessionId: sid }))
      .catch((err: unknown) => {
        console.warn('[sessionState] bash failed', err)
        return []
      }),

    getBackgroundRuntime()
      .list()
      .then((all) => all.filter((t) => t.parentSessionId === sid))
      .catch((err: unknown) => {
        console.warn('[sessionState] agent failed', err)
        return []
      }),
  ])

  res.json({
    cwd: cwdResult,
    v2Tasks: v2Result,
    bashTasks: bashResult,
    agentTasks: agentResult,
  })
})

export default router
```

- [ ] **Step 4: Register router in `packages/zai/src/server/index.ts`**

Add import at top (alongside the other route imports around line 14-21):
```ts
import sessionStateRouter from './routes/sessionState.js'
```

Add `app.use` call after `v2TasksRouter` (around line 97, before `transcriptRouter`):
```ts
app.use('/api', sessionStateRouter)
```

- [ ] **Step 5: Smoke-check TypeScript compiles**

Run: `cd packages/zai && npx tsc --noEmit -p tsconfig.json 2>&1 | head -40`
Expected: no errors related to `sessionState.ts` (other pre-existing errors OK to ignore).

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/routes/sessionState.ts packages/zai/src/server/index.ts
git commit -m "feat(zai-server): add GET /api/agent/sessions/:id/state endpoint and tests for cold-start hydration"
```

---

### Task 2: Server Unit Tests

**Files:**
- Create: `packages/zai/src/server/routes/sessionState.test.ts`

**Interfaces:**
- Consumes: `sessionStateRouter`, `CwdStore`, `bashBackgroundTracker`, `getTaskListStore`, `getBackgroundRuntime`
- Produces: 8 vitest test cases matching spec §7.1

- [ ] **Step 1: Verify test infra pattern from `agent.cwd.test.ts`**

Read `packages/zai/src/server/routes/agent.cwd.test.ts` to confirm the vitest + supertest + express + mock pattern. The existing test uses `beforeEach` to reset `CwdStore.clear()` and mounts only `agentRouter`.

- [ ] **Step 2: Create `packages/zai/src/server/routes/sessionState.test.ts`**

Write:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock the zai-agent-core modules before importing the router under test
vi.mock('@zn-ai/zai-agent-core/runtime', () => ({
  CwdStore: {
    clear: () => undefined,
    has: (_sid: string) => false,
    get: (_sid: string) => undefined as string | undefined,
    set: (_sid: string, _cwd: string) => undefined,
  },
}))
vi.mock('@zn-ai/zai-agent-core/taskListStore', () => ({
  getTaskListStore: () => ({
    list: async (_sid: string) => [],
  }),
}))
vi.mock('@zn-ai/zai-agent-core/bashTracker', () => ({
  bashBackgroundTracker: {
    list: (_filter?: { sessionId?: string; limit?: number }) => [],
  },
}))
vi.mock('../services/backgroundRuntime.js', () => ({
  getBackgroundRuntime: () => ({
    list: async () => [],
  }),
}))

import sessionStateRouter from './sessionState.js'
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
import { bashBackgroundTracker } from '@zn-ai/zai-agent-core/bashTracker'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

describe('GET /api/agent/sessions/:id/state', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use('/api', sessionStateRouter)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 with 4 fields, all empty when stores are empty', async () => {
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      cwd: null,
      v2Tasks: [],
      bashTasks: [],
      agentTasks: [],
    })
  })

  it('returns cwd when CwdStore has the session', async () => {
    vi.mocked(CwdStore.has).mockImplementation((sid) => sid === 'sess-1')
    vi.mocked(CwdStore.get).mockImplementation((sid) =>
      sid === 'sess-1' ? '/abs/path' : undefined,
    )
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.status).toBe(200)
    expect(res.body.cwd).toEqual({ cwd: '/abs/path', updatedAt: expect.any(Number) })
  })

  it('returns cwd=null when CwdStore does not have the session', async () => {
    vi.mocked(CwdStore.has).mockReturnValue(false)
    const res = await request(app).get('/api/agent/sessions/sess-x/state')
    expect(res.body.cwd).toBeNull()
  })

  it('falls back to cwd=null when CwdStore.has throws, others unaffected', async () => {
    vi.mocked(CwdStore.has).mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.cwd).toBeNull()
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.bashTasks).toEqual([])
    expect(res.body.agentTasks).toEqual([])
  })

  it('falls back to v2Tasks=[] when TaskListStore throws, others unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { getTaskListStore } = await import('@zn-ai/zai-agent-core/taskListStore')
    vi.mocked(getTaskListStore).mockReturnValue({
      list: async () => {
        throw new Error('boom')
      },
    } as ReturnType<typeof getTaskListStore>)
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.bashTasks).toEqual([])
    expect(res.body.agentTasks).toEqual([])
    expect(warn).toHaveBeenCalledWith('[sessionState] v2 failed', expect.any(Error))
    warn.mockRestore()
  })

  it('falls back to bashTasks=[] when BashTracker throws, others unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(bashBackgroundTracker.list).mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.bashTasks).toEqual([])
    expect(res.body.cwd).toBeNull()
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.agentTasks).toEqual([])
    expect(warn).toHaveBeenCalledWith('[sessionState] bash failed', expect.any(Error))
    warn.mockRestore()
  })

  it('falls back to agentTasks=[] when BackgroundRuntime throws, others unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(getBackgroundRuntime).mockReturnValue({
      list: async () => {
        throw new Error('boom')
      },
    } as ReturnType<typeof getBackgroundRuntime>)
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.agentTasks).toEqual([])
    expect(res.body.cwd).toBeNull()
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.bashTasks).toEqual([])
    expect(warn).toHaveBeenCalledWith('[sessionState] agent failed', expect.any(Error))
    warn.mockRestore()
  })

  it('agentTasks only returns tasks whose parentSessionId matches the session', async () => {
    vi.mocked(getBackgroundRuntime).mockReturnValue({
      list: async () => [
        { id: 't1', parentSessionId: 'sess-1', status: 'completed' },
        { id: 't2', parentSessionId: 'sess-2', status: 'completed' },
        { id: 't3', parentSessionId: 'sess-1', status: 'running' },
        { id: 't4', status: 'completed' }, // no parentSessionId
      ],
    } as ReturnType<typeof getBackgroundRuntime>)
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.agentTasks).toHaveLength(2)
    expect(res.body.agentTasks.map((t: { id: string }) => t.id).sort()).toEqual(['t1', 't3'])
  })
})
```

- [ ] **Step 3: Run the test to verify all 8 pass**

Run: `cd packages/zai && npx vitest run src/server/routes/sessionState.test.ts`
Expected: 8 tests passed, 0 failed.

- [ ] **Step 4: If any fail, fix them and re-run before committing**

Common fix patterns:
- `vi.mocked(CwdStore.has)` — make sure CwdStore mock factory returns a plain object with all methods (not a class instance)
- Async mock not invoked — wrap in `async () => {...}` for `list`
- Type cast for `ReturnType<typeof getTaskListStore>` — may need `as any` if the helper type is unwieldy

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/sessionState.test.ts
git commit --amend --no-edit
```

---

### Task 3: Client `hydrateSessionState` Action

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`

**Interfaces:**
- Consumes: existing `AgentState` type, `set` / `get` from zustand `create`
- Produces: new action `hydrateSessionState: (sid: string) => Promise<void>`

- [ ] **Step 1: Check if `useAgentStore.test.ts` already exists**

Run: `ls packages/zai/src/web/src/store/useAgentStore.test.ts 2>&1`
Expected: either file exists (use it as pattern) or "No such file" (create new sibling).

- [ ] **Step 2: Locate the existing `setCurrentSession` action**

Run: `grep -n "setCurrentSession:" packages/zai/src/web/src/store/useAgentStore.ts`
Expected: line ~977. Verify the action signature is sync (`(sessionId: string) => { ... }`).

- [ ] **Step 3: Add `hydrateSessionState` action and modify `setCurrentSession`**

Open `useAgentStore.ts`. Find the `setCurrentSession` action (around line 977). Add `hydrateSessionState` immediately after it (or before, near other async actions). Then modify `setCurrentSession` to fire-and-forget the hydration.

Replace the `setCurrentSession` block with:
```ts
  setCurrentSession: (sessionId: string) => {
    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0 })
    // 同步 URL ?sid=..., 让刷新/分享链接落到同一会话.
    writeUrlSid(sessionId)
    // ★ Cold-start 快照补全: 切会话时 fire-and-forget 拉一次 4 字段快照,
    // 与新 SSE 连接建立并行, 降低首屏可见状态延迟。
    // 详见 docs/superpowers/specs/2026-07-23-session-cold-state-design.md §5.2。
    void get().hydrateSessionState(sessionId)
  },

  /**
   * Cold-start 快照补全 — 拉一次 /api/agent/sessions/:id/state, 把 4 字段
   * 快照写入 per-session maps (cwdBySession / v2TasksBySession /
   * bashTasksBySession / agentTasksBySession)。
   *
   * 设计:
   * - 整端点失败 → 静默 (fetch 4xx/5xx 或 JSON parse 异常都吞)。
   * - 字段独立覆盖: cwd 只在 store 缺失时写入 (避免被 stale 覆盖);
   *   数组字段类型不对就跳过该字段。
   * - SSE 仍是 source of truth — 后续 state.* 事件通过 reducer 自然覆盖。
   *
   * 详见 docs/superpowers/specs/2026-07-23-session-cold-state-design.md §3.2。
   */
  hydrateSessionState: async (sid: string) => {
    const headers: HeadersInit = (() => {
      const token =
        (typeof localStorage !== 'undefined' && localStorage.getItem('zai-token')) || ''
      return token ? { 'X-Zai-Token': token } : {}
    })()
    let snap: {
      cwd?: { cwd: string; updatedAt: number } | null
      v2Tasks?: unknown
      bashTasks?: unknown
      agentTasks?: unknown
    }
    try {
      const res = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sid)}/state`,
        { headers },
      )
      if (!res.ok) return
      snap = await res.json()
    } catch {
      // 整端点失败 → 静默
      return
    }

    set((s) => {
      const next = { ...s }
      // cwd: 只在 store 还没有该 sid 条目时覆盖 (避免 stale 覆盖更新值)
      if (snap.cwd && !s.cwdBySession[sid]) {
        next.cwdBySession = { ...s.cwdBySession, [sid]: snap.cwd.cwd }
      }
      if (Array.isArray(snap.v2Tasks)) {
        next.v2TasksBySession = {
          ...s.v2TasksBySession,
          [sid]: snap.v2Tasks as never,
        }
      }
      if (Array.isArray(snap.bashTasks)) {
        next.bashTasksBySession = {
          ...s.bashTasksBySession,
          [sid]: snap.bashTasks as never,
        }
      }
      if (Array.isArray(snap.agentTasks)) {
        next.agentTasksBySession = {
          ...s.agentTasksBySession,
          [sid]: snap.agentTasks as never,
        }
      }
      return next
    })
  },
```

- [ ] **Step 4: Type-check the change**

Run: `cd packages/zai && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "useAgentStore" | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai-web): useAgentStore.hydrateSessionState with SSE and session-switch cold-start wiring and tests"
```

---

### Task 4: Wire `server.connected` → `hydrateSessionState`

**Files:**
- Modify: `packages/zai/src/web/src/store/useEventStream.ts`

**Interfaces:**
- Consumes: existing `dispatch` switch on `ServerEvent`
- Produces: `server.connected` case also calls `useAgentStore.getState().hydrateSessionState(sid)` where `sid = useAgentStore.getState().sessionId`

- [ ] **Step 1: Locate the `server.connected` case**

Run: `grep -n "server.connected" packages/zai/src/web/src/store/useEventStream.ts`
Expected: line ~60 in the `dispatch` switch.

- [ ] **Step 2: Modify the `server.connected` case**

Replace the existing case body:
```ts
    case 'server.connected':
      useAppStore.getState().setConnected(true)
      break
```

With:
```ts
    case 'server.connected':
      useAppStore.getState().setConnected(true)
      // ★ Cold-start 快照补全 — SSE per-sid slice 已注册, 此时拉 REST 不会漏事件。
      // 详见 docs/superpowers/specs/2026-07-23-session-cold-state-design.md §5.1。
      const _connectedSid = useAgentStore.getState().sessionId
      if (_connectedSid) void useAgentStore.getState().hydrateSessionState(_connectedSid)
      break
```

- [ ] **Step 3: Verify `useAgentStore` is imported in this file**

If not already imported (likely is), ensure the import line near the top reads:
```ts
import { useAgentStore } from './useAgentStore.js'
```

- [ ] **Step 4: Type-check the change**

Run: `cd packages/zai && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "useEventStream" | head -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useEventStream.ts
git commit --amend --no-edit
```

---

### Task 5: Client Unit Tests for `hydrateSessionState`

**Files:**
- Create: `packages/zai/src/web/src/store/useAgentStore.hydrateSessionState.test.ts`

**Interfaces:**
- Consumes: `useAgentStore`, `fetch` (mocked globally)
- Produces: 5 vitest test cases matching spec §7.2

- [ ] **Step 1: Check test patterns from existing client tests**

Read `packages/zai/src/web/src/store/useAgentStore.test.ts` (if exists) OR `packages/zai/src/web/src/lib/v2TaskApi.test.ts` to confirm `vi.mock('...', () => ...)` and `localStorage` stubbing pattern.

- [ ] **Step 2: Create `packages/zai/src/web/src/store/useAgentStore.hydrateSessionState.test.ts`**

Write:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// fetch mock
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { useAgentStore } from './useAgentStore.js'

function mockFetchResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response
}

describe('useAgentStore.hydrateSessionState', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    // reset store to clean state
    useAgentStore.setState({
      sessionId: 'sess-1',
      cwdBySession: {},
      v2TasksBySession: {},
      bashTasksBySession: {},
      agentTasksBySession: {},
    } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes all 4 fields when fetch returns complete snapshot', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/a/b', updatedAt: 1 },
        v2Tasks: [{ id: 'v1', subject: 'task' }],
        bashTasks: [{ taskId: 'b1', sessionId: 'sess-1', status: 'running' }],
        agentTasks: [{ id: 't1', status: 'completed' }],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBe('/a/b')
    expect(s.v2TasksBySession['sess-1']).toHaveLength(1)
    expect(s.bashTasksBySession['sess-1']).toHaveLength(1)
    expect(s.agentTasksBySession['sess-1']).toHaveLength(1)
  })

  it('skips v2Tasks when not an array, writes others', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/x', updatedAt: 1 },
        v2Tasks: 'not-an-array',
        bashTasks: [{ taskId: 'b1' }],
        agentTasks: [{ id: 't1' }],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBe('/x')
    expect(s.v2TasksBySession['sess-1']).toBeUndefined()
    expect(s.bashTasksBySession['sess-1']).toHaveLength(1)
    expect(s.agentTasksBySession['sess-1']).toHaveLength(1)
  })

  it('does NOT overwrite cwd if store already has it for this session', async () => {
    useAgentStore.setState({ cwdBySession: { 'sess-1': '/already/here' } } as never)
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/server/stale', updatedAt: 1 },
        v2Tasks: [],
        bashTasks: [],
        agentTasks: [],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    expect(useAgentStore.getState().cwdBySession['sess-1']).toBe('/already/here')
  })

  it('writes cwd when store is empty for this session', async () => {
    useAgentStore.setState({ cwdBySession: { 'other-sid': '/other' } } as never)
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        cwd: { cwd: '/fresh', updatedAt: 1 },
        v2Tasks: [],
        bashTasks: [],
        agentTasks: [],
      }),
    )
    await useAgentStore.getState().hydrateSessionState('sess-1')
    expect(useAgentStore.getState().cwdBySession['sess-1']).toBe('/fresh')
    expect(useAgentStore.getState().cwdBySession['other-sid']).toBe('/other')
  })

  it('returns silently on fetch 500', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({}, false))
    await useAgentStore.getState().hydrateSessionState('sess-1')
    const s = useAgentStore.getState()
    expect(s.cwdBySession['sess-1']).toBeUndefined()
    expect(s.v2TasksBySession['sess-1']).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run the test to verify all 5 pass**

Run: `cd packages/zai && npx vitest run src/web/src/store/useAgentStore.hydrateSessionState.test.ts`
Expected: 5 tests passed, 0 failed.

- [ ] **Step 4: If any fail, fix them and re-run before committing**

Common fix patterns:
- `setState` second arg — zustand v4 takes a partial; cast `as never` if TypeScript complains about extra fields
- `vi.stubGlobal` does not persist across tests — call it once at top-level (already done) OR in `beforeEach`
- `cwdBySession['sess-1']` is `undefined` instead of absent — adjust expected value if the store uses `null` instead

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.hydrateSessionState.test.ts
git commit --amend --no-edit
```

---

### Task 6: Final Verification

**Files:** none

- [ ] **Step 1: Run all new and adjacent tests**

Run:
```bash
cd packages/zai && npx vitest run \
  src/server/routes/sessionState.test.ts \
  src/web/src/store/useAgentStore.hydrateSessionState.test.ts \
  src/server/routes/agent.cwd.test.ts \
  src/web/src/hooks/useBackgroundTasks.test.ts
```
Expected: all 4 files pass.

- [ ] **Step 2: Full type-check**

Run: `cd packages/zai && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20`
Expected: no new errors (pre-existing OK).

- [ ] **Step 3: Lint**

Run: `cd packages/zai && npx eslint src/server/routes/sessionState.ts src/server/routes/sessionState.test.ts src/web/src/store/useAgentStore.ts src/web/src/store/useAgentStore.hydrateSessionState.test.ts src/web/src/store/useEventStream.ts src/server/index.ts 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 4: Confirm git history**

Run: `cd /Users/ethan/code/opencc-web && git log --oneline main..HEAD`
Expected: 2 commits on `feat/session-cold-state`: (1) feat(zai-server): add GET /api/agent/sessions/:id/state endpoint and tests for cold-start hydration, (2) feat(zai-web): useAgentStore.hydrateSessionState with SSE and session-switch cold-start wiring and tests

- [ ] **Step 5: Report completion**

Show the user: branch name, 2 commit subjects, test results.