# Bash REPL Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai `SplitPane` 增加 `Bash` Tab，承载 per-session 交互式 REPL：用户在 UI 敲 bash 命令 → 流式 stdout/stderr 输出 → 切换 session 隔离。

**Architecture:** 完全独立后端路径。Server 端新建 `ReplSession`（单 session child process 状态机）+ `ReplRegistry`（process-level singleton）+ 3 个 route（POST exec / GET SSE events / POST abort）。Web 端新建 `BashTab` 组件 + `useBashRepl` hook + `bashReplApi` fetch 包装，`SplitPane` 扩 `TabKey` 替换 `'tbd'` 占位。

**Tech Stack:** TypeScript / Node `child_process.spawn` / EventEmitter / Express 4 / zod / vitest + supertest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-24-zai-bash-repl-tab-design.md`

**Branch / Worktree:**
- 分支 `feat/bash-repl-tab` 基于当前 `main`
- worktree 路径：`/Users/ethan/code/opencc-web-feat-bash-repl-tab`
- **执行第一步前必须先用 `superpowers:using-git-worktrees` skill 创建 worktree**（或 `git worktree add ../opencc-web-feat-bash-repl-tab -b feat/bash-repl-tab main`）

## Global Constraints

- env 白名单（`PATH, HOME, USER, LANG, LC_*, TZ`），其它 key 全部剥掉 — 防止 API key / token 泄漏到子进程
- abort 升级时序：SIGTERM → 5s → SIGKILL
- SSE 不补发历史（仅内存，符合"最小范围"）
- 单 session 同时只有一个 child 在跑（`busy` 状态），否则 409
- spawn 同步失败（如 ENOENT）抛 `ReplSpawnError`，500；child 运行中 `'error'` 事件走 `kind:'error'` SSE 路径
- `TabKey` 由 `'git' | 'fs' | 'tbd'` 改为 `'git' | 'fs' | 'bash'`（删 `'tbd'`），`STORAGE_KEYS.tab` 默认 `'git'` 不变
- worktree 路径下执行 `pnpm install` 后再跑测试；`vitest` 命令前缀 `pnpm --filter @zn-ai/zai test`（zai 包测试）

---

## Task 1: shared ReplEvent / ExecResponse 类型

**Files:**
- Create: `packages/zai/src/shared/repl.ts`

**Interfaces:**
- Produces: `ReplEvent` union type（4 kind）、`ExecRequest`、`ExecResponse` union、`ExecResult` discriminated union（前端 hook 友好）

- [ ] **Step 1: 创建 shared 类型文件**

`packages/zai/src/shared/repl.ts`：
```ts
/**
 * Bash REPL 跨 server / web 共享类型。
 * Spec: docs/superpowers/specs/2026-07-24-zai-bash-repl-tab-design.md §3.3
 */

export type ReplEvent =
  | { kind: 'stdout'; execId: string; chunk: string; ts: number }
  | { kind: 'stderr'; execId: string; chunk: string; ts: number }
  | { kind: 'exit'; execId: string; code: number | null; signal: string | null; ts: number }
  | { kind: 'error'; execId: string; message: string; ts: number }

export interface ExecRequest {
  command: string
  cwd?: string
}

export type ExecResponse =
  | { ok: true; execId: string; startedAt: number }
  | { ok: false; busy: true; currentExecId: string }

/** useBashRepl hook 暴露给调用方的 exec 返回值。 */
export type ExecResult =
  | { ok: true; execId: string }
  | { ok: false; busy: true; currentExecId: string }
```

- [ ] **Step 2: 提交**

```bash
git add packages/zai/src/shared/repl.ts
git commit -m "feat(zai-shared): bash REPL shared types"
```

---

## Task 2: ReplSession 骨架 + 状态测试

**Files:**
- Create: `packages/zai/src/server/services/repl/ReplSession.ts`
- Create: `packages/zai/src/server/services/repl/__tests__/ReplSession.test.ts`

**Interfaces:**
- Produces: `ReplBusyError` / `ReplSpawnError` 类、`ReplSession` 类（构造函数 + `exec` / `abort` / `dispose` / `on('event', ...) emits ReplEvent` / getter `busy` / `cwd`）
- Consumes: `ReplEvent` 来自 `@shared/repl`

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/server/services/repl/__tests__/ReplSession.test.ts`：
```ts
import { describe, expect, it } from 'vitest'
import { ReplSession, ReplBusyError } from '../ReplSession.js'

describe('ReplSession — 初始化与状态', () => {
  it('新建实例 busy=false', () => {
    const s = new ReplSession('/tmp')
    expect(s.busy).toBe(false)
  })

  it('cwd 默认值', () => {
    const s = new ReplSession('/tmp')
    expect(s.cwd).toBe('/tmp')
  })

  it('有 child 在跑时 exec 抛 ReplBusyError', async () => {
    const s = new ReplSession(process.cwd())
    await s.exec('node -e "setTimeout(()=>{}, 60000)"')
    expect(s.busy).toBe(true)
    await expect(s.exec('echo second')).rejects.toBeInstanceOf(ReplBusyError)
    s.abort()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @zn-ai/zai test -- ReplSession.test.ts`
Expected: FAIL — `Cannot find module '../ReplSession.js'`

- [ ] **Step 3: 写最小实现**

`packages/zai/src/server/services/repl/ReplSession.ts`：
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ReplEvent } from '../../../shared/repl.js'

export class ReplBusyError extends Error {
  readonly currentExecId: string
  constructor(currentExecId: string) {
    super(`REPL busy: current execId=${currentExecId}`)
    this.name = 'ReplBusyError'
    this.currentExecId = currentExecId
  }
}

export class ReplSpawnError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super(`spawn failed: ${(cause as Error)?.message ?? String(cause)}`)
    this.name = 'ReplSpawnError'
    this.cause = cause
  }
}

// env 白名单：仅暴露进程无关的安全 key；防止父进程环境里的
// API key / token 等敏感信息泄漏到子 shell。
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TZ'])
for (const k of Object.keys(process.env)) {
  if (k.startsWith('LC_')) ENV_ALLOWLIST.add(k)
}

function filterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOWLIST.has(k)) env[k] = v
  }
  return env
}

export class ReplSession extends EventEmitter {
  private child: ChildProcess | null = null
  private currentExecId: string | null = null
  private killTimer: NodeJS.Timeout | null = null
  readonly cwd: string

  constructor(cwd: string) {
    super()
    this.cwd = cwd
  }

  get busy(): boolean {
    return this.child !== null
  }

  /**
   * 启动一次执行。已有 child 在跑时抛 ReplBusyError。
   * 同步 spawn 失败（ENOENT 等）抛 ReplSpawnError。
   */
  async exec(command: string, opts: { cwd?: string } = {}): Promise<{ execId: string; startedAt: number }> {
    if (this.child) {
      throw new ReplBusyError(this.currentExecId ?? 'unknown')
    }
    const execId = `e-${randomUUID().slice(0, 8)}`
    const startedAt = Date.now()
    const targetCwd = opts.cwd ?? this.cwd

    let child: ChildProcess
    try {
      child = spawn('sh', ['-c', command], { cwd: targetCwd, env: filterEnv() })
    } catch (err) {
      throw new ReplSpawnError(err)
    }

    this.child = child
    this.currentExecId = execId

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emit('event', { kind: 'stdout', execId, chunk: chunk.toString(), ts: Date.now() } satisfies ReplEvent)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('event', { kind: 'stderr', execId, chunk: chunk.toString(), ts: Date.now() } satisfies ReplEvent)
    })
    child.on('error', (err) => {
      this.emit('event', { kind: 'error', execId, message: err.message, ts: Date.now() } satisfies ReplEvent)
      this.finish(execId, null, null)
    })
    child.on('exit', (code, signal) => {
      this.finish(execId, code, signal)
    })

    return { execId, startedAt }
  }

  /**
   * SIGTERM 当前 child；5s 后升级 SIGKILL。无 child 时为 no-op。
   */
  abort(): void {
    const child = this.child
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = setTimeout(() => {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGKILL') } catch { /* */ }
      }
      this.killTimer = null
    }, 5_000)
  }

  /**
   * 杀 child、移除所有事件监听。幂等。
   */
  dispose(): void {
    if (this.child) {
      try { this.child.kill('SIGKILL') } catch { /* */ }
      this.child = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.currentExecId = null
    this.removeAllListeners()
  }

  private finish(execId: string, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child) {
      this.child = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    this.currentExecId = null
    this.emit('event', { kind: 'exit', execId, code, signal, ts: Date.now() } satisfies ReplEvent)
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @zn-ai/zai test -- ReplSession.test.ts`
Expected: 3 passed

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/repl/
git commit -m "feat(zai-server): ReplSession skeleton with spawn/abort/dispose"
```

---

## Task 3: ReplSession 完整 stdout/stderr/exit 信号测试

**Files:**
- Modify: `packages/zai/src/server/services/repl/__tests__/ReplSession.test.ts`

**Interfaces:**
- Consumes: `ReplSession.exec / .on('event', ...) / .abort / .dispose` (from Task 2)

- [ ] **Step 1: 追加测试**

在已有测试文件末尾追加（保留 Task 2 的 3 个测试）：
```ts
async function waitExit(s: ReplSession, execId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (!s.busy) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ReplSession — stdout / stderr / exit', () => {
  it('stdout chunk 触发 event', async () => {
    const s = new ReplSession(process.cwd())
    const events: string[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'stdout') events.push(ev.chunk) })

    const { execId } = await s.exec('echo hello-stdout')
    await waitExit(s, execId)
    expect(events.join('')).toContain('hello-stdout')
  })

  it('stderr chunk 触发 event，kind=stderr', async () => {
    const s = new ReplSession(process.cwd())
    let stderrMsg = ''
    s.on('event', (ev: any) => { if (ev.kind === 'stderr') stderrMsg += ev.chunk })

    const { execId } = await s.exec('echo hello-stderr >&2')
    await waitExit(s, execId)
    expect(stderrMsg).toContain('hello-stderr')
  })

  it('自然 exit 触发 kind=exit 且 code=0', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('true')
    await waitExit(s, execId)
    expect(exits.find((e) => e.execId === execId)?.code).toBe(0)
    expect(s.busy).toBe(false)
  })

  it('自然 exit 触发 kind=exit 且 code 非 0', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('sh -c "exit 7"')
    await waitExit(s, execId)
    expect(exits.find((e) => e.execId === execId)?.code).toBe(7)
  })

  it('abort 触发 SIGTERM exit event 含 signal', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('node -e "setTimeout(()=>{}, 60000)"')
    expect(s.busy).toBe(true)
    s.abort()
    await waitExit(s, execId)
    const exit = exits.find((e) => e.execId === execId)
    expect(exit?.signal).toBe('SIGTERM')
    expect(s.busy).toBe(false)
  })

  it('dispose 后 busy=false', () => {
    const s = new ReplSession('/tmp')
    s.dispose()
    expect(s.busy).toBe(false)
  })

  it('不存在的命令 → exec 抛 ReplSpawnError', async () => {
    const s = new ReplSession(process.cwd())
    await expect(s.exec('this-command-does-not-exist-xyz-12345')).rejects.toThrow(/spawn failed/)
  })
})
```

- [ ] **Step 2: 运行测试，确认通过**

Run: `pnpm --filter @zn-ai/zai test -- ReplSession.test.ts`
Expected: 10 passed（3 + 7）

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/server/services/repl/__tests__/ReplSession.test.ts
git commit -m "test(zai-server): cover ReplSession stdout/stderr/exit/abort/spawn"
```

---

## Task 4: ReplRegistry 懒加载

**Files:**
- Create: `packages/zai/src/server/services/repl/ReplRegistry.ts`
- Create: `packages/zai/src/server/services/repl/__tests__/ReplRegistry.test.ts`

**Interfaces:**
- Produces: `ReplRegistry` 类（`get(sessionId, defaultCwd)` / `dispose(sessionId)`）、`getReplRegistry()` 单例函数、`__resetReplRegistryForTest()` 测试 seam
- Consumes: `ReplSession`（from Task 2）

- [ ] **Step 1: 写失败测试**

`packages/zai/src/server/services/repl/__tests__/ReplRegistry.test.ts`：
```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { getReplRegistry, __resetReplRegistryForTest } from '../ReplRegistry.js'

describe('ReplRegistry', () => {
  beforeEach(() => __resetReplRegistryForTest())

  it('get 懒加载：首次调用创建实例', () => {
    const reg = getReplRegistry()
    const a = reg.get('sess-A', '/tmp')
    expect(a).toBeDefined()
    expect(a.cwd).toBe('/tmp')
  })

  it('同 sessionId 二次 get 返回相同实例', () => {
    const reg = getReplRegistry()
    const a1 = reg.get('sess-A', '/tmp')
    const a2 = reg.get('sess-A', '/tmp')
    expect(a1).toBe(a2)
  })

  it('不同 sessionId 互不干扰', () => {
    const reg = getReplRegistry()
    const a = reg.get('sess-A', '/tmp/A')
    const b = reg.get('sess-B', '/tmp/B')
    expect(a).not.toBe(b)
    expect(a.cwd).toBe('/tmp/A')
    expect(b.cwd).toBe('/tmp/B')
  })

  it('dispose 后再 get 创建新实例', () => {
    const reg = getReplRegistry()
    const a1 = reg.get('sess-A', '/tmp')
    reg.dispose('sess-A')
    const a2 = reg.get('sess-A', '/tmp')
    expect(a1).not.toBe(a2)
  })

  it('singleton: getReplRegistry 返回同一 registry', () => {
    const a = getReplRegistry()
    const b = getReplRegistry()
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @zn-ai/zai test -- ReplRegistry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

`packages/zai/src/server/services/repl/ReplRegistry.ts`：
```ts
import { ReplSession } from './ReplSession.js'

export class ReplRegistry {
  private readonly map = new Map<string, ReplSession>()

  /**
   * 懒加载：sessionId 已有则返回旧实例；否则用 defaultCwd 新建。
   * 重复 get 不影响已有 instance 的 cwd — 已存在的 child 仍跑在原 cwd。
   */
  get(sessionId: string, defaultCwd: string): ReplSession {
    const existing = this.map.get(sessionId)
    if (existing) return existing
    const created = new ReplSession(defaultCwd)
    this.map.set(sessionId, created)
    return created
  }

  dispose(sessionId: string): void {
    const s = this.map.get(sessionId)
    if (s) {
      s.dispose()
      this.map.delete(sessionId)
    }
  }
}

let _singleton: ReplRegistry | null = null

export function getReplRegistry(): ReplRegistry {
  if (!_singleton) _singleton = new ReplRegistry()
  return _singleton
}

/** 测试 seam：清空单例 + 释放所有 session。 */
export function __resetReplRegistryForTest(): void {
  if (_singleton) {
    for (const s of _singleton.map.values()) s.dispose()
  }
  _singleton = null
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @zn-ai/zai test -- ReplRegistry.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/repl/ReplRegistry.ts packages/zai/src/server/services/repl/__tests__/ReplRegistry.test.ts
git commit -m "feat(zai-server): ReplRegistry lazy singleton"
```

---

## Task 5: bashRepl route（exec + abort + SSE events）

**Files:**
- Create: `packages/zai/src/server/routes/bashRepl.ts`
- Create: `packages/zai/src/server/routes/bashRepl.test.ts`
- Modify: `packages/zai/src/server/index.ts`（挂载新 router）

**Interfaces:**
- Consumes: `getReplRegistry()` (from Task 4)、`createSseStream(res)` (`./stream.ts`)、`ExecRequest` (`@shared/repl`)
- Produces: default router with `POST /bash/repl/:sessionId/exec`、`GET /bash/repl/:sessionId/events`、`POST /bash/repl/:sessionId/abort`

- [ ] **Step 1: 写失败测试**

`packages/zai/src/server/routes/bashRepl.test.ts`：
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import bashReplRouter from './bashRepl.js'
import { __resetReplRegistryForTest } from '../services/repl/ReplRegistry.js'

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'tmp' }
  app.use('/api', bashReplRouter)
  return app
}

describe('bashRepl routes — exec / abort', () => {
  let app: express.Express

  beforeEach(() => {
    __resetReplRegistryForTest()
    app = makeApp()
  })

  afterEach(() => __resetReplRegistryForTest())

  it('POST exec 启动 child，返回 200 + execId', async () => {
    const res = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'echo hello-repl' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.execId).toMatch(/^e-/)
    await new Promise((r) => setTimeout(r, 200))
  })

  it('POST exec 409 当 busy=true', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'node -e "setTimeout(()=>{}, 30000)"' })
    const res = await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'echo second' })
    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
    expect(res.body.busy).toBe(true)
    expect(res.body.currentExecId).toMatch(/^e-/)
  })

  it('POST abort 触发 child 退出', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'node -e "setTimeout(()=>{}, 30000)"' })
    const res = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('POST abort 409 当无 child 在跑', async () => {
    const res = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(res.status).toBe(409)
  })

  it('POST exec 500 当 spawn ENOENT', async () => {
    const res = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'this-command-does-not-exist-xyz-12345' })
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/spawn failed/)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @zn-ai/zai test -- bashRepl.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 route**

`packages/zai/src/server/routes/bashRepl.ts`：
```ts
import { Router, type IRouter } from 'express'
import { z } from 'zod'
import { getReplRegistry } from '../services/repl/ReplRegistry.js'
import { createSseStream } from './stream.js'
import type { ExecRequest } from '../../shared/repl.js'

const router: IRouter = Router()

const ExecSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
})

function defaultCwd(req: any): string {
  // instanceContext 来自 createApp — 通过 app.locals 注入。
  const ctx = req.app?.locals?.instanceContext
  return ctx?.cwd ?? process.cwd()
}

router.post('/bash/repl/:sessionId/exec', async (req, res) => {
  const parsed = ExecSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {command}' })
  }
  const { command, cwd } = parsed.data
  const sessionId = req.params.sessionId
  const reg = getReplRegistry()
  const session = reg.get(sessionId, cwd ?? defaultCwd(req))

  try {
    const { execId, startedAt } = await session.exec(command, cwd ? { cwd } : {})
    return res.json({ ok: true, execId, startedAt })
  } catch (err: any) {
    if (err?.name === 'ReplBusyError') {
      return res.status(409).json({ ok: false, busy: true, currentExecId: err.currentExecId })
    }
    if (err?.name === 'ReplSpawnError') {
      return res.status(500).json({ error: err.message })
    }
    return res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/bash/repl/:sessionId/events', (req, res) => {
  const sessionId = req.params.sessionId
  const reg = getReplRegistry()
  const session = reg.get(sessionId, defaultCwd(req))
  const stream = createSseStream(res)

  // 15s 心跳保活，防止代理 / 浏览器在静默期间断开 EventSource。
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`)
  }, 15_000)

  const handler = (ev: unknown) => {
    stream.send(ev as any)
  }
  session.on('event', handler)

  req.on('close', () => {
    clearInterval(heartbeat)
    session.off('event', handler)
    // 不调 stream.end() — res 已被 socket 关闭
  })
})

router.post('/bash/repl/:sessionId/abort', (req, res) => {
  const sessionId = req.params.sessionId
  const reg = getReplRegistry()
  const session = reg.get(sessionId, defaultCwd(req))
  if (!session.busy) {
    return res.status(409).json({ error: 'no command running' })
  }
  session.abort()
  return res.json({ ok: true })
})

export default router
```

修改 `packages/zai/src/server/index.ts`：
1. 顶部 import 区（在 `import bashTasksRouter from './routes/bashTasks.js';` 之后）添加：
   ```ts
   import bashReplRouter from './routes/bashRepl.js';
   ```
2. router 挂载区（在 `app.use('/api', bashTasksRouter);` 之后）添加：
   ```ts
   app.use('/api', bashReplRouter);
   ```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @zn-ai/zai test -- bashRepl.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/bashRepl.ts packages/zai/src/server/routes/bashRepl.test.ts packages/zai/src/server/index.ts
git commit -m "feat(zai-server): bash repl routes (exec / SSE events / abort)"
```

---

## Task 6: bashReplApi 客户端 fetch 包装

**Files:**
- Create: `packages/zai/src/web/src/lib/bashReplApi.ts`

**Interfaces:**
- Produces: `execRepl(sessionId, body): Promise<ExecResult>`、`abortRepl(sessionId): Promise<void>`、`replEventsUrl(sessionId): string`
- Consumes: `ExecRequest` / `ExecResult` (`@shared/repl`)

- [ ] **Step 1: 创建文件**

`packages/zai/src/web/src/lib/bashReplApi.ts`：
```ts
import type { ExecRequest, ExecResult } from '../../../shared/repl.js'

/**
 * ExecResponse 200 / 409 解码为 hook 友好的 ExecResult。
 * 500 抛 Error（abort / fetch 失败亦然）。
 */
export async function execRepl(sessionId: string, body: ExecRequest): Promise<ExecResult> {
  const res = await fetch(`/api/bash/repl/${encodeURIComponent(sessionId)}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 200) {
    const json = await res.json()
    if (json.ok) return { ok: true, execId: json.execId }
    return json
  }
  if (res.status === 409) {
    const json = await res.json()
    return { ok: false, busy: true, currentExecId: json.currentExecId }
  }
  const text = await res.text().catch(() => '')
  throw new Error(`exec failed: ${res.status} ${text}`)
}

export async function abortRepl(sessionId: string): Promise<void> {
  const res = await fetch(`/api/bash/repl/${encodeURIComponent(sessionId)}/abort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '')
    throw new Error(`abort failed: ${res.status} ${text}`)
  }
}

/** SSE URL — 浏览器 EventSource 用 */
export function replEventsUrl(sessionId: string): string {
  return `/api/bash/repl/${encodeURIComponent(sessionId)}/events`
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/zai/src/web/src/lib/bashReplApi.ts
git commit -m "feat(zai-web): bash repl client fetch wrappers"
```

---

## Task 7: useBashRepl hook + 测试

**Files:**
- Create: `packages/zai/src/web/src/hooks/useBashRepl.ts`
- Create: `packages/zai/src/web/src/hooks/useBashRepl.test.ts`

**Interfaces:**
- Produces: `useBashRepl(sessionId, defaultCwd): { events: ReplEvent[]; busy: boolean; currentExecId: string | null; connected: boolean; exec(cmd): Promise<ExecResult>; abort(): Promise<void>; clear(): void }`
- Consumes: `execRepl` / `abortRepl` / `replEventsUrl` (Task 6)、`ReplEvent` / `ExecResult` (`@shared/repl`)

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/src/hooks/useBashRepl.test.ts`：
```ts
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplEvent } from '../../shared/repl.js'

// Mock EventSource — 测试环境无原生 EventSource
class MockEventSource {
  url: string
  readyState = 0
  onopen: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  closed = false
  static instances: MockEventSource[] = []
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() { this.closed = true; this.readyState = 2 }
  emit(ev: ReplEvent) { this.onmessage?.({ data: JSON.stringify(ev) }) }
  emitOpen() { this.readyState = 1; this.onopen?.({}) }
  emitError() { this.onerror?.({}) }
}
;(globalThis as any).EventSource = MockEventSource

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

import { useBashRepl } from './useBashRepl.js'

describe('useBashRepl', () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0
    fetchMock.mockReset()
  })

  it('mount 时建立 EventSource', () => {
    renderHook(() => useBashRepl('sess-1', '/tmp'))
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0].url).toContain('/api/bash/repl/sess-1/events')
  })

  it('sessionId 变化关闭旧 EventSource、建新的', () => {
    const { rerender } = renderHook(({ sid }) => useBashRepl(sid, '/tmp'), {
      initialProps: { sid: 'sess-1' },
    })
    expect(MockEventSource.instances.length).toBe(1)
    rerender({ sid: 'sess-2' })
    expect(MockEventSource.instances[0].closed).toBe(true)
    expect(MockEventSource.instances.length).toBe(2)
    expect(MockEventSource.instances[1].url).toContain('sess-2')
  })

  it('SSE message 推入 events 数组', () => {
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    const es = MockEventSource.instances[0]
    act(() => { es.emit({ kind: 'stdout', execId: 'e-1', chunk: 'hello', ts: 1 }) })
    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].kind).toBe('stdout')
  })

  it('exit event 设置 busy=false', () => {
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    act(() => {
      const es = MockEventSource.instances[0]
      es.emit({ kind: 'exit', execId: 'e-1', code: 0, signal: null, ts: 1 })
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.currentExecId).toBe(null)
  })

  it('onopen 设置 connected=true', () => {
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    act(() => { MockEventSource.instances[0].emitOpen() })
    expect(result.current.connected).toBe(true)
  })

  it('unmount 时关闭 EventSource', () => {
    const { unmount } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    expect(MockEventSource.instances.length).toBe(1)
    unmount()
    expect(MockEventSource.instances[0].closed).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @zn-ai/zai test -- useBashRepl.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 hook**

`packages/zai/src/web/src/hooks/useBashRepl.ts`：
```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReplEvent, ExecRequest, ExecResult } from '../../../shared/repl.js'
import { execRepl, abortRepl, replEventsUrl } from '../lib/bashReplApi.js'

export interface UseBashReplResult {
  events: ReplEvent[]
  busy: boolean
  currentExecId: string | null
  connected: boolean
  exec: (command: string) => Promise<ExecResult>
  abort: () => Promise<void>
  clear: () => void
}

export function useBashRepl(
  sessionId: string | null,
  defaultCwd: string | null,
): UseBashReplResult {
  const [events, setEvents] = useState<ReplEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [currentExecId, setCurrentExecId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const eventsRef = useRef<ReplEvent[]>([])
  const execIdRef = useRef<string | null>(null)

  // SSE 连接管理 — sessionId 变化关闭旧连接、建新的；events 清空。
  useEffect(() => {
    if (!sessionId) return
    const es = new EventSource(replEventsUrl(sessionId))
    setConnected(false)
    setEvents([])
    eventsRef.current = []
    execIdRef.current = null
    setBusy(false)
    setCurrentExecId(null)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as ReplEvent
        eventsRef.current = [...eventsRef.current, data]
        setEvents(eventsRef.current)
        if (data.kind === 'exit' || data.kind === 'error') {
          setBusy(false)
          setCurrentExecId(null)
          execIdRef.current = null
        }
      } catch {
        /* 忽略非 JSON 行（心跳注释等） */
      }
    }

    return () => {
      es.close()
    }
  }, [sessionId])

  const exec = useCallback(
    async (command: string): Promise<ExecResult> => {
      if (!sessionId) return { ok: false, busy: true, currentExecId: 'no-session' }
      const body: ExecRequest = { command, cwd: defaultCwd ?? undefined }
      const result = await execRepl(sessionId, body)
      if (result.ok) {
        setBusy(true)
        setCurrentExecId(result.execId)
        execIdRef.current = result.execId
      }
      return result
    },
    [sessionId, defaultCwd],
  )

  const abort = useCallback(async () => {
    if (!sessionId) return
    await abortRepl(sessionId)
  }, [sessionId])

  const clear = useCallback(() => {
    setEvents([])
    eventsRef.current = []
  }, [])

  return { events, busy, currentExecId, connected, exec, abort, clear }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @zn-ai/zai test -- useBashRepl.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/hooks/useBashRepl.ts packages/zai/src/web/src/hooks/useBashRepl.test.ts
git commit -m "feat(zai-web): useBashRepl hook with EventSource lifecycle"
```

---

## Task 8: BashTab 组件 + 渲染测试

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/BashTab.tsx`
- Create: `packages/zai/src/web/src/components/splitPane/BashTab.test.tsx`

**Interfaces:**
- Produces: `BashTab({ sessionId, cwd })` 组件 — header + 流式输出区 + 输入框 + abort 按钮
- Consumes: `useBashRepl(sessionId, cwd)` (Task 7)、`ReplEvent` (`@shared/repl`)、antd `Input` / `Button`

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/src/components/splitPane/BashTab.test.tsx`：
```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplEvent } from '../../../shared/repl.js'

class MockEventSource {
  url: string
  readyState = 0
  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  closed = false
  static instances: MockEventSource[] = []
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    setTimeout(() => { this.onopen?.({}); this.readyState = 1 }, 0)
  }
  close() { this.closed = true; this.readyState = 2 }
  emit(ev: ReplEvent) { this.onmessage?.({ data: JSON.stringify(ev) }) }
}
;(globalThis as any).EventSource = MockEventSource

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

import { BashTab } from './BashTab.js'

describe('BashTab', () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0
    fetchMock.mockReset()
  })

  it('输入框显示 cwd 路径', () => {
    render(<BashTab sessionId="sess-1" cwd="/foo/bar" />)
    expect(screen.getByText('/foo/bar')).toBeDefined()
  })

  it('Enter 触发 exec', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, execId: 'e-1' }) })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    const input = screen.getByPlaceholderText(/输入/)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'echo hi' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/bash/repl/sess-1/exec')
    expect(JSON.parse(init.body)).toEqual({ command: 'echo hi', cwd: '/foo' })
  })

  it('SSE stdout 渲染到 output area', async () => {
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
      const es = MockEventSource.instances[0]
      es.emit({ kind: 'stdout', execId: 'e-1', chunk: 'rendered-output', ts: 1 })
    })
    expect(screen.getByText('rendered-output')).toBeDefined()
  })

  it('SSE exit 事件显示分隔行', async () => {
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
      const es = MockEventSource.instances[0]
      es.emit({ kind: 'exit', execId: 'e-1', code: 0, signal: null, ts: 1 })
    })
    expect(screen.getByText(/exit 0/)).toBeDefined()
  })

  it('abort 按钮：busy=false 时不渲染，busy=true 时渲染', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, execId: 'e-1' }) })
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true }) })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })

    expect(screen.queryByText(/^终止$/)).toBeNull()

    const input = screen.getByPlaceholderText(/输入/)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'sleep 100' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })

    await waitFor(() => expect(screen.queryByText(/^终止$/)).not.toBeNull())

    await act(async () => {
      fireEvent.click(screen.getByText(/^终止$/))
    })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c: any) => c[0].includes('/abort'))).toBe(true)
    })
  })

  it('busy=true 时输入框禁用', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, execId: 'e-1' }) })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })

    const input = screen.getByPlaceholderText(/输入/) as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'sleep 100' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })
    await waitFor(() => expect(input.disabled).toBe(true))
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @zn-ai/zai test -- BashTab.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 BashTab**

`packages/zai/src/web/src/components/splitPane/BashTab.tsx`：
```tsx
import { useEffect, useRef, useState } from 'react'
import { Input, Button } from 'antd'
import { useBashRepl } from '../../hooks/useBashRepl.js'
import type { ReplEvent } from '../../../shared/repl.js'

interface BashTabProps {
  sessionId: string | null
  cwd: string | null
}

function fmtExitColor(ev: Extract<ReplEvent, { kind: 'exit' }>): string {
  if (ev.signal) return 'rgba(255,255,255,0.45)'
  if (ev.code === 0) return '#52c41a'
  return '#f59e0b'
}

function fmtExitLabel(ev: Extract<ReplEvent, { kind: 'exit' }>): string {
  if (ev.signal) return `── ${ev.signal} ──`
  return `── exit ${ev.code} ──`
}

export function BashTab({ sessionId, cwd }: BashTabProps) {
  const { events, busy, exec, abort } = useBashRepl(sessionId, cwd)
  const [input, setInput] = useState('')
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [events])

  async function handleSubmit() {
    const cmd = input.trim()
    if (!cmd || !sessionId) return
    setInput('')
    await exec(cmd)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 12,
          color: 'rgba(255,255,255,0.55)',
        }}
      >
        <span>
          Bash · <span data-testid="bash-cwd">{cwd ?? '(无 cwd)'}</span>
        </span>
        <span style={{ color: busy ? '#a78bfa' : '#52c41a' }}>
          {busy ? '● running' : '● idle'}
        </span>
      </div>

      <div
        ref={outputRef}
        data-testid="bash-output"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 12,
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'rgba(255,255,255,0.85)',
          background: '#0a0a0f',
        }}
      >
        {events.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.35)' }}>
            在下方输入 bash 命令，按 Enter 执行
          </div>
        )}
        {events.map((ev, i) => {
          if (ev.kind === 'stdout') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ whiteSpace: 'pre-wrap' }}>
                {ev.chunk}
              </div>
            )
          }
          if (ev.kind === 'stderr') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ whiteSpace: 'pre-wrap', color: '#ef4444' }}>
                {ev.chunk}
              </div>
            )
          }
          if (ev.kind === 'error') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ color: '#ef4444', fontWeight: 600 }}>
                ✗ {ev.message}
              </div>
            )
          }
          if (ev.kind === 'exit') {
            return (
              <div key={`${ev.execId}-${i}`} style={{ color: fmtExitColor(ev) }}>
                {fmtExitLabel(ev)}
              </div>
            )
          }
          return null
        })}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 8,
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Input
          placeholder="输入 bash 命令，按 Enter 执行（Shift+Enter 换行）"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (e.shiftKey) return
            e.preventDefault()
            void handleSubmit()
          }}
          data-testid="bash-input"
        />
        {busy && (
          <Button danger onClick={() => void abort()} data-testid="bash-abort">
            终止
          </Button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @zn-ai/zai test -- BashTab.test.tsx`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/splitPane/BashTab.tsx packages/zai/src/web/src/components/splitPane/BashTab.test.tsx
git commit -m "feat(zai-web): BashTab component with input/output/abort"
```

---

## Task 9: SplitPane 集成 BashTab（替换 `tbd`）

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/SplitPane.tsx`

**Interfaces:**
- Consumes: `BashTab` (Task 8)、`activeSessionId` (`useAgentStore`)
- Produces: 新的 `'bash'` TabKey、注册新 Tab

- [ ] **Step 1: 修改 SplitPane**

读 `packages/zai/src/web/src/components/splitPane/SplitPane.tsx`，找到 `TabKey` 类型定义（约 26 行）和 `items` 数组（约 122-126 行），按以下修改：

1. **`TabKey` 类型**：
   ```ts
   type TabKey = 'git' | 'fs' | 'bash'
   ```

2. **`items` 数组**：将 `{ key: 'tbd', label: '待定', children: <PlaceholderTab /> },` 替换为：
   ```tsx
   { key: 'bash', label: 'Bash', children: <BashTab sessionId={activeSessionId} cwd={cwd} /> },
   ```

3. **顶部 import 区**添加：
   ```ts
   import { BashTab } from './BashTab.js';
   import { useAgentStore } from '../../store/useAgentStore.js';
   ```

4. **`SplitPane` 函数体顶部**添加：
   ```ts
   const activeSessionId = useAgentStore((s) => s.activeSessionId ?? null)
   ```

> 备注：`PlaceholderTab` 的 import 可保留（删除与否取决于是否有其它引用，保守保留）。

- [ ] **Step 2: 验证 SplitPane 已有测试**

读 `packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx`，如有断言 `'待定'` label 的 case，更新为 `'Bash'`。

Run: `pnpm --filter @zn-ai/zai test -- SplitPane.test.tsx`
Expected: 现有用例继续过

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @zn-ai/zai run build` （或 `pnpm --filter @zn-ai/zai run typecheck`，根据 package.json 决定）
Expected: 0 错误

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/web/src/components/splitPane/SplitPane.tsx packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx
git commit -m "feat(zai-web): register BashTab in SplitPane, replace placeholder"
```

---

## Task 10: 端到端构建 + 启动验证

**Files:**
- 无新建文件；纯手动验证

- [ ] **Step 1: 全包构建**

Run: `pnpm install && pnpm --filter @zn-ai/zai run build`
Expected: 0 错误，dist 生成成功

- [ ] **Step 2: 全包测试**

Run: `pnpm --filter @zn-ai/zai test`
Expected: 所有测试通过（含 6 个新测试文件：ReplSession / ReplRegistry / bashRepl / useBashRepl / BashTab，以及任何受影响的现有测试）

- [ ] **Step 3: 启动 server（手测）**

Run: `pnpm --filter @zn-ai/zai run dev`
打开浏览器 → 选任意 session → 右侧 SplitPane → 点 `Bash` Tab

- [ ] **Step 4: 手测场景**

跑以下命令，验证输出与 abort 行为：
- `ls` → 应显示当前 cwd 内容
- `echo hello` → 应立即输出 hello + `── exit 0 ──`
- `pwd` → 应显示当前 cwd
- `sh -c "exit 7"` → `── exit 7 ──` 橙色
- `this-cmd-does-not-exist-xyz` → 红色 error 行
- `sleep 30` → 跑后点 abort → `── SIGTERM ──` 灰色
- 切 session → output 区应清空（仅内存）
- 刷新页面 → output 区应为空（仅内存）

每条通过则 ✓，失败则修。

---

## Task 11: 收尾 — 更新 CHANGELOG（如有）

**Files:**
- Modify: `packages/zai/CHANGELOG.md`（如果存在）

- [ ] **Step 1: 检查 CHANGELOG 是否存在**

Run: `ls packages/zai/CHANGELOG* 2>/dev/null || echo "no changelog"`
如果没有 CHANGELOG，跳过此 Task。

- [ ] **Step 2: 在顶部 Unreleased 段添加 Features**

```md
## Unreleased

### Features
- Bash REPL Tab: 在 SplitPane 新增 Bash Tab，用户可手动执行 bash 命令并查看流式 stdout/stderr 输出；每 session 独立 REPL，server 端仅内存、不持久化；新路由 `POST /api/bash/repl/:sessionId/exec`、`GET /api/bash/repl/:sessionId/events` (SSE)、`POST /api/bash/repl/:sessionId/abort`。
```

- [ ] **Step 3: 提交**

```bash
git add packages/zai/CHANGELOG.md
git commit -m "docs(zai): changelog entry for bash REPL tab"
```

---

## 自审（Self-Review Checklist）

执行 plan 时自检：

**Spec 覆盖**：
- [x] Spec §3.1 ReplSession → Task 2 + 3
- [x] Spec §3.2 ReplRegistry → Task 4
- [x] Spec §3.3 ReplEvent / ExecResponse → Task 1
- [x] Spec §3.4 Routes → Task 5
- [x] Spec §3.5 useBashRepl → Task 7
- [x] Spec §3.6 BashTab → Task 8
- [x] Spec §3.7 SplitPane 改动 → Task 9
- [x] Spec §5 Testing → Task 2/3/4/5/7/8 测试 + Task 10 E2E

**Type 一致性**：
- `ReplEvent` 在 Task 1 / 2 / 6 / 7 一致
- `ExecRequest` / `ExecResponse` / `ExecResult` 在 Task 1 / 5 / 6 / 7 一致
- `ReplBusyError` / `ReplSpawnError` 在 Task 2 / 5 一致（`err.name` 匹配）
- `__resetReplRegistryForTest` 在 Task 4 / 5 一致
- `execRepl` / `abortRepl` / `replEventsUrl` 在 Task 6 / 7 一致
- `BashTab({ sessionId, cwd })` 在 Task 8 / 9 一致
- `TabKey = 'git' | 'fs' | 'bash'` 在 Task 9 一致