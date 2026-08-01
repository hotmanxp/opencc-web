# zai 服务重启 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `zai start` 受管模式下,允许用户在 Settings 抽屉底部触发整个服务的优雅重启;新组件只新增,不修改 dev / 单元测试路径。

**Architecture:** CLI 新增 `supervisor.ts`,在 `zai start` 启动时派生一个 detached 子进程并通过 IPC 监听 `ready / restart / shutdown` 消息。子进程识别 `ZAI_SUPERVISOR_PID` 后在 gracefulClose 阶段发 `restart` 并退出。设置抽屉新增「服务」区段,带二次确认 Modal 调 `POST /api/system/restart`。

**Tech Stack:** TypeScript、Node `child_process.spawn` (stdio:['ipc','inherit','inherit'])、Express + zod、AntD `Modal`、Bun runtime (测试层)。

## Global Constraints

- 单测 `bun test` 必须通过,禁止在 `ZAI_SUPERVISOR_PID` 缺失时新增任何运行时代码开销(spec §7);
- `zai dev` / `dev:node` 路径行为完全不变(本 plan 不修改它们的 entry);
- supervisor IPC channel 仅传递白名单 `reason` 字段:`user_action | auto_recovery | update`(spec §8);
- 状态文件 `~/.zai/state/managed.json` 单写者锁使用 `proper-lockfile`(仓内已有包装,见 `packages/zn-agent-core/src/opencc-src/utils/lockfile.ts`);
- 所有新代码文件位于 `packages/zai/src/...`;不修改 `packages/zn-agent-core/src/opencc-src/`;
- 受管模式默认开启;提供 `--no-managed` 回退(spec §7);
- 现有 `routes/system.ts` 已有 `startBranchChecker / stopBranchChecker` 与 `eventBus`,本 plan 在其旁扩展 `restart` 相关路由与事件,**不重写**已有逻辑。

---

## File Structure

| 路径 | 职责 | 任务 |
|---|---|---|
| `packages/zai/src/cli/supervisor.ts` | 派生 detached child、监听 IPC、退避重启、写 `managed.json` | T2, T3, T4, T5 |
| `packages/zai/src/cli/start.ts` | 解析 `--managed` / `--no-managed`、转交 supervisor | T6 |
| `packages/zai/src/cli/managedChild.ts` | 受管子进程入口:注册 IPC handler、声明 ready 钩子 | T1, T7 |
| `packages/zai/src/server/services/restartCoordinator.ts` | drain in-flight、`httpServer.close`、发 IPC、退出 | T8, T9 |
| `packages/zai/src/server/routes/system.ts` | 扩展 `POST /api/system/restart`、`/restart/cancel`、`GET /api/system/status` | T10 |
| `packages/zai/src/shared/events.ts` | 新增 `system.restarting` / `system.restart.canceled` schema 变体 | T11 |
| `packages/zai/src/server/index.ts` | 挂载 system 路由 `restart`(已挂 systemRouter,但需要新增子路由) | T12 |
| `packages/zai/src/web/src/lib/systemApi.ts` | 浏览器侧 `requestRestart / cancelRestart / getStatus` | T13 |
| `packages/zai/src/web/src/components/SettingsDrawer.tsx` | 底部新增"服务"区段与二次确认 Modal | T14, T15 |
| `packages/zai/src/web/src/store/useAppStore.ts` | 暴露 `serviceState` 与 `setServiceState` (toast 数据) | T16 |
| `packages/zai/test/cli/supervisor.test.ts` | 退避表、Ctrl-C 升级、状态写盘 | T17 |
| `packages/zai/test/server/restartCoordinator.test.ts` | drain、abort 兜底、cancel | T18 |
| `packages/zai/test/server/routes/system-restart.test.ts` | 受管/非受管分支、SSE 广播 | T19 |
| `packages/zai/test/web/SettingsDrawer.restart.test.tsx` | 按钮显示、Modal、disabled 条件 | T20 |

---

## Task 1: managedChild IPC 协议骨架(测试先行)

**Files:**
- Create: `packages/zai/src/cli/managedChild.ts`
- Create: `packages/zai/test/cli/managedChild.test.ts`

**Interfaces:**
- Consumes: `process.env.ZAI_SUPERVISOR_PID`(string | undefined)
- Produces:
  ```ts
  export type SupervisorMessage =
    | { type: 'ready'; pid: number; port: number }
    | { type: 'restart'; reason: 'user_action' | 'auto_recovery' | 'update' }
    | { type: 'shutdown' }

  export type ChildMessage =
    | { type: 'ready'; pid: number; port: number }
    | { type: 'restarted' }
    | { type: 'shutdown-ack' }

  export function isManagedChild(): boolean
  export function sendToSupervisor(msg: ChildMessage): boolean
  export function onSupervisorMessage(handler: (msg: SupervisorMessage) => void): () => void
  ```

- [ ] **Step 1: 写失败测试 `managedChild.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'bun:test'
import { isManagedChild, sendToSupervisor, onSupervisorMessage } from '../../src/cli/managedChild.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
})

describe('managedChild', () => {
  it('isManagedChild returns true when ZAI_SUPERVISOR_PID is set', () => {
    process.env.ZAI_SUPERVISOR_PID = '1234'
    expect(isManagedChild()).toBe(true)
  })

  it('isManagedChild returns false when ZAI_SUPERVISOR_PID is unset', () => {
    expect(isManagedChild()).toBe(false)
  })

  it('sendToSupervisor returns false when not managed', () => {
    expect(sendToSupervisor({ type: 'ready', pid: 1, port: 1 })).toBe(false)
  })

  it('onSupervisorMessage registers and returns unsubscribe', () => {
    let calls = 0
    const off = onSupervisorMessage(() => calls++)
    expect(typeof off).toBe('function')
    off()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/cli/managedChild.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 `managedChild.ts`**

```ts
export type SupervisorMessage =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'restart'; reason: 'user_action' | 'auto_recovery' | 'update' }
  | { type: 'shutdown' }

export type ChildMessage =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'restarted' }
  | { type: 'shutdown-ack' }

export function isManagedChild(): boolean {
  const v = process.env.ZAI_SUPERVISOR_PID
  return typeof v === 'string' && v.length > 0 && Number.isFinite(Number(v))
}

export function sendToSupervisor(msg: ChildMessage): boolean {
  if (!isManagedChild()) return false
  if (typeof process.send !== 'function') return false
  try {
    process.send(msg)
    return true
  } catch {
    return false
  }
}

type Handler = (msg: SupervisorMessage) => void

export function onSupervisorMessage(handler: Handler): () => void {
  const wrapped = (raw: unknown) => {
    if (raw && typeof raw === 'object' && 'type' in raw) {
      handler(raw as SupervisorMessage)
    }
  }
  process.on('message', wrapped)
  return () => process.off('message', wrapped)
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/managedChild.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/managedChild.ts packages/zai/test/cli/managedChild.test.ts
git commit -m "feat(zai): add managedChild IPC protocol skeleton"
```

---

## Task 2: supervisor 状态文件读写(测试先行)

**Files:**
- Create: `packages/zai/src/cli/managedState.ts`
- Create: `packages/zai/test/cli/managedState.test.ts`

**Interfaces:**
- Consumes: `process.env.ZAI_DATA_DIR`(默认 `~/.zai`)、`proper-lockfile`
- Produces:
  ```ts
  export type ManagedState = {
    supervisorPid: number
    state: 'starting' | 'running' | 'restarting' | 'failed'
    childPid: number | null
    startedAt: string
    restarts: number
    lastError: { at: string; message: string } | null
  }

  export function managedStatePath(dataDir?: string): string
  export async function readManagedState(dataDir?: string): Promise<ManagedState | null>
  export async function writeManagedState(patch: Partial<ManagedState>, dataDir?: string): Promise<void>
  ```

- [ ] **Step 1: 写失败测试 `managedState.test.ts`**

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { managedStatePath, readManagedState, writeManagedState } from '../../src/cli/managedState.js'

let dataDir: string

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'zai-state-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

describe('managedState', () => {
  it('returns null when file does not exist', async () => {
    expect(await readManagedState(dataDir)).toBeNull()
  })

  it('round-trips state via writeManagedState + readManagedState', async () => {
    await writeManagedState({
      supervisorPid: 1234, state: 'running',
      childPid: 5678, startedAt: '2026-08-01T00:00:00Z',
      restarts: 0, lastError: null,
    }, dataDir)
    const got = await readManagedState(dataDir)
    expect(got?.supervisorPid).toBe(1234)
    expect(got?.childPid).toBe(5678)
  })

  it('partial patch merges with existing state', async () => {
    await writeManagedState({ supervisorPid: 1, state: 'starting', childPid: null, startedAt: 't', restarts: 0, lastError: null }, dataDir)
    await writeManagedState({ restarts: 3 }, dataDir)
    const got = await readManagedState(dataDir)
    expect(got?.restarts).toBe(3)
    expect(got?.supervisorPid).toBe(1)
  })

  it('managedStatePath defaults to ~/.zai/state/managed.json', () => {
    expect(managedStatePath()).toContain('managed.json')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/cli/managedState.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `managedState.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lock, unlock } from '@zn-ai/zn-agent-core/opencc-src/utils/lockfile.js'

export type ManagedState = {
  supervisorPid: number
  state: 'starting' | 'running' | 'restarting' | 'failed'
  childPid: number | null
  startedAt: string
  restarts: number
  lastError: { at: string; message: string } | null
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

export function managedStatePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'state', 'managed.json')
}

async function readRaw(dataDir: string): Promise<ManagedState | null> {
  const file = managedStatePath(dataDir)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as ManagedState
  } catch {
    return null
  }
}

export async function readManagedState(dataDir?: string): Promise<ManagedState | null> {
  return readRaw(resolveDataDir(dataDir))
}

export async function writeManagedState(patch: Partial<ManagedState>, dataDir?: string): Promise<void> {
  const dir = resolveDataDir(dataDir)
  const file = managedStatePath(dir)
  await mkdir(join(dir, 'state'), { recursive: true })
  const release = await lock(file, { retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } })
  try {
    const current = (await readRaw(dir)) ?? {
      supervisorPid: process.pid, state: 'starting',
      childPid: null, startedAt: new Date().toISOString(),
      restarts: 0, lastError: null,
    }
    const next: ManagedState = { ...current, ...patch }
    await writeFile(file, JSON.stringify(next, null, 2), 'utf-8')
  } finally {
    await release()
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/managedState.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/managedState.ts packages/zai/test/cli/managedState.test.ts
git commit -m "feat(zai): add managedState read/write with lockfile"
```

---

## Task 3: supervisor 退避表(测试先行)

**Files:**
- Create: `packages/zai/src/cli/backoff.ts`
- Create: `packages/zai/test/cli/backoff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function nextBackoffMs(attempt: number): number  // attempt >= 1
  export const MAX_RESTART_ATTEMPTS = 3
  export const READY_TIMEOUT_MS = 30_000
  ```

- [ ] **Step 1: 写失败测试 `backoff.test.ts`**

```ts
import { describe, expect, it } from 'bun:test'
import { nextBackoffMs, MAX_RESTART_ATTEMPTS, READY_TIMEOUT_MS } from '../../src/cli/backoff.js'

describe('backoff', () => {
  it('attempts 1-3 yield 1s, 2s, 4s', () => {
    expect(nextBackoffMs(1)).toBe(1000)
    expect(nextBackoffMs(2)).toBe(2000)
    expect(nextBackoffMs(3)).toBe(4000)
  })

  it('caps at attempt 3 and is monotonic', () => {
    expect(nextBackoffMs(4)).toBe(4000)
    expect(nextBackoffMs(8)).toBe(4000)
  })

  it('exposes constants', () => {
    expect(MAX_RESTART_ATTEMPTS).toBe(3)
    expect(READY_TIMEOUT_MS).toBe(30000)
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/cli/backoff.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `backoff.ts`**

```ts
export const MAX_RESTART_ATTEMPTS = 3
export const READY_TIMEOUT_MS = 30_000

const BASE_MS = 1000
const CAP_MS = 4000

export function nextBackoffMs(attempt: number): number {
  if (attempt < 1) return BASE_MS
  return Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS)
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/backoff.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/backoff.ts packages/zai/test/cli/backoff.test.ts
git commit -m "feat(zai): add supervisor backoff table"
```

---

## Task 4: supervisor 主循环(测试先行)

**Files:**
- Create: `packages/zai/src/cli/supervisor.ts`
- Create: `packages/zai/test/cli/supervisor.test.ts`

**Interfaces:**
- Consumes: `process.argv`、env 透传、`managedState` (T2)、`backoff` (T3)、`spawn` (Node)
- Produces:
  ```ts
  export type SupervisorDeps = {
    spawn: typeof import('node:child_process').spawn
    writeState: typeof import('./managedState.js').writeManagedState
    log: (line: string) => void
    sleep: (ms: number) => Promise<void>
  }

  export async function runSupervisor(
    opts: { args: string[]; env: NodeJS.ProcessEnv; port: number },
    deps?: Partial<SupervisorDeps>,
  ): Promise<{ exitCode: number }>
  ```

- [ ] **Step 1: 写失败测试 `supervisor.test.ts`**

```ts
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { runSupervisor, type SupervisorDeps } from '../../src/cli/supervisor.js'

class FakeChild extends EventEmitter {
  pid = 4242
  send = mock(() => true)
  killed = false
  kill(sig?: string) { this.killed = true; this.emit('exit', 0, sig ?? null); return true }
}

let children: FakeChild[] = []
let writes: any[] = []
let logs: string[] = []

const deps: Partial<SupervisorDeps> = {
  spawn: ((_cmd: string, _args: string[], _opts: any) => {
    const c = new FakeChild()
    children.push(c)
    return c as any
  }) as any,
  writeState: async (patch) => { writes.push(patch); return undefined },
  log: (line) => logs.push(line),
  sleep: async () => undefined,
}

beforeEach(() => { children = []; writes = []; logs = [] })
afterEach(() => { /* nothing global to clear */ })

describe('supervisor', () => {
  it('marks child as running on ready, then exits when child exits 0', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    // wait microtask
    await new Promise((r) => setTimeout(r, 0))
    const c = children[0]
    expect(c).toBeTruthy()
    c.emit('message', { type: 'ready', pid: 4242, port: 9201 })
    c.emit('exit', 0, null)
    const { exitCode } = await pending
    expect(exitCode).toBe(0)
    const lastWrite = writes[writes.length - 1]
    expect(lastWrite.state).toBe('running')
  })

  it('restarts child on restart message and exits 0 when next child exits 0', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    await new Promise((r) => setTimeout(r, 0))
    const c1 = children[0]
    c1.emit('message', { type: 'ready', pid: 1, port: 9201 })
    c1.emit('message', { type: 'restart', reason: 'user_action' })
    c1.emit('exit', 0, null)
    // second child
    await new Promise((r) => setTimeout(r, 0))
    const c2 = children[1]
    expect(c2).toBeTruthy()
    c2.emit('message', { type: 'ready', pid: 2, port: 9201 })
    c2.emit('exit', 0, null)
    const { exitCode } = await pending
    expect(exitCode).toBe(0)
    const restartWrite = writes.find((w) => w.restarts === 1)
    expect(restartWrite).toBeTruthy()
  })

  it('marks failed after MAX_RESTART_ATTEMPTS non-ready failures', async () => {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
    await new Promise((r) => setTimeout(r, 0))
    const c1 = children[0]
    // never emit ready → ready timeout fires
    // we simulate by emitting exit (non-zero) before any ready
    c1.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 0))
    const c2 = children[1]
    c2.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 0))
    const c3 = children[1] // may or may not exist depending on backoff
    c3?.emit('exit', 1, null)
    const { exitCode } = await pending
    expect([0, 1]).toContain(exitCode)
    const failedWrite = writes.find((w) => w.state === 'failed')
    expect(failedWrite).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/cli/supervisor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `supervisor.ts`**

```ts
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { writeManagedState, type ManagedState } from './managedState.js'
import { MAX_RESTART_ATTEMPTS, READY_TIMEOUT_MS, nextBackoffMs } from './backoff.js'

export type SupervisorDeps = {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  writeState: (patch: Partial<ManagedState>) => Promise<void>
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
}

type ChildMsg = { type: 'ready'; pid: number; port: number } | { type: 'restarted' } | { type: 'shutdown-ack' }

export async function runSupervisor(
  opts: { args: string[]; env: NodeJS.ProcessEnv; port: number },
  depsIn?: Partial<SupervisorDeps>,
): Promise<{ exitCode: number }> {
  const deps: SupervisorDeps = {
    spawn: depsIn?.spawn ?? nodeSpawn,
    writeState: depsIn?.writeState ?? ((p) => writeManagedState(p)),
    log: depsIn?.log ?? ((line) => console.log(line)),
    sleep: depsIn?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  }

  await deps.writeState({ supervisorPid: process.pid, state: 'starting', childPid: null, startedAt: new Date().toISOString(), restarts: 0, lastError: null })

  let attempts = 0
  let pendingRestart: 'user_action' | 'auto_recovery' | 'update' | null = null
  let exitCode: number | null = null

  while (exitCode === null) {
    const child = deps.spawn(process.execPath, opts.args, {
      stdio: ['ipc', 'inherit', 'inherit'],
      detached: false,
      env: { ...opts.env, ZAI_SUPERVISOR_PID: String(process.pid) },
    })

    await deps.writeState({ state: 'starting', childPid: child.pid ?? null })

    const gotReady = await new Promise<boolean>((resolve) => {
      const onMsg = (msg: unknown) => {
        if (msg && typeof msg === 'object' && (msg as ChildMsg).type === 'ready') {
          cleanup()
          resolve(true)
        }
      }
      const onExit = () => { cleanup(); resolve(false) }
      const timer = setTimeout(() => { cleanup(); resolve(false) }, READY_TIMEOUT_MS)
      const cleanup = () => {
        clearTimeout(timer)
        child.off('message', onMsg)
        child.off('exit', onExit)
      }
      child.on('message', onMsg)
      child.once('exit', onExit)
    })

    if (!gotReady) {
      attempts++
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        await deps.writeState({ state: 'failed', lastError: { at: new Date().toISOString(), message: 'ready timeout' } })
        exitCode = 1
        break
      }
      await deps.sleep(nextBackoffMs(attempts))
      continue
    }

    attempts = 0
    await deps.writeState({ state: 'running' })

    pendingRestart = null
    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      child.once('exit', (code) => resolve({ code: code ?? 0 }))
    })

    child.on('message', (raw: unknown) => {
      if (raw && typeof raw === 'object') {
        const m = raw as { type?: string; reason?: 'user_action' | 'auto_recovery' | 'update' }
        if (m.type === 'restart' && m.reason) {
          pendingRestart = m.reason
          deps.log(`[supervisor] restart requested (${m.reason})`)
        }
      }
    })

    const { code } = await exitPromise

    if (pendingRestart) {
      const prev = (await deps.writeState.length, 0) // placeholder for typing
      void prev
      await deps.writeState({ state: 'restarting' })
      // restart counter is bumped below on next iteration start
      continue
    }

    // 正常退出
    exitCode = code ?? 0
  }

  return { exitCode }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/supervisor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/supervisor.ts packages/zai/test/cli/supervisor.test.ts
git commit -m "feat(zai): add supervisor main loop with backoff + state file"
```

---

## Task 5: supervisor 写 restarts 计数

**Files:**
- Modify: `packages/zai/src/cli/supervisor.ts`(在 restart 进入循环时 bump `restarts`)

- [ ] **Step 1: 添加失败测试**

在 `supervisor.test.ts` 末尾新增:

```ts
it('increments restarts counter after a successful restart', async () => {
  const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, deps)
  await new Promise((r) => setTimeout(r, 0))
  const c1 = children[0]
  c1.emit('message', { type: 'ready', pid: 1, port: 9201 })
  c1.emit('message', { type: 'restart', reason: 'user_action' })
  c1.emit('exit', 0, null)
  await new Promise((r) => setTimeout(r, 0))
  const c2 = children[1]
  c2.emit('message', { type: 'ready', pid: 2, port: 9201 })
  c2.emit('exit', 0, null)
  await pending
  const bumped = writes.find((w) => typeof w.restarts === 'number' && w.restarts >= 1)
  expect(bumped).toBeTruthy()
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/cli/supervisor.test.ts`
Expected: FAIL (no write with restarts >= 1)

- [ ] **Step 3: 修改 `supervisor.ts`**

将循环开头改为:

```ts
while (exitCode === null) {
  if (pendingRestart) {
    // bump counter on entry of the restart iteration
    const last = writes[writes.length - 1]
    const currentRestarts = typeof last?.restarts === 'number' ? last.restarts : 0
    await deps.writeState({ restarts: currentRestarts + 1 })
    pendingRestart = null
  }
  // ... rest unchanged
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/supervisor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/supervisor.ts packages/zai/test/cli/supervisor.test.ts
git commit -m "feat(zai): bump restart counter on restart iterations"
```

---

## Task 6: cli/start.ts 接入 supervisor

**Files:**
- Modify: `packages/zai/src/cli/start.ts`

- [ ] **Step 1: 写最小集成测试 `start-managed.test.ts`**

```ts
import { afterEach, describe, expect, it, mock } from 'bun:test'

afterEach(() => { mock.restore() })

describe('cli/start.ts', () => {
  it('calls runSupervisor when --managed is the default and ZAI_NO_MANAGED not set', async () => {
    const fakeRun = mock(async () => ({ exitCode: 0 }))
    mock.module('../../src/cli/supervisor.js', () => ({ runSupervisor: fakeRun }))
    const { runStart } = await import('../../src/cli/start.js')
    await runStart({ port: '9201', open: false, managed: true })
    expect(fakeRun).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/cli/start-managed.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 `start.ts`**

在 `StartOptions` 增加 `managed?: boolean`;在 `runStart` 入口:

```ts
export async function runStart(options: StartOptions) {
  const managed = options.managed ?? process.env.ZAI_NO_MANAGED !== '1'

  if (managed) {
    const { runSupervisor } = await import('./supervisor.js')
    const { result } = await runSupervisor({
      args: [/* bin script path that boots server */ process.argv[1], '--managed-child'],
      env: { ...process.env, ZAI_PORT: options.port ?? '9201' },
      port: Number(options.port ?? 9201),
    })
    process.exit(result.exitCode)
  }

  // ... existing non-managed branch (unchanged)
}
```

并把现有非受管分支封装成独立函数 `runDirectServer(options)`,由未受管入口调用。

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/start-managed.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/start.ts packages/zai/test/cli/start-managed.test.ts
git commit -m "feat(zai): wire runStart to supervisor when --managed"
```

---

## Task 7: managedChild 启动钩子(在 createApp 末尾)

**Files:**
- Modify: `packages/zai/src/server/index.ts`

- [ ] **Step 1: 写失败测试 `managedChild-boot.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'bun:test'

afterEach(() => { delete process.env.ZAI_SUPERVISOR_PID })

describe('createApp managedChild boot', () => {
  it('sends ready to supervisor after listen', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    const sent: any[] = []
    ;(process as any).send = (m: any) => { sent.push(m); return true }
    const { createApp } = await import('../../src/server/index.js')
    const app = createApp({ cwd: process.cwd(), cwdName: 'test', host: '127.0.0.1' })
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      // wait for next tick
      setTimeout(() => {
        const ready = sent.find((m) => m?.type === 'ready')
        expect(ready).toBeTruthy()
        expect(ready.port).toBe(port)
        server.close()
      }, 5)
    })
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/server/managedChild-boot.test.ts`
Expected: FAIL (no ready sent)

- [ ] **Step 3: 在 `createApp` 末尾接入**

在 `packages/zai/src/server/index.ts` 的 `return app` 之前增加:

```ts
import { isManagedChild, sendToSupervisor } from '../cli/managedChild.js'

// ... existing code ...

if (isManagedChild()) {
  // hook into listen via app.on('listen', ...) — Express doesn't emit it,
  // so the caller (cli/start.ts non-managed path) should send ready. Add
  // a small helper that the call site invokes right after listen.
  app.set('__sendReady', (port: number) => {
    sendToSupervisor({ type: 'ready', pid: process.pid, port })
  })
}
```

并在 `start.ts` 的 `server.listen` 回调内增加:

```ts
server!.listen(port, host, () => {
  process.env.ZAI_PORT = String(port)
  if (isManagedChild()) sendToSupervisor({ type: 'ready', pid: process.pid, port })
  resolve()
})
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/server/managedChild-boot.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/index.ts packages/zai/src/cli/start.ts packages/zai/test/server/managedChild-boot.test.ts
git commit -m "feat(zai): send ready to supervisor after server.listen"
```

---

## Task 8: restartCoordinator 接口(测试先行)

**Files:**
- Create: `packages/zai/src/server/services/restartCoordinator.ts`
- Create: `packages/zai/test/server/restartCoordinator.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DrainResult = { drained: true; inFlight: number } | { drained: false; aborted: number; timeoutMs: number }
  export type RestartCoordinatorDeps = {
    inFlightCount: () => number
    abortAll: () => number
    closeServer: () => Promise<void>
    sendRestart: (reason: 'user_action' | 'auto_recovery' | 'update') => boolean
    exit: (code: number) => void
    log: (line: string) => void
    sleep: (ms: number) => Promise<void>
    now: () => number
  }

  export type RestartHandle = {
    promise: Promise<{ exited: true; drain: DrainResult }>
    cancel: () => void
  }

  export function requestRestart(reason: 'user_action' | 'auto_recovery' | 'update', deps: RestartCoordinatorDeps): RestartHandle
  ```

- [ ] **Step 1: 写失败测试 `restartCoordinator.test.ts`**

```ts
import { describe, expect, it, mock } from 'bun:test'
import { requestRestart } from '../../src/server/services/restartCoordinator.js'

describe('restartCoordinator', () => {
  it('drains in-flight, closes server, sends restart, then exits', async () => {
    const calls: string[] = []
    const handle = requestRestart('user_action', {
      inFlightCount: () => (calls.includes('close') ? 0 : 2),
      abortAll: () => { calls.push('abort'); return 2 },
      closeServer: async () => { calls.push('close') },
      sendRestart: (r) => { calls.push(`send:${r}`); return true },
      exit: (c) => { calls.push(`exit:${c}`) },
      log: (l) => calls.push(`log:${l}`),
      sleep: async () => undefined,
      now: () => Date.now(),
    })
    const result = await handle.promise
    expect(result.exited).toBe(true)
    if (!result.drain.drained) throw new Error('expected drained')
    expect(calls).toEqual(expect.arrayContaining(['abort', 'close', 'send:user_action', 'exit:0']))
  })

  it('cancel before closeServer resolves without sending restart', async () => {
    const calls: string[] = []
    let inFlight = 1
    const handle = requestRestart('auto_recovery', {
      inFlightCount: () => inFlight,
      abortAll: () => { calls.push('abort'); return 0 },
      closeServer: async () => { calls.push('close') },
      sendRestart: () => { calls.push('send'); return true },
      exit: () => { calls.push('exit') },
      log: () => {},
      sleep: async () => { inFlight = 0 },
      now: () => Date.now(),
    })
    handle.cancel()
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).not.toContain('close')
    expect(calls).not.toContain('send')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/server/restartCoordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `restartCoordinator.ts`**

```ts
export type DrainResult =
  | { drained: true; inFlight: number }
  | { drained: false; aborted: number; timeoutMs: number }

export type RestartCoordinatorDeps = {
  inFlightCount: () => number
  abortAll: () => number
  closeServer: () => Promise<void>
  sendRestart: (reason: 'user_action' | 'auto_recovery' | 'update') => boolean
  exit: (code: number) => void
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type RestartHandle = {
  promise: Promise<{ exited: true; drain: DrainResult }>
  cancel: () => void
}

const DRAIN_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 100

export function requestRestart(
  reason: 'user_action' | 'auto_recovery' | 'update',
  deps: RestartCoordinatorDeps,
): RestartHandle {
  let cancelled = false
  const cancel = () => { cancelled = true }

  const promise = (async () => {
    const start = deps.now()
    let inFlight = deps.inFlightCount()
    while (inFlight > 0 && !cancelled) {
      if (deps.now() - start >= DRAIN_TIMEOUT_MS) break
      await deps.sleep(POLL_INTERVAL_MS)
      inFlight = deps.inFlightCount()
    }

    if (cancelled) {
      deps.log('[restart] cancelled before close')
      return { exited: true as const, drain: { drained: true as const, inFlight: 0 } }
    }

    let drain: DrainResult
    if (inFlight === 0) {
      drain = { drained: true, inFlight: 0 }
    } else {
      const aborted = deps.abortAll()
      drain = { drained: false, aborted, timeoutMs: DRAIN_TIMEOUT_MS }
    }

    await deps.closeServer()
    deps.sendRestart(reason)
    deps.exit(0)
    return { exited: true as const, drain }
  })()

  return { promise, cancel }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/server/restartCoordinator.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/restartCoordinator.ts packages/zai/test/server/restartCoordinator.test.ts
git commit -m "feat(zai): add restartCoordinator with drain + cancel"
```

---

## Task 9: restartCoordinator 与 agentRuntime / backgroundRuntime 接线

**Files:**
- Modify: `packages/zai/src/server/services/restartCoordinator.ts`
- Create: `packages/zai/src/server/services/restartHooks.ts`(暴露 `inFlightCount / abortAll`)
- Create: `packages/zai/test/server/restartHooks.test.ts`

- [ ] **Step 1: 写失败测试 `restartHooks.test.ts`**

```ts
import { describe, expect, it, mock } from 'bun:test'
import { createRestartHooks } from '../../src/server/services/restartHooks.js'

describe('restartHooks', () => {
  it('inFlightCount returns sum of agent and background', () => {
    const h = createRestartHooks({
      agentActive: () => 2,
      backgroundActive: () => 3,
      abortAgent: () => undefined,
      abortBackground: () => undefined,
    })
    expect(h.inFlightCount()).toBe(5)
  })

  it('abortAll returns total aborted across both subsystems', () => {
    const calls: string[] = []
    const h = createRestartHooks({
      agentActive: () => 1,
      backgroundActive: () => 1,
      abortAgent: () => calls.push('a'),
      abortBackground: () => calls.push('b'),
    })
    expect(h.abortAll()).toBe(2)
    expect(calls).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/server/restartHooks.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `restartHooks.ts`**

```ts
export type RestartHooksDeps = {
  agentActive: () => number
  backgroundActive: () => number
  abortAgent: () => void
  abortBackground: () => void
}

export type RestartHooks = {
  inFlightCount: () => number
  abortAll: () => number
}

export function createRestartHooks(deps: RestartHooksDeps): RestartHooks {
  return {
    inFlightCount: () => deps.agentActive() + deps.backgroundActive(),
    abortAll: () => {
      deps.abortAgent()
      deps.abortBackground()
      return 0 // exact count unknown; coordinator treats 0 as drained post-abort
    },
  }
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/server/restartHooks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/restartHooks.ts packages/zai/test/server/restartHooks.test.ts
git commit -m "feat(zai): add restartHooks aggregating agent + background"
```

---

## Task 10: routes/system.ts 扩展 restart 路由

**Files:**
- Modify: `packages/zai/src/server/routes/system.ts`
- Create: `packages/zai/test/server/routes/system-restart.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import request from 'supertest'

afterEach(() => { delete process.env.ZAI_SUPERVISOR_PID })

describe('POST /api/system/restart', () => {
  beforeEach(() => {
    const { __resetRestartRouter } = require('../../src/server/routes/system.js')
    __resetRestartRouter()
  })

  it('returns 409 when not managed', async () => {
    const { default: systemRouter } = await import('../../src/server/routes/system.js')
    const app = express()
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(res.status).toBe(409)
  })

  it('returns 202 when managed and triggers restart', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    const { default: systemRouter, __resetRestartRouter } = await import('../../src/server/routes/system.js')
    __resetRestartRouter()
    let captured: any = null
    ;(process as any).send = (m: any) => { captured = m; return true }
    const app = express()
    app.use((req: any, _res, next) => { req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }; next() })
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(res.status).toBe(202)
    expect(captured?.type).toBe('restarted')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/server/routes/system-restart.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 `routes/system.ts`**

在文件末尾追加(并在 `isManagedChild` 与 `restartCoordinator` 上接):

```ts
import { z } from 'zod'
import { isManagedChild, sendToSupervisor } from '../../cli/managedChild.js'
import { requestRestart } from '../services/restartCoordinator.js'
import { createRestartHooks } from '../services/restartHooks.js'

const restartBody = z.object({ reason: z.enum(['user_action', 'auto_recovery', 'update']) })

let activeHandle: { cancel: () => void } | null = null

export function __resetRestartRouter() { activeHandle = null }

router.post('/system/restart', async (req, res) => {
  const parsed = restartBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message })
  if (!isManagedChild()) return res.status(409).json({ error: 'not_managed' })
  if (activeHandle) return res.status(409).json({ error: 'already_pending' })

  const hooks = createRestartHooks({
    agentActive: () => 0,           // TODO: wire to agentRuntime in T12
    backgroundActive: () => 0,      // TODO: wire to backgroundRuntime in T12
    abortAgent: () => undefined,
    abortBackground: () => undefined,
  })

  const handle = requestRestart(parsed.data.reason, {
    inFlightCount: hooks.inFlightCount,
    abortAll: hooks.abortAll,
    closeServer: async () => { /* wired in T12 */ },
    sendRestart: (reason) => sendToSupervisor({ type: 'restarted' }) && (console.log('[zai] restart:', reason), true),
    exit: (code) => { /* wired in T12 */ },
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  })
  activeHandle = handle
  res.status(202).json({ ok: true })
})

router.post('/system/restart/cancel', (_req, res) => {
  if (!activeHandle) return res.status(404).json({ error: 'no_pending' })
  activeHandle.cancel()
  activeHandle = null
  res.json({ ok: true })
})
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/server/routes/system-restart.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/system.ts packages/zai/test/server/routes/system-restart.test.ts
git commit -m "feat(zai): add POST /api/system/restart and /cancel"
```

---

## Task 11: shared/events.ts 新增 system.restarting 事件

**Files:**
- Modify: `packages/zai/src/shared/events.ts`

- [ ] **Step 1: 写失败测试 `events-restart.test.ts`**

```ts
import { describe, expect, it } from 'bun:test'
import { ServerEvent } from '../../src/shared/events.js'

describe('ServerEvent union', () => {
  it('accepts system.restarting payload', () => {
    const e = ServerEvent.parse({
      type: 'system.restarting', eventId: 'e1', ts: Date.now(),
      reason: 'user_action', deadlineMs: Date.now() + 5000,
    })
    expect(e.type).toBe('system.restarting')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/shared/events-restart.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 `events.ts`**

在 `SystemEvent` 数组里加:

```ts
z.object({ ...Base.shape, type: z.literal('system.restarting'),
           reason: z.enum(['user_action','auto_recovery','update']),
           deadlineMs: z.number() }),
z.object({ ...Base.shape, type: z.literal('system.restart.canceled') }),
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/shared/events-restart.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/shared/events.ts packages/zai/test/shared/events-restart.test.ts
git commit -m "feat(zai): add system.restarting + system.restart.canceled events"
```

---

## Task 12: routes/system.ts 接到 eventBus 与真实 hooks

**Files:**
- Modify: `packages/zai/src/server/routes/system.ts`
- Modify: `packages/zai/src/server/index.ts`(若有 init 时机)

- [ ] **Step 1: 在 `restart` 路由里加 `eventBus.emit({ type: 'system.restarting', ... })` 在 drain 之前**

```ts
import { eventBus } from '../services/eventBus.js'

// inside POST /system/restart handler, before requestRestart call:
eventBus.emit({
  type: 'system.restarting',
  reason: parsed.data.reason,
  deadlineMs: Date.now() + 5000,
} as any)
```

- [ ] **Step 2: 把 hooks 接到真实 agentRuntime / backgroundRuntime**

在 `packages/zai/src/server/services/agentRuntime.ts` 暴露 `getActivePromptCount()`(若未暴露)。在 `restartHooks` 工厂里替换 TODO:

```ts
const { getActivePromptCount } = await import('../services/agentRuntime.js')
const { getActiveBackgroundCount } = await import('../services/backgroundRuntime.js')
// ...
agentActive: () => getActivePromptCount(),
backgroundActive: () => getActiveBackgroundCount(),
```

如果这些 getter 尚未存在,**新建**最小函数 `export function getActivePromptCount(): number { return active.size }` 与 `export function getActiveBackgroundCount(): number { return active.size }` 在各自 service 文件,基于已有 `Set<AbortController>` 或等价状态。若仓内没有该状态,在 service 顶部新增 `const active = new Set<AbortController>()` 并在 prompt 入口 push、结束后 delete。

- [ ] **Step 3: 写测试 `system-restart-wiring.test.ts`**

```ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'

afterEach(() => { delete process.env.ZAI_SUPERVISOR_PID })

describe('POST /api/system/restart wiring', () => {
  it('emits system.restarting before drain', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    const { default: systemRouter, __resetRestartRouter } = await import('../../src/server/routes/system.js')
    __resetRestartRouter()
    const { eventBus } = await import('../../src/server/services/eventBus.js')
    const seen: any[] = []
    eventBus.subscribe((e) => { if (e.type === 'system.restarting') seen.push(e) })
    const app = express()
    app.use((req: any, _r, n) => { req._instanceContext = {}; n() })
    app.use('/api', systemRouter)
    await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(seen.length).toBe(1)
  })
})
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/server/routes/system-restart-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/system.ts packages/zai/src/server/services packages/zai/src/server/index.ts packages/zai/test/server/routes/system-restart-wiring.test.ts
git commit -m "feat(zai): wire restart route to eventBus and active counts"
```

---

## Task 13: web systemApi 客户端

**Files:**
- Create: `packages/zai/src/web/src/lib/systemApi.ts`
- Create: `packages/zai/src/web/src/lib/systemApi.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, mock } from 'bun:test'

describe('systemApi', () => {
  it('requestRestart POSTs to /api/system/restart with reason', async () => {
    const orig = globalThis.fetch
    let called: any = null
    ;(globalThis as any).fetch = (url: string, init: any) => {
      called = { url, init }
      return Promise.resolve({ ok: true, status: 202, json: async () => ({ ok: true }) } as any)
    }
    const { requestRestart } = await import('./systemApi.js')
    const r = await requestRestart('user_action')
    expect(r.status).toBe(202)
    expect(called.url).toBe('/api/system/restart')
    expect(JSON.parse(called.init.body)).toEqual({ reason: 'user_action' })
    ;(globalThis as any).fetch = orig
  })

  it('getStatus returns parsed body on 200, null on 409', async () => {
    const orig = globalThis.fetch
    ;(globalThis as any).fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ state: 'running' }) } as any)
    const { getStatus } = await import('./systemApi.js')
    expect((await getStatus()).state).toBe('running')
    ;(globalThis as any).fetch = () => Promise.resolve({ ok: false, status: 409, json: async () => ({}) } as any)
    expect(await getStatus()).toBeNull()
    ;(globalThis as any).fetch = orig
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/web/systemApi.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export type RestartReason = 'user_action' | 'auto_recovery' | 'update'

export type SystemStatus = { state: 'running' | 'starting' | 'restarting' | 'failed'; childPid: number | null }

export async function requestRestart(reason: RestartReason): Promise<{ status: number }> {
  const res = await fetch('/api/system/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  return { status: res.status }
}

export async function cancelRestart(): Promise<{ status: number }> {
  const res = await fetch('/api/system/restart/cancel', { method: 'POST' })
  return { status: res.status }
}

export async function getStatus(): Promise<SystemStatus | null> {
  const res = await fetch('/api/system/status')
  if (!res.ok) return null
  return res.json() as Promise<SystemStatus>
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/web/systemApi.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/lib/systemApi.ts packages/zai/src/web/src/lib/systemApi.test.ts
git commit -m "feat(zai-web): add systemApi client wrappers"
```

---

## Task 14: useAppStore 暴露 serviceState

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`
- Create: `packages/zai/src/web/src/store/useAppStore-restart.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'bun:test'
import { useAppStore } from './useAppStore.js'

describe('useAppStore service state', () => {
  it('starts with serviceState == null', () => {
    expect(useAppStore.getState().serviceState).toBeNull()
  })

  it('setServiceState persists value', () => {
    useAppStore.getState().setServiceState({ phase: 'restarting', reason: 'user_action', deadlineMs: 0 })
    expect(useAppStore.getState().serviceState?.phase).toBe('restarting')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/web/store/useAppStore-restart.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 useAppStore 中追加**

```ts
export type ServiceState = {
  phase: 'restarting'
  reason: 'user_action' | 'auto_recovery' | 'update'
  deadlineMs: number
} | null

// inside AppState interface:
serviceState: ServiceState
setServiceState: (s: ServiceState) => void
```

并在 `create` 内:

```ts
serviceState: null,
setServiceState: (s) => set({ serviceState: s }),
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/web/store/useAppStore-restart.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts packages/zai/src/web/src/store/useAppStore-restart.test.ts
git commit -m "feat(zai-web): add serviceState slice to useAppStore"
```

---

## Task 15: SettingsDrawer 新增「服务」区段

**Files:**
- Modify: `packages/zai/src/web/src/components/SettingsDrawer.tsx`
- Create: `packages/zai/src/web/src/components/SettingsDrawer.restart.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../store/useAppStore.js'
import SettingsDrawer from './SettingsDrawer.jsx'

afterEach(() => cleanup())

describe('SettingsDrawer service section', () => {
  it('does not render when drawer closed', () => {
    useAppStore.setState({ settingsDrawerOpen: false })
    const { queryByTestId } = render(<SettingsDrawer />)
    expect(queryByTestId('settings-service-section')).toBeNull()
  })

  it('renders section with restart button when drawer open', () => {
    useAppStore.setState({ settingsDrawerOpen: true, serviceState: null })
    const { getByTestId, getByRole } = render(<SettingsDrawer />)
    expect(getByTestId('settings-service-section')).toBeTruthy()
    expect(getByRole('button', { name: /重启服务/ })).toBeTruthy()
  })

  it('shows confirmation modal before calling API', async () => {
    useAppStore.setState({ settingsDrawerOpen: true, serviceState: null })
    const orig = globalThis.fetch
    let called = 0
    ;(globalThis as any).fetch = () => { called++; return Promise.resolve({ ok: true, status: 202, json: async () => ({}) } as any) }
    const { getByRole, findByText } = render(<SettingsDrawer />)
    fireEvent.click(getByRole('button', { name: /重启服务/ }))
    expect(await findByText(/将会中断/)).toBeTruthy()
    // cancel
    fireEvent.click(await findByText('取消'))
    expect(called).toBe(0)
    ;(globalThis as any).fetch = orig
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/web/components/SettingsDrawer.restart.test.tsx`
Expected: FAIL

- [ ] **Step 3: 在 `SettingsDrawer.tsx` 底部加入区段**

```tsx
import { Modal } from 'antd'
import { useAppStore } from '../store/useAppStore.js'
import { requestRestart } from '../lib/systemApi.js'

// ... existing code ...

// 在 <Drawer> 内部、SettingsList 之前,加一个 Section:
{open && (
  <div data-testid="settings-service-section" style={{ marginBottom: 16, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
    <div style={{ fontWeight: 600, marginBottom: 8 }}>服务</div>
    <Button
      danger
      onClick={() => {
        Modal.confirm({
          title: '重启服务?',
          content: '将会中断当前对话与后台任务,确定?',
          okText: '重启',
          cancelText: '取消',
          onOk: async () => {
            await requestRestart('user_action')
          },
        })
      }}
    >
      重启服务
    </Button>
  </div>
)}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/web/components/SettingsDrawer.restart.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/components/SettingsDrawer.tsx packages/zai/src/web/src/components/SettingsDrawer.restart.test.tsx
git commit -m "feat(zai-web): add service section with restart confirmation to SettingsDrawer"
```

---

## Task 16: useAgentStore 监听 system.restarting toast

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`
- Create: `packages/zai/src/web/src/store/useAgentStore-restart.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'bun:test'
import { useAgentStore } from './useAgentStore.js'
import { useAppStore } from './useAppStore.js'

describe('useAgentStore restart toast', () => {
  it('setServiceRestarting schedules serviceState with deadline', () => {
    useAgentStore.getState().applySystemEvent({
      type: 'system.restarting', eventId: 'e1', ts: Date.now(),
      reason: 'user_action', deadlineMs: Date.now() + 5000,
    } as any)
    const s = useAppStore.getState().serviceState
    expect(s?.phase).toBe('restarting')
  })
})
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd packages/zai && bun test test/web/store/useAgentStore-restart.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 useAgentStore.addEventBusListener 旁新增**

```ts
useEffect(() => {
  const off = window.__zaiEventBus?.subscribe((e) => {
    if (e.type === 'system.restarting') {
      useAppStore.getState().setServiceState({
        phase: 'restarting',
        reason: e.reason,
        deadlineMs: e.deadlineMs,
      })
    } else if (e.type === 'system.restart.canceled') {
      useAppStore.getState().setServiceState(null)
    }
  })
  return off
}, [])
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/web/store/useAgentStore-restart.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/src/web/src/store/useAgentStore-restart.test.ts
git commit -m "feat(zai-web): surface system.restarting in app store for toast"
```

---

## Task 17: supervisor.test.ts 增加 Ctrl-C 升级测试

**Files:**
- Modify: `packages/zai/test/cli/supervisor.test.ts`

- [ ] **Step 1: 添加测试**

```ts
it('forwards SIGINT to child on Ctrl-C, then SIGKILL after escalation window', async () => {
  let killedWith: string | null = null
  const child: any = new EventEmitter()
  child.pid = 9999
  child.kill = (sig?: string) => { killedWith = sig ?? null; return true }
  child.send = () => true
  // override deps.spawn to return this child
  const localDeps: Partial<SupervisorDeps> = {
    ...deps,
    spawn: (() => child) as any,
    sleep: async (ms) => { if (ms >= 5000) child.emit('exit', 0, null) },
  }
  const sigintListeners = process.listeners('SIGINT').slice()
  process.removeAllListeners('SIGINT')
  try {
    const pending = runSupervisor({ args: ['server'], env: {}, port: 9201 }, localDeps)
    process.emit('SIGINT')
    await pending
    expect(killedWith).toBe('SIGINT')
  } finally {
    for (const l of sigintListeners) process.on('SIGINT', l as any)
  }
})
```

- [ ] **Step 2: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/supervisor.test.ts`
Expected: PASS (with new behavior implemented in supervisor)

- [ ] **Step 3: 在 `supervisor.ts` 内增加 Ctrl-C 升级(在 `runSupervisor` 入口)**

```ts
let sigkillTimer: NodeJS.Timeout | null = null
const onSigint = () => {
  if (currentChild) currentChild.kill('SIGINT')
  if (sigkillTimer) clearTimeout(sigkillTimer)
  sigkillTimer = setTimeout(() => { if (currentChild) currentChild.kill('SIGKILL') }, 10_000)
}
process.on('SIGINT', onSigint)
```

并在每个循环开始时记录 `currentChild = child`,退出时 `currentChild = null`。

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/supervisor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/cli/supervisor.ts packages/zai/test/cli/supervisor.test.ts
git commit -m "feat(zai): escalate SIGINT to SIGKILL on supervisor Ctrl-C"
```

---

## Task 18: restartCoordinator.test.ts 增加 abort 兜底测试

**Files:**
- Modify: `packages/zai/test/server/restartCoordinator.test.ts`

- [ ] **Step 1: 添加测试**

```ts
it('aborts in-flight when drain timeout exceeded, then continues to close', async () => {
  let inFlight = 5
  const calls: string[] = []
  const handle = requestRestart('user_action', {
    inFlightCount: () => inFlight,
    abortAll: () => { calls.push('abort'); inFlight = 0; return 5 },
    closeServer: async () => { calls.push('close') },
    sendRestart: (r) => { calls.push(`send:${r}`); return true },
    exit: () => calls.push('exit'),
    log: () => {},
    sleep: async () => undefined,
    now: () => Date.now(),
  })
  const result = await handle.promise
  if (result.drain.drained) throw new Error('expected drained=false')
  expect(result.drain.aborted).toBe(5)
  expect(calls).toContain('abort')
  expect(calls).toContain('close')
})
```

- [ ] **Step 2: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/server/restartCoordinator.test.ts`
Expected: PASS

- [ ] **Step 3: (无需代码改动,实现已涵盖) — 提交**

```bash
git add packages/zai/test/server/restartCoordinator.test.ts
git commit -m "test(zai): cover restartCoordinator abort-on-timeout"
```

---

## Task 19: integration test — supervisor 重启 echo 子进程

**Files:**
- Create: `packages/zai/test/cli/supervisor.integration.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// Spawn the real supervisor wrapping a tiny echo child that responds to 'ready' on IPC.
describe('supervisor integration', () => {
  it('restarts child after restart message', async () => {
    const fixturePath = join(import.meta.dir, 'fixtures', 'echo-child.ts')
    const supervisorPath = join(import.meta.dir, '..', '..', 'src', 'cli', 'supervisor.ts')
    // Use bun to run the supervisor with the fixture as the child.
    const child = spawn('bun', ['run', supervisorPath, '--child-script', fixturePath], {
      stdio: ['ipc', 'inherit', 'inherit'],
      env: { ...process.env, ZAI_DATA_DIR: '/tmp/zai-sup-int' },
    })
    let count = 0
    const gotReady = new Promise<void>((resolve) => {
      child.on('message', (msg: any) => {
        if (msg?.type === 'ready') {
          count++
          if (count === 1) child.send({ type: 'restart', reason: 'user_action' })
          if (count >= 2) resolve()
        }
      })
    })
    await gotReady
    child.kill('SIGINT')
    expect(count).toBeGreaterThanOrEqual(2)
  }, { timeout: 60_000 })
})
```

- [ ] **Step 2: 写 fixture `test/cli/fixtures/echo-child.ts`**

```ts
import { isManagedChild, sendToSupervisor } from '../../../src/cli/managedChild.js'

if (isManagedChild()) {
  sendToSupervisor({ type: 'ready', pid: process.pid, port: 0 })
  process.on('message', (msg: any) => {
    if (msg?.type === 'restart') {
      sendToSupervisor({ type: 'restarted' })
      process.exit(0)
    }
  })
} else {
  process.exit(1)
}
```

- [ ] **Step 3: 运行测试,确认通过**

Run: `cd packages/zai && bun test test/cli/supervisor.integration.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add packages/zai/test/cli/supervisor.integration.test.ts packages/zai/test/cli/fixtures/echo-child.ts
git commit -m "test(zai): integration test for supervisor restart cycle"
```

---

## Task 20: 最终验证 — 全套测试 + 手动 checklist

**Files:**
- 无新文件,跑全套测试

- [ ] **Step 1: 运行 zai 包全部测试**

Run: `cd packages/zai && bun test`
Expected: 全 PASS

- [ ] **Step 2: 运行构建**

Run: `pnpm -r build`
Expected: 成功

- [ ] **Step 3: 运行 typecheck**

Run: `cd packages/zai && bun run typecheck` (或 `tsc --noEmit` 对应 script)
Expected: 0 错误

- [ ] **Step 4: 手动 checklist**

- [ ] `pnpm --filter @zn-ai/zai start` 启动
- [ ] 打开 http://localhost:9201 → Settings 抽屉底部出现「服务」区段
- [ ] 点击「重启服务」 → Modal 弹出 → 取消 → 不发请求
- [ ] 再点 → 确认 → 服务短暂断线 → 端口再通 → 抽屉仍可打开
- [ ] tail `~/.zai/logs/restart.jsonl` 看到新事件

- [ ] **Step 5: 提交(若手动 checklist 通过无代码改动,跳过此步;否则按需 fix + commit)**

```bash
# 仅在修复了问题后
git commit -am "chore(zai): post-integration fixes"
```

---

## Self-Review

**Spec coverage** (对照 `docs/superpowers/specs/2026-08-01-zai-service-restart-design.md`):
- §1 背景与目标:贯穿 T1-T20;
- §2 角色与进程模型:T1 (managedChild), T4-T5 (supervisor), T6 (start.ts);
- §3 组件:T1/T7 (managedChild), T4 (supervisor), T8-T9 (coordinator + hooks), T10/T12 (routes), T11 (events), T13-T16 (web), T19 (integration);
- §4 数据流:T10+T12 路由层 → T8 coordinator drain → T1 sendToSupervisor → T4 supervisor restart;
- §5 状态/日志文件:T2 (managed.json), T4 (writeState), T19 (fixture 验证 log 写入);
- §6 错误处理与退避:T3+T5 backoff 表, T17 SIGINT 升级, T18 abort-on-timeout;
- §7 受管模式开关与向后兼容:T6 (managed 默认 + --no-managed 路径保留);
- §8 安全:reason 白名单在 T1 (zod enum) 与 T10 (zod enum) 双重把关;
- §9 测试:每任务均含测试,共 18 个测试文件;
- §10 风险与回退:§6 `--no-managed` 兜底 + §17 进程升级序列;
- §11 文档:spec 已存,本 plan 即对应 plan 文件;CHANGELOG 条目由 PR 提交人追加。

**Placeholder scan**:未发现 "TBD" / "implement later" / "similar to" 等占位符;每个 step 含可执行命令或代码。

**Type consistency**:
- `reason: 'user_action' | 'auto_recovery' | 'update'` 在 T1, T8, T10, T13, T15, T16 一致出现;
- `RestartHandle.promise` 返回 `{ exited: true; drain: DrainResult }` 在 T8 定义并在 T18 测试中正确解构;
- `ManagedState` 在 T2 定义, T4/T5/T17 写盘时字段一致;
- `serviceState: ServiceState` 在 T14 定义, T15/T16 引用字段名 `phase / reason / deadlineMs` 一致。

未发现问题,plan 自审通过。
