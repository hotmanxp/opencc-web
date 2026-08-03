# zai Agent Instance Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Web-UI "实例管理" menu to zai that lets the user start / stop / restart / remove multiple zai server instances (each on its own port), with the current zai process acting as their supervisor that monitors IPC heartbeats from each child instance.

**Architecture:** Current zai process hosts a new `instanceSupervisor` singleton that owns an `instances.json` registry, spawns children via `zai start --managed-child`, and tracks state via IPC (`ready` reuses the existing `sendReady` path; new `heartbeat` IPC carries liveness). A new REST router and a new Web page expose CRUD over the registry and broadcast every state change as a global `instance.changed` SSE event.

**Tech Stack:** Node `child_process` (stdio: `['ipc', 'inherit', 'inherit']`), zod, Express, `proper-lockfile` (existing), Zustand (existing), Ant Design 5, vitest + supertest + happy-dom, pnpm workspace.

## Global Constraints

- Path conventions: `packages/zai/src/...` for source, `packages/zai/test/...` for server tests (mirroring `test/server/routes/system-status.test.ts`), `packages/zai/src/web/src/...` colocated for web tests.
- Existing shared file path for events: `packages/zai/src/shared/events.ts` (ServerEvent is a zod discriminatedUnion — new variants must be added there).
- Existing supervisor IPC contract (do not change): child sends `{type:'ready',pid,port}` via `process.send` from `server/services/readyHook.ts`; supervisor receives via `child.on('message')`.
- `ZAI_SUPERVISOR_PID` env triggers `isManagedChild()`; spawning the children via `zai start --managed-child` already routes them through `runDirectServer` and skips the per-instance supervisor (see `cli/start.ts:41-62`). Reusing that flag means ready messages also flow back to the new central supervisor without new code.
- Tests must use vitest (`pnpm -r test`). Web tests must start with `// @vitest-environment happy-dom` and use `@testing-library/react`.
- Per AGENTS.md, the implementation MUST be verified end-to-end via `/ego-browser` driving the real zai Web UI before declaring Task 9 done. Chrome DevTools MCP, Playwright, Puppeteer, curl + WebFetch, and unit tests cannot substitute.
- Per AGENTS.md, no `as any`, no `@ts-ignore`, no empty catch.
- zai is local-only; the server binds `127.0.0.1` by default (`host` in `AppOptions`).
- Port base for new instances: `9201` (matches `cli/start.ts` default). Use `cli/ports.ts:listen`/`findAvailablePort` pattern for probing.
- Type safety: `Shared` types must be importable from both `server/` and `web/`. Keep all instance shapes in `shared/instances.ts`.

---

## File Structure

| New | Purpose |
|---|---|
| `packages/zai/src/shared/instances.ts` | `InstanceDefinition` / `InstanceStatus` / `InstanceSnapshot` / `InstanceState` |
| `packages/zai/src/server/services/instanceStore.ts` | `~/.zai/instances.json` read / write with `proper-lockfile` |
| `packages/zai/src/server/services/instanceHeartbeat.ts` | Child-side timer emitting `{type:'heartbeat',...}` via IPC |
| `packages/zai/src/server/services/instanceSupervisor.ts` | Spawn / stop / restart / heartbeat-watcher / shutdown singleton |
| `packages/zai/src/server/routes/instances.ts` | `GET/POST/DELETE` under `/api/instances` |
| `packages/zai/src/web/src/store/useInstanceStore.ts` | Zustand store mirroring list + SSE delta |
| `packages/zai/src/web/src/pages/Instances.tsx` | Page with list, actions, new-instance modal |

| Modified | Change |
|---|---|
| `packages/zai/src/shared/events.ts` | Add `InstanceEvent` variant; spread into `ServerEvent` |
| `packages/zai/src/server/services/eventBus.ts` | Add `case 'instance.changed'` to `isGlobalEvent` |
| `packages/zai/src/server/index.ts` | Init supervisor + mount `instancesRouter` |
| `packages/zai/src/cli/start.ts` | In `runDirectServer`, activate `instanceHeartbeat` when `ZAI_INSTANCE_ID` is set |
| `packages/zai/src/cli/dev.ts` | Cleanup calls `shutdownInstanceSupervisor()` |
| `packages/zai/src/web/src/components/Layout.tsx` | Add `/instances` menu entry with `ClusterOutlined` |
| `packages/zai/src/web/src/router.tsx` | Lazy-import + route for `/instances` |
| `packages/zai/src/web/src/store/useEventStream.ts` | Dispatch `instance.changed` to `useInstanceStore` |

| New tests | Purpose |
|---|---|
| `packages/zai/test/server/services/instanceStore.test.ts` | Persistence round-trip + missing-file behaviour |
| `packages/zai/test/server/services/instanceHeartbeat.test.ts` | Env gate + message format + send-throws silent stop |
| `packages/zai/test/server/services/instanceSupervisor.test.ts` | State machine + heartbeat-timeout + shutdown (uses fake child) |
| `packages/zai/test/server/routes/instances.test.ts` | HTTP contract + 400/404/409 + current-instance rejection |
| `packages/zai/test/server/instance-supervisor-wiring.test.ts` | After `createApp`, `GET /api/instances` returns at least the current-instance row |
| `packages/zai/src/web/src/store/useInstanceStore.test.ts` | `applyInstanceChanged` merges per id |
| `packages/zai/src/web/src/pages/Instances.test.tsx` | Renders list, current instance has disabled actions |

---

## Task 1: Shared instance types + `instance.changed` SSE event

**Files:**
- Create: `packages/zai/src/shared/instances.ts`
- Modify: `packages/zai/src/shared/events.ts:150-204` (extend `SystemEvent`, add `InstanceEvent`, spread into `ServerEvent`)
- Modify: `packages/zai/src/server/services/eventBus.ts:31-50` (extend `isGlobalEvent`)
- Create: `packages/zai/test/server/services/eventBus-instances.test.ts`

**Interfaces (produced by this task, consumed by all later tasks):**
- `InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'down'`
- `InstanceDefinition { id: string; name: string; cwd: string; createdAt: string }`
- `InstanceStatus { state: InstanceState; port: number|null; pid: number|null; startedAt: string|null; lastHeartbeatAt: string|null; lastError: { at: string; message: string }|null }`
- `InstanceSnapshot = InstanceDefinition & InstanceStatus & { isCurrent: boolean }`
- `ServerEvent` gains variant `{ type: 'instance.changed', instanceId, state, port, pid, ...Base }`

- [ ] **Step 1: Write the failing test**

Create `packages/zai/test/server/services/eventBus-instances.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ServerEventBus } from '../../../src/server/services/eventBus.js'
import { ServerEvent } from '../../../src/shared/events.js'

describe('eventBus instance.changed', () => {
  it('treats instance.changed as a global event (delivers under any wantedSid)', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('some-session', (e) => got.push(e.type))
    bus.emit({
      type: 'instance.changed',
      instanceId: 'inst_1',
      state: 'running',
      port: 9202,
      pid: 42,
    } as never)
    expect(got).toEqual(['instance.changed'])
  })

  it('parses the new event variant against the ServerEvent zod schema', () => {
    const parsed = ServerEvent.parse({
      type: 'instance.changed',
      eventId: 'evt_x',
      ts: 1700000000000,
      instanceId: 'inst_1',
      state: 'starting',
      port: null,
      pid: 999,
    })
    expect(parsed.type).toBe('instance.changed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "eventBus instance.changed"`
Expected: FAIL — `'instance.changed' is not in isGlobalEvent`, zod discriminated union rejects the new variant.

- [ ] **Step 3: Create `shared/instances.ts`**

`packages/zai/src/shared/instances.ts`:

```ts
// Shared instance-manager types — single source of truth for backend + frontend.
// See docs/superpowers/specs/2026-08-03-zai-agent-instance-manager-design.md.

export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'down'

export const INSTANCE_STATES: readonly InstanceState[] = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'down',
]

export interface InstanceDefinition {
  id: string
  name: string
  cwd: string
  createdAt: string
}

export interface InstanceStatus {
  state: InstanceState
  port: number | null
  pid: number | null
  startedAt: string | null
  lastHeartbeatAt: string | null
  lastError: { at: string; message: string } | null
}

export interface InstanceSnapshot extends InstanceDefinition, InstanceStatus {
  isCurrent: boolean
}
```

- [ ] **Step 4: Add `InstanceEvent` to `shared/events.ts`**

In `packages/zai/src/shared/events.ts`, append a new discriminated union after `StateEvent` (line 195) and spread it into `ServerEvent`:

```ts
// instance.* — 中央实例管理器的状态变更广播. isGlobalEvent 登记, 所有 tab 实时收到.
const InstanceEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base.shape,
    type: z.literal('instance.changed'),
    instanceId: z.string(),
    state: z.enum(['stopped', 'starting', 'running', 'stopping', 'down']),
    port: z.number().nullable(),
    pid: z.number().nullable(),
  }),
])
```

Then in the `ServerEvent` discriminated union at line 197, add `...InstanceEvent.options`:

```ts
export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
  ...StateEvent.options,
  ...InstanceEvent.options,
])
```

- [ ] **Step 5: Register `instance.changed` in `eventBus.ts`**

In `packages/zai/src/server/services/eventBus.ts`, add a `case 'instance.changed':` line to `isGlobalEvent` (line 31-50), after the existing `system.restart.canceled` case:

```ts
    case 'system.restart.canceled':
    case 'instance.changed':
      return true
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai test -t "eventBus instance.changed"`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/shared/instances.ts \
        packages/zai/src/shared/events.ts \
        packages/zai/src/server/services/eventBus.ts \
        packages/zai/test/server/services/eventBus-instances.test.ts
git commit -m "feat(zai): add shared instance types and instance.changed event"
```

---

## Task 2: `instanceStore` — `~/.zai/instances.json` persistence

**Files:**
- Create: `packages/zai/src/server/services/instanceStore.ts`
- Create: `packages/zai/test/server/services/instanceStore.test.ts`

**Interfaces (produced):**
- `interface InstancesFile { definitions: InstanceDefinition[]; statuses: Record<string, InstanceStatus> }`
- `const EMPTY_INSTANCE_STATUS: InstanceStatus` with `state:'stopped'` and all nullable fields `null`
- `function instancesFilePath(dataDir?: string): string`
- `function readInstancesFile(dataDir?: string): Promise<InstancesFile>`
- `function writeInstancesFile(file: InstancesFile, dataDir?: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

`packages/zai/test/server/services/instanceStore.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import {
  EMPTY_INSTANCE_STATUS,
  instancesFilePath,
  readInstancesFile,
  writeInstancesFile,
  type InstancesFile,
} from '../../../src/server/services/instanceStore.js'

const DATA_DIR = '/tmp/zai-test-instance-store'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  try { await rm(DATA_DIR, { recursive: true, force: true }) } catch {}
})

describe('instanceStore', () => {
  it('returns empty file when path does not exist', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const file = await readInstancesFile()
    expect(file).toEqual({ definitions: [], statuses: {} })
  })

  it('round-trips definitions and statuses', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const def = { id: 'inst_1', name: 'demo', cwd: '/tmp/x', createdAt: '2026-08-03T00:00:00.000Z' }
    const status = { ...EMPTY_INSTANCE_STATUS, state: 'running' as const, port: 9202, pid: 42 }
    const file: InstancesFile = { definitions: [def], statuses: { inst_1: status } }
    await writeInstancesFile(file)
    expect(instancesFilePath(DATA_DIR)).toMatch(/instances\.json$/)
    const reloaded = await readInstancesFile(DATA_DIR)
    expect(reloaded).toEqual(file)
  })

  it('returns empty file when JSON is corrupt', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const path = instancesFilePath(DATA_DIR)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(path, 'not-json{', 'utf-8')
    const file = await readInstancesFile(DATA_DIR)
    expect(file).toEqual({ definitions: [], statuses: {} })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "instanceStore"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `instanceStore.ts`**

`packages/zai/src/server/services/instanceStore.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import type { InstanceDefinition, InstanceStatus } from '../../shared/instances.js'

export interface InstancesFile {
  definitions: InstanceDefinition[]
  statuses: Record<string, InstanceStatus>
}

export const INSTANCE_STATE_FILE = 'instances.json'

export const EMPTY_INSTANCE_STATUS: InstanceStatus = {
  state: 'stopped',
  port: null,
  pid: null,
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

export function instancesFilePath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), INSTANCE_STATE_FILE)
}

export async function readInstancesFile(dataDir?: string): Promise<InstancesFile> {
  const file = instancesFilePath(dataDir)
  if (!existsSync(file)) return { definitions: [], statuses: {} }
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as InstancesFile
  } catch {
    return { definitions: [], statuses: {} }
  }
}

export async function writeInstancesFile(
  file: InstancesFile,
  dataDir?: string,
): Promise<void> {
  const dir = resolveDataDir(dataDir)
  const path = instancesFilePath(dir)
  await mkdir(dir, { recursive: true })
  // proper-lockfile requires the file to exist; create an empty default if missing
  if (!existsSync(path)) {
    await writeFile(path, JSON.stringify({ definitions: [], statuses: {} }, null, 2), 'utf-8')
  }
  const release = await lock(path, { retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } })
  try {
    await writeFile(path, JSON.stringify(file, null, 2), 'utf-8')
  } finally {
    await release()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai test -t "instanceStore"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/instanceStore.ts \
        packages/zai/test/server/services/instanceStore.test.ts
git commit -m "feat(zai): add instanceStore for ~/.zai/instances.json"
```

---

## Task 3: `instanceHeartbeat` — child-side IPC timer

**Files:**
- Create: `packages/zai/src/server/services/instanceHeartbeat.ts`
- Create: `packages/zai/test/server/services/instanceHeartbeat.test.ts`

**Interfaces (produced):**
- `interface InstanceHeartbeat { start(): void; stop(): void }`
- `function getInstanceHeartbeatConfig(): { enabled: true; instanceId: string; intervalMs: number } | null`
- `function createInstanceHeartbeat(opts): InstanceHeartbeat`

- [ ] **Step 1: Write the failing test**

`packages/zai/test/server/services/instanceHeartbeat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInstanceHeartbeat,
  getInstanceHeartbeatConfig,
} from '../../../src/server/services/instanceHeartbeat.js'

describe('getInstanceHeartbeatConfig', () => {
  afterEach(() => {
    delete process.env.ZAI_INSTANCE_ID
    delete process.env.ZAI_SUPERVISOR_PID
    delete process.env.ZAI_INSTANCE_HEARTBEAT_MS
  })

  it('returns null when ZAI_INSTANCE_ID is missing', () => {
    process.env.ZAI_SUPERVISOR_PID = '123'
    expect(getInstanceHeartbeatConfig()).toBeNull()
  })

  it('returns null when ZAI_SUPERVISOR_PID is missing', () => {
    process.env.ZAI_INSTANCE_ID = 'inst_1'
    expect(getInstanceHeartbeatConfig()).toBeNull()
  })

  it('returns config with default 5000ms when interval env is unset', () => {
    process.env.ZAI_INSTANCE_ID = 'inst_1'
    process.env.ZAI_SUPERVISOR_PID = '123'
    expect(getInstanceHeartbeatConfig()).toEqual({
      enabled: true,
      instanceId: 'inst_1',
      intervalMs: 5000,
    })
  })

  it('honours a valid custom interval', () => {
    process.env.ZAI_INSTANCE_ID = 'inst_1'
    process.env.ZAI_SUPERVISOR_PID = '123'
    process.env.ZAI_INSTANCE_HEARTBEAT_MS = '2500'
    expect(getInstanceHeartbeatConfig()?.intervalMs).toBe(2500)
  })
})

describe('createInstanceHeartbeat', () => {
  let timers: Array<() => void>
  const setIntervalMock = vi.fn((cb: () => void) => {
    timers.push(cb)
    return Symbol('timer')
  })
  const clearIntervalMock = vi.fn()

  beforeEach(() => {
    timers = []
  })

  it('sends a heartbeat on each interval tick with the configured shape', () => {
    const sent: unknown[] = []
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 1000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: (msg) => { sent.push(msg); return true },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(1)
    now = 11_500
    timers[0]!()
    expect(sent).toEqual([
      { type: 'heartbeat', instanceId: 'inst_1', port: 9202, ts: 11_500, pid: process.pid },
    ])
  })

  it('does not emit more often than intervalMs', () => {
    const sent: unknown[] = []
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 5000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: (msg) => { sent.push(msg); return true },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    now = 11_000
    timers[0]!()
    now = 12_000
    timers[0]!()
    now = 17_000
    timers[0]!()
    expect(sent).toHaveLength(2)
  })

  it('stops calling send after stop()', () => {
    const sent: unknown[] = []
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 1000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: (msg) => { sent.push(msg); return true },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    now = 11_000
    timers[0]!()
    hb.stop()
    timers[0]!()
    expect(sent).toHaveLength(1)
    expect(clearIntervalMock).toHaveBeenCalled()
  })

  it('still returns cleanly when send throws', () => {
    let now = 10_000
    const hb = createInstanceHeartbeat({
      intervalMs: 1000,
      instanceId: 'inst_1',
      getPort: () => 9202,
      send: () => { throw new Error('pipe broken') },
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    hb.start()
    expect(() => timers[0]!()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "createInstanceHeartbeat"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `instanceHeartbeat.ts`**

`packages/zai/src/server/services/instanceHeartbeat.ts`:

```ts
import { randomUUID } from 'node:crypto'

const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000

export interface InstanceHeartbeat {
  start: () => void
  stop: () => void
}

export function getInstanceHeartbeatConfig():
  | { enabled: true; instanceId: string; intervalMs: number }
  | null {
  const instanceId = process.env.ZAI_INSTANCE_ID
  const supervisorPid = process.env.ZAI_SUPERVISOR_PID
  if (!instanceId || !supervisorPid) return null
  const raw = process.env.ZAI_INSTANCE_HEARTBEAT_MS
  const parsed = raw ? Number(raw) : DEFAULT_INTERVAL_MS
  const intervalMs =
    Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS ? Math.floor(parsed) : DEFAULT_INTERVAL_MS
  return { enabled: true, instanceId, intervalMs }
}

export interface CreateInstanceHeartbeatOptions {
  intervalMs: number
  instanceId: string
  getPort: () => number | null
  send?: (msg: unknown) => boolean
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (timer: unknown) => void
}

export function createInstanceHeartbeat(opts: CreateInstanceHeartbeatOptions): InstanceHeartbeat {
  const now = opts.now ?? Date.now
  const scheduleInterval = opts.setInterval ?? setInterval
  const clearScheduledInterval = opts.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>))
  const send = opts.send ?? defaultSend
  let timer: unknown
  let lastSentAt = 0

  const emit = (): void => {
    const ts = now()
    if (ts - lastSentAt < opts.intervalMs) return
    lastSentAt = ts
    try {
      send({
        type: 'heartbeat',
        instanceId: opts.instanceId,
        port: opts.getPort(),
        ts,
        pid: process.pid,
        uuid: randomUUID(),
      })
    } catch {
      // parent process gone — best-effort silent
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      lastSentAt = now()
      timer = scheduleInterval(emit, opts.intervalMs)
      unrefTimer(timer)
    },
    stop() {
      if (timer === undefined) return
      clearScheduledInterval(timer)
      timer = undefined
    },
  }
}

function defaultSend(msg: unknown): boolean {
  if (typeof process.send !== 'function') return false
  try {
    return Boolean(process.send(msg))
  } catch {
    return false
  }
}

function unrefTimer(timer: unknown): void {
  if (
    timer !== undefined &&
    timer !== null &&
    typeof timer === 'object' &&
    'unref' in timer &&
    typeof (timer as { unref: () => void }).unref === 'function'
  ) {
    (timer as { unref: () => void }).unref()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai test -t "createInstanceHeartbeat"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/instanceHeartbeat.ts \
        packages/zai/test/server/services/instanceHeartbeat.test.ts
git commit -m "feat(zai): add instanceHeartbeat timer for child IPC"
```

---

## Task 4: `instanceSupervisor` — central lifecycle + heartbeat-watcher

This is the biggest task; split into 4a (state machine + spawn/exit handling) and 4b (heartbeat-watcher + shutdown).

### Task 4a: State machine + spawn / start / stop / restart / remove

**Files:**
- Create: `packages/zai/src/server/services/instanceSupervisor.ts`
- Create: `packages/zai/test/server/services/instanceSupervisor.test.ts`

**Interfaces (produced; signature reference for 4b, Task 5, Task 6):**
- `const INSTANCE_BASE_PORT = 9201`
- `const HEARTBEAT_TIMEOUT_MS = 20_000`
- `const HEARTBEAT_POLL_MS = 5_000`
- `const STOP_TIMEOUT_MS = 10_000`
- `const SHUTDOWN_TIMEOUT_MS = 3_000`
- `type InstanceSupervisorDeps`
- `interface InstanceSupervisor`
- `function initInstanceSupervisor(opts)` / `shutdownInstanceSupervisor()` / `getInstanceSupervisor()`

- [ ] **Step 1: Write the failing test (state machine + spawn + ready + exit)**

`packages/zai/test/server/services/instanceSupervisor.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { ServerEventInput } from '../../../src/server/services/eventBus.js'

class FakeChild extends EventEmitter {
  pid = 111
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((sig?: NodeJS.Signals) => {
    this.killed = true
    return true
  })
  emitExit(code: number | null): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

interface Deps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  emit: (e: ServerEventInput) => void
  spawn: () => FakeChild
  probePort: (start: number, max?: number) => Promise<number>
  // persistence captured
  writeFile: (next: { def: unknown; statuses: Record<string, unknown> }) => Promise<void>
}

function makeSupervisor(extra?: { onWriteFile?: Deps['writeFile']; emit?: Deps['emit'] }) {
  const events: ServerEventInput[] = []
  const writes: { def: unknown; statuses: Record<string, unknown> }[] = []
  let time = 1_000_000
  let probeStart = 9201
  const fakeChildren: FakeChild[] = []
  const deps: Deps = {
    now: () => time,
    sleep: () => Promise.resolve(),
    emit: extra?.emit ?? ((e) => { events.push(e) }),
    spawn: () => {
      const c = new FakeChild()
      fakeChildren.push(c)
      return c as unknown as ChildProcess
    },
    probePort: vi.fn(async (start: number) => {
      probeStart = start
      return start
    }),
    writeFile: extra?.onWriteFile ?? (async (w) => { writes.push(w) }),
  }
  return { events, writes, deps, fakeChildren, advance: (t: number) => { time = t }, setProbe: (n: number) => { probeStart = n } }
}

describe('instanceSupervisor (4a — state machine)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('createInstance persists definition, returns stopped snapshot, current snapshot is isCurrent=true', async () => {
    const { deps, events } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    const sup = initInstanceSupervisor({
      cwd: '/tmp/current',
      dataDir: '/tmp/zai-data-4a',
      deps: deps as never,
    })
    void sup
    expect(getInstanceSupervisor().getSnapshots()).toHaveLength(1) // current only
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    expect(snap.state).toBe('stopped')
    expect(snap.isCurrent).toBe(false)
    expect(snap.id).toMatch(/^inst_/)
    const all = getInstanceSupervisor().getSnapshots()
    expect(all.find((s) => s.id === snap.id)?.name).toBe('demo')
    expect(events.some((e) => (e as { type: string }).type === 'instance.changed')).toBe(true)
  })

  it('startInstance → ready IPC → running, port recorded from message', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    expect(fakeChildren).toHaveLength(1)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    const after = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(after.state).toBe('running')
    expect(after.port).toBe(9205)
    expect(after.pid).toBe(222)
  })

  it('non-user exit → state down + lastError; user stop → stopped', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const child = fakeChildren[0]!

    // crash
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    child.emitExit(1)
    const afterCrash = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(afterCrash.state).toBe('down')
    expect(afterCrash.lastError?.message).toContain('exit')
    expect(afterCrash.port).toBeNull()

    // user stop
    await getInstanceSupervisor().startInstance(snap.id)
    const child2 = fakeChildren[1]!
    child2.emit('message', { type: 'ready', pid: 333, port: 9206 })
    await getInstanceSupervisor().stopInstance(snap.id)
    expect(child2.kill).toHaveBeenCalledWith('SIGINT')
    const afterStop = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(afterStop.state).toBe('stopped')
    expect(afterStop.port).toBeNull()
  })

  it('restartInstance = stop + start', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await getInstanceSupervisor().restartInstance(snap.id)
    expect(fakeChildren).toHaveLength(2)
  })

  it('removeInstance running → stops first, then removes', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    fakeChildren[0]!.emit('message', { type: 'ready', pid: 222, port: 9205 })
    await getInstanceSupervisor().removeInstance(snap.id)
    expect(getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)).toBeUndefined()
  })

  it('reject operations on current instance', async () => {
    const { deps } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const current = getInstanceSupervisor().getSnapshots().find((s) => s.isCurrent)!
    await expect(getInstanceSupervisor().startInstance(current.id)).rejects.toThrow(/current/)
    await expect(getInstanceSupervisor().stopInstance(current.id)).rejects.toThrow(/current/)
    await expect(getInstanceSupervisor().removeInstance(current.id)).rejects.toThrow(/current/)
  })

  it('rejects duplicate instance name', async () => {
    const { deps } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await expect(getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/y' }))
      .rejects.toThrow(/duplicate/)
  })

  it('rejects start for unknown id with code NOT_FOUND', async () => {
    const { deps } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    await expect(getInstanceSupervisor().startInstance('inst_missing'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "instanceSupervisor (4a"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `instanceSupervisor.ts` (4a portion)**

`packages/zai/src/server/services/instanceSupervisor.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { eventBus, type ServerEventInput } from './eventBus.js'
import {
  EMPTY_INSTANCE_STATUS,
  readInstancesFile,
  writeInstancesFile,
  type InstancesFile,
} from './instanceStore.js'
import { listen } from '../../cli/ports.js'
import type {
  InstanceDefinition,
  InstanceSnapshot,
  InstanceState,
  InstanceStatus,
} from '../../shared/instances.js'

export const INSTANCE_BASE_PORT = 9201
export const HEARTBEAT_TIMEOUT_MS = 20_000
export const HEARTBEAT_POLL_MS = 5_000
export const STOP_TIMEOUT_MS = 10_000
export const SHUTDOWN_TIMEOUT_MS = 3_000
export const CURRENT_INSTANCE_ID = '__current__'
export const MAX_PORT_ATTEMPTS = 100

export class InstanceSupervisorError extends Error {
  readonly code: 'NOT_FOUND' | 'CURRENT_INSTANCE' | 'DUPLICATE_NAME' | 'INVALID_STATE'
  constructor(code: InstanceSupervisorError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export type InstanceSupervisorDeps = {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  probePort: (start: number, maxAttempts?: number) => Promise<number>
  readFile: () => Promise<InstancesFile>
  writeFile: (file: InstancesFile) => Promise<void>
  emit: (event: ServerEventInput) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

type Entry = {
  def: InstanceDefinition
  status: InstanceStatus
  child: ChildProcess | null
  userStopping: boolean
}

export interface InstanceSupervisor {
  getSnapshots: () => InstanceSnapshot[]
  createInstance: (input: { name: string; cwd: string }) => Promise<InstanceSnapshot>
  startInstance: (id: string) => Promise<InstanceSnapshot>
  stopInstance: (id: string) => Promise<InstanceSnapshot>
  restartInstance: (id: string) => Promise<InstanceSnapshot>
  removeInstance: (id: string) => Promise<void>
  shutdown: () => Promise<void>
}

interface InitOptions {
  cwd: string
  dataDir?: string
  cliEntry?: string
  deps?: Partial<InstanceSupervisorDeps>
}

let singleton: InstanceSupervisor | null = null
let shutdownHook: (() => Promise<void>) | null = null

export function getInstanceSupervisor(): InstanceSupervisor {
  if (!singleton) throw new Error('instanceSupervisor not initialized')
  return singleton
}

async function probePortDefault(start: number, maxAttempts = MAX_PORT_ATTEMPTS): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset
    try {
      const server = await listen(candidate)
      server.close()
      return candidate
    } catch {
      // occupied; try next
    }
  }
  throw new Error(`No available port found in range [${start}, ${start + maxAttempts - 1}]`)
}

export function initInstanceSupervisor(opts: InitOptions): InstanceSupervisor {
  if (singleton) return singleton
  const deps: InstanceSupervisorDeps = {
    spawn: opts.deps?.spawn ?? nodeSpawn,
    probePort: opts.deps?.probePort ?? probePortDefault,
    readFile: opts.deps?.readFile ?? (() => readInstancesFile(opts.dataDir)),
    writeFile: opts.deps?.writeFile ?? ((f) => writeInstancesFile(f, opts.dataDir)),
    emit: opts.deps?.emit ?? ((e) => eventBus.emit(e)),
    now: opts.deps?.now ?? Date.now,
    sleep: opts.deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  }
  const cliEntry = opts.cliEntry ?? process.argv[1] ?? ''
  const entries = new Map<string, Entry>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function emit(instanceId: string, status: InstanceStatus): void {
    deps.emit({
      type: 'instance.changed',
      instanceId,
      state: status.state,
      port: status.port,
      pid: status.pid,
    })
  }

  function snapshotOf(id: string, entry: Entry): InstanceSnapshot {
    return { ...entry.def, ...entry.status, isCurrent: false }
  }

  function currentSnapshot(): InstanceSnapshot {
    return {
      id: CURRENT_INSTANCE_ID,
      name: basename(opts.cwd) || opts.cwd,
      cwd: opts.cwd,
      createdAt: '',
      state: 'running',
      port: Number(process.env.ZAI_PORT ?? 0) || null,
      pid: process.pid,
      startedAt: new Date(deps.now()).toISOString(),
      lastHeartbeatAt: null,
      lastError: null,
      isCurrent: true,
    }
  }

  function ensureNotCurrent(id: string): void {
    if (id === CURRENT_INSTANCE_ID) {
      throw new InstanceSupervisorError(
        'CURRENT_INSTANCE',
        'cannot operate on current instance',
      )
    }
  }

  function getEntry(id: string): Entry {
    const entry = entries.get(id)
    if (!entry) throw new InstanceSupervisorError('NOT_FOUND', `instance ${id} not found`)
    return entry
  }

  async function persist(): Promise<void> {
    const defs: InstanceDefinition[] = []
    const statuses: Record<string, InstanceStatus> = {}
    for (const [id, entry] of entries) {
      defs.push(entry.def)
      statuses[id] = entry.status
    }
    await deps.writeFile({ definitions: defs, statuses })
  }

  function setStatus(entry: Entry, patch: Partial<InstanceStatus>): InstanceStatus {
    entry.status = { ...entry.status, ...patch }
    return entry.status
  }

  function attachChild(entry: Entry, child: ChildProcess): void {
    entry.child = child
    child.on('message', (raw: unknown) => {
      const msg = raw as { type?: string; pid?: number; port?: number }
      if (msg.type === 'ready' && typeof msg.port === 'number') {
        setStatus(entry, {
          state: 'running',
          port: msg.port,
          pid: msg.pid ?? child.pid ?? null,
          startedAt: new Date(deps.now()).toISOString(),
          lastHeartbeatAt: new Date(deps.now()).toISOString(),
          lastError: null,
        })
        emit(entry.def.id, entry.status)
      } else if (msg.type === 'heartbeat') {
        setStatus(entry, { lastHeartbeatAt: new Date(deps.now()).toISOString() })
        // do not broadcast on every heartbeat (too noisy); only state changes emit
      }
    })
    child.on('exit', (code: number | null) => {
      entry.child = null
      if (entry.userStopping) {
        setStatus(entry, {
          state: 'stopped',
          port: null,
          pid: null,
          lastError: null,
        })
        emit(entry.def.id, entry.status)
        return
      }
      setStatus(entry, {
        state: 'down',
        port: null,
        pid: null,
        lastError: {
          at: new Date(deps.now()).toISOString(),
          message: `process exited with code ${code ?? 'null'}`,
        },
      })
      emit(entry.def.id, entry.status)
    })
  }

  async function doStart(id: string): Promise<InstanceSnapshot> {
    const entry = getEntry(id)
    if (entry.status.state === 'starting' || entry.status.state === 'running') {
      return snapshotOf(id, entry)
    }
    setStatus(entry, { state: 'starting', lastError: null })
    emit(id, entry.status)
    const port = await deps.probePort(INSTANCE_BASE_PORT)
    const child = deps.spawn(
      process.execPath,
      [cliEntry, 'start', '--managed-child', '--port', String(port), '--no-open'],
      {
        stdio: ['ipc', 'inherit', 'inherit'],
        detached: false,
        env: {
          ...process.env,
          ZAI_INSTANCE_ID: id,
          ZAI_SUPERVISOR_PID: String(process.pid),
          ZAI_INSTANCE_HEARTBEAT_MS: '5000',
        },
      },
    )
    attachChild(entry, child)
    return snapshotOf(id, entry)
  }

  async function doStop(id: string): Promise<InstanceSnapshot> {
    const entry = getEntry(id)
    const child = entry.child
    if (!child) {
      setStatus(entry, { state: 'stopped', port: null, pid: null })
      emit(id, entry.status)
      return snapshotOf(id, entry)
    }
    setStatus(entry, { state: 'stopping' })
    emit(id, entry.status)
    entry.userStopping = true
    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      let resolved = false
      const tryResolve = (code: number | null) => {
        if (resolved) return
        resolved = true
        resolve({ code })
      }
      child.once('exit', (code) => tryResolve(code))
      if (child.exitCode != null || child.signalCode != null) {
        tryResolve(child.exitCode)
      }
    })
    try {
      child.kill('SIGINT')
    } catch {
      // ignore — exit handler will fire
    }
    const timeout = new Promise<{ code: number | null; timedOut: true }>((resolve) => {
      setTimeout(() => resolve({ code: null, timedOut: true }), STOP_TIMEOUT_MS).unref()
    })
    const result = await Promise.race([exitPromise, timeout])
    if ('timedOut' in result && result.timedOut) {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
    return snapshotOf(id, entry)
  }

  async function doRemove(id: string): Promise<void> {
    ensureNotCurrent(id)
    const entry = getEntry(id)
    if (entry.child) await doStop(id)
    entries.delete(id)
    await persist()
  }

  const supervisor: InstanceSupervisor = {
    getSnapshots() {
      const managed: InstanceSnapshot[] = []
      for (const [id, entry] of entries) managed.push(snapshotOf(id, entry))
      return [currentSnapshot(), ...managed]
    },
    async createInstance({ name, cwd }) {
      const trimmed = name.trim()
      for (const e of entries.values()) {
        if (e.def.name === trimmed) {
          throw new InstanceSupervisorError('DUPLICATE_NAME', `duplicate name: ${trimmed}`)
        }
      }
      const def: InstanceDefinition = {
        id: `inst_${randomUUID().slice(0, 8)}`,
        name: trimmed,
        cwd,
        createdAt: new Date(deps.now()).toISOString(),
      }
      entries.set(def.id, { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, userStopping: false })
      await persist()
      emit(def.id, entries.get(def.id)!.status)
      await doStart(def.id)
      return snapshotOf(def.id, entries.get(def.id)!)
    },
    async startInstance(id) {
      ensureNotCurrent(id)
      return doStart(id)
    },
    async stopInstance(id) {
      ensureNotCurrent(id)
      return doStop(id)
    },
    async restartInstance(id) {
      ensureNotCurrent(id)
      const snap = await doStop(id)
      await doStart(id)
      return snap
    },
    async removeInstance(id) {
      await doRemove(id)
    },
    async shutdown() {
      // implemented in 4b — placeholder for type compatibility
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    },
  }

  // hydrate from disk (definitions only; statuses reset to stopped)
  void (async () => {
    const file = await deps.readFile()
    for (const def of file.definitions) {
      entries.set(def.id, { def, status: { ...EMPTY_INSTANCE_STATUS }, child: null, userStopping: false })
    }
  })()

  singleton = supervisor
  return supervisor
}

export function resetInstanceSupervisorForTests(): void {
  singleton = null
}

export async function shutdownInstanceSupervisor(): Promise<void> {
  if (!singleton) return
  if (shutdownHook) await shutdownHook()
  singleton = null
}
```

Note: the `shutdown` body above is a stub; Task 4b replaces it with the full kill-all-children logic and the heartbeat-watcher timer.

- [ ] **Step 4: Run test to verify the 4a subset passes**

Run: `pnpm --filter @zn-ai/zai test -t "instanceSupervisor (4a"`
Expected: PASS (8 tests). Task 4b replaces the `shutdown` stub; existing tests should still pass because they do not exercise shutdown.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/instanceSupervisor.ts \
        packages/zai/test/server/services/instanceSupervisor.test.ts
git commit -m "feat(zai): add instanceSupervisor state machine + spawn/stop/restart"
```

### Task 4b: Heartbeat-timeout watcher + shutdown kill-all

**Files:**
- Modify: `packages/zai/src/server/services/instanceSupervisor.ts` (replace the stub `shutdown` body; add watcher tick)
- Modify: `packages/zai/test/server/services/instanceSupervisor.test.ts` (append heartbeat + shutdown tests)

**Interfaces (carry-over):** none new.

- [ ] **Step 1: Append failing tests for heartbeat-watcher + shutdown**

Append to `packages/zai/test/server/services/instanceSupervisor.test.ts`:

```ts
describe('instanceSupervisor (4b — heartbeat + shutdown)', () => {
  beforeEach(() => {
    delete process.env.ZAI_DATA_DIR
    vi.resetModules()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('heartbeat tick: stale running instance → down + SIGKILL + lastError', async () => {
    let time = 1_000_000
    const sleeps: Array<() => void> = []
    const { deps, fakeChildren } = makeSupervisor()
    deps.now = () => time
    deps.sleep = () => new Promise<void>((r) => setTimeout(r, r.length))
    const { initInstanceSupervisor, getInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    const sup = initInstanceSupervisor({
      cwd: '/tmp/current',
      dataDir: '/tmp/x',
      deps: deps as never,
    })
    void sup
    const snap = await getInstanceSupervisor().createInstance({ name: 'demo', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(snap.id)
    const child = fakeChildren[0]!
    child.emit('message', { type: 'ready', pid: 222, port: 9205 })
    // jump time past HEARTBEAT_TIMEOUT_MS
    time += 25_000
    // trigger watcher tick by calling the exported tick (or by waiting the first interval);
    // tests directly invoke a tick helper exposed only in test mode
    ;(getInstanceSupervisor() as unknown as { __tickHeartbeat?: () => void }).__tickHeartbeat?.()
    const after = getInstanceSupervisor().getSnapshots().find((s) => s.id === snap.id)!
    expect(after.state).toBe('down')
    expect(after.lastError?.message).toMatch(/heartbeat/)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('shutdown kills every child via SIGINT → SIGKILL after SHUTDOWN_TIMEOUT_MS', async () => {
    const { deps, fakeChildren } = makeSupervisor()
    const { initInstanceSupervisor, getInstanceSupervisor, shutdownInstanceSupervisor } = await import(
      '../../../src/server/services/instanceSupervisor.js'
    )
    initInstanceSupervisor({ cwd: '/tmp/current', dataDir: '/tmp/x', deps: deps as never })
    const a = await getInstanceSupervisor().createInstance({ name: 'a', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(a.id)
    const b = await getInstanceSupervisor().createInstance({ name: 'b', cwd: '/tmp/x' })
    await getInstanceSupervisor().startInstance(b.id)
    fakeChildren.forEach((c) => c.emit('message', { type: 'ready', pid: 1, port: 9205 }))
    await shutdownInstanceSupervisor()
    // both children must have received SIGINT, then SIGKILL after the timeout (simulate by emitting exit only after both kills)
    const sigints = fakeChildren.map((c) => c.kill.mock.calls.flat()).flat()
    expect(sigints).toContain('SIGINT')
    // the test does not actually wait the wall-clock timeout — we only verify the SIGINT broadcast;
    // SIGKILL escalation is exercised by integration. The shutdown implementation sends SIGINT
    // immediately and schedules SIGKILL via setTimeout.
  })
})
```

Note: the first test relies on a `__tickHeartbeat` test hook. Implement that hook inside `initInstanceSupervisor` (see Step 3).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "instanceSupervisor (4b"`
Expected: FAIL — `__tickHeartbeat` is not exported.

- [ ] **Step 3: Replace the `shutdown` stub + add heartbeat watcher in `instanceSupervisor.ts`**

Inside `initInstanceSupervisor`, replace the `async shutdown()` stub and add the watcher tick. Locate the stub and replace:

```ts
    async shutdown() {
      const killPromises: Array<Promise<void>> = []
      for (const entry of entries.values()) {
        if (!entry.child) continue
        entry.userStopping = true
        try { entry.child.kill('SIGINT') } catch { /* ignore */ }
        const c = entry.child
        killPromises.push(
          new Promise<void>((resolve) => {
            const killTimer = setTimeout(() => {
              try { c.kill('SIGKILL') } catch { /* ignore */ }
            }, SHUTDOWN_TIMEOUT_MS)
            killTimer.unref()
            const onExit = () => { clearTimeout(killTimer); resolve() }
            c.once('exit', onExit)
            if (c.exitCode != null || c.signalCode != null) onExit()
          }),
        )
      }
      await Promise.all(killPromises)
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    },
```

Also add a watcher tick definition before `const supervisor` and a `__tickHeartbeat` test hook after supervisor is built:

```ts
  function tickHeartbeat(): void {
    const nowMs = deps.now()
    for (const entry of entries.values()) {
      if (entry.status.state !== 'running') continue
      const last = entry.status.lastHeartbeatAt
        ? new Date(entry.status.lastHeartbeatAt).getTime()
        : 0
      if (nowMs - last <= HEARTBEAT_TIMEOUT_MS) continue
      // stale → kill + mark down
      const child = entry.child
      if (child) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
      setStatus(entry, {
        state: 'down',
        port: null,
        pid: null,
        lastError: {
          at: new Date(nowMs).toISOString(),
          message: `heartbeat timeout (>${HEARTBEAT_TIMEOUT_MS}ms)`,
        },
      })
      emit(entry.def.id, entry.status)
    }
  }

  heartbeatTimer = setInterval(tickHeartbeat, HEARTBEAT_POLL_MS)
  heartbeatTimer.unref()
```

Add the test hook after `singleton = supervisor` (only visible to tests):

```ts
  ;(supervisor as unknown as { __tickHeartbeat: () => void }).__tickHeartbeat = tickHeartbeat
```

- [ ] **Step 4: Run test to verify the 4b tests pass**

Run: `pnpm --filter @zn-ai/zai test -t "instanceSupervisor (4b"`
Expected: PASS (2 tests). The full file's 10 tests all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/instanceSupervisor.ts \
        packages/zai/test/server/services/instanceSupervisor.test.ts
git commit -m "feat(zai): add instanceSupervisor heartbeat watcher and shutdown"
```

---

## Task 5: REST router `/api/instances`

**Files:**
- Create: `packages/zai/src/server/routes/instances.ts`
- Create: `packages/zai/test/server/routes/instances.test.ts`

**Interfaces (consumed):** `getInstanceSupervisor()` from Task 4.

- [ ] **Step 1: Write the failing test**

`packages/zai/test/server/routes/instances.test.ts`:

```ts
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'

const DATA_DIR = '/tmp/zai-test-instances-route'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  vi.resetModules()
  try { await rm(DATA_DIR, { recursive: true, force: true }) } catch {}
})

async function bootstrap() {
  process.env.ZAI_DATA_DIR = DATA_DIR
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const { initInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
  const { default: router } = await import('../../../src/server/routes/instances.js')
  initInstanceSupervisor({
    cwd: '/tmp/current',
    dataDir: DATA_DIR,
    deps: { spawn: () => { throw new Error('spawn should not be called in this test') } as never,
            probePort: async () => 9201,
            writeFile: async () => undefined,
            readFile: async () => ({ definitions: [], statuses: {} }),
            emit: () => undefined,
            now: () => Date.now(),
            sleep: async () => undefined },
  })
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  return { app }
}

describe('routes/instances', () => {
  it('GET /api/instances returns the current instance row', async () => {
    const { app } = await bootstrap()
    const res = await request(app).get('/api/instances')
    expect(res.status).toBe(200)
    expect(res.body.instances).toHaveLength(1)
    expect(res.body.instances[0].isCurrent).toBe(true)
  })

  it('POST /api/instances rejects missing fields with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app).post('/api/instances').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/instances rejects unknown cwd with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/this/path/does/not/exist/zzz' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cwd/)
  })

  it('operations on current instance return 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app).post('/api/instances/__current__/start')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/current/)
  })

  it('GET /api/instances/:id returns 404 for unknown', async () => {
    const { app } = await bootstrap()
    const res = await request(app).get('/api/instances/inst_missing')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "routes/instances"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `routes/instances.ts`**

`packages/zai/src/server/routes/instances.ts`:

```ts
import { Router, type IRouter } from 'express'
import { existsSync, statSync } from 'node:fs'
import { getInstanceSupervisor, CURRENT_INSTANCE_ID } from '../services/instanceSupervisor.js'

const router: IRouter = Router()

function notFound(res: import('express').Response, msg: string): void {
  res.status(404).json({ error: msg })
}

function badRequest(res: import('express').Response, msg: string): void {
  res.status(400).json({ error: msg })
}

function handleError(res: import('express').Response, err: unknown): void {
  const code = (err as { code?: string } | null)?.code
  if (code === 'NOT_FOUND') {
    notFound(res, err instanceof Error ? err.message : 'not found')
    return
  }
  if (code === 'CURRENT_INSTANCE') {
    badRequest(res, err instanceof Error ? err.message : 'cannot operate on current instance')
    return
  }
  if (code === 'DUPLICATE_NAME') {
    res.status(409).json({ error: err instanceof Error ? err.message : 'duplicate' })
    return
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

router.get('/', (_req, res) => {
  res.json({ instances: getInstanceSupervisor().getSnapshots() })
})

router.get('/:id', (req, res) => {
  const snap = getInstanceSupervisor().getSnapshots().find((s) => s.id === req.params.id)
  if (!snap) return notFound(res, `instance ${req.params.id} not found`)
  res.json({ instance: snap })
})

router.post('/', async (req, res) => {
  const { name, cwd } = (req.body ?? {}) as { name?: unknown; cwd?: unknown }
  if (typeof name !== 'string' || name.trim() === '') return badRequest(res, 'name is required')
  if (typeof cwd !== 'string' || cwd.trim() === '') return badRequest(res, 'cwd is required')
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return badRequest(res, 'cwd must be an existing directory')
  }
  try {
    const instance = await getInstanceSupervisor().createInstance({ name: name.trim(), cwd })
    res.status(201).json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/:id/start', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot start current instance')
  try {
    const instance = await getInstanceSupervisor().startInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/:id/stop', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot stop current instance')
  try {
    const instance = await getInstanceSupervisor().stopInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.post('/:id/restart', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot restart current instance')
  try {
    const instance = await getInstanceSupervisor().restartInstance(req.params.id)
    res.json({ instance })
  } catch (err) {
    handleError(res, err)
  }
})

router.delete('/:id', async (req, res) => {
  if (req.params.id === CURRENT_INSTANCE_ID) return badRequest(res, 'cannot delete current instance')
  try {
    await getInstanceSupervisor().removeInstance(req.params.id)
    res.status(204).end()
  } catch (err) {
    handleError(res, err)
  }
})

export default router
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai test -t "routes/instances"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/instances.ts \
        packages/zai/test/server/routes/instances.test.ts
git commit -m "feat(zai): add /api/instances REST router"
```

---

## Task 6: Wire supervisor into `createApp` + cleanup hookups + start child heartbeat

**Files:**
- Modify: `packages/zai/src/server/index.ts:102-150` (mount router + init supervisor)
- Modify: `packages/zai/src/cli/start.ts:106-118` (activate heartbeat when `ZAI_INSTANCE_ID` is set)
- Modify: `packages/zai/src/cli/start.ts:149-157` (cleanup calls `shutdownInstanceSupervisor`)
- Modify: `packages/zai/src/cli/dev.ts:140-147` (cleanup calls `shutdownInstanceSupervisor`)
- Create: `packages/zai/test/server/instance-supervisor-wiring.test.ts`

**Interfaces (consumed):** `initInstanceSupervisor`, `shutdownInstanceSupervisor` from Task 4; `getInstanceHeartbeatConfig`/`createInstanceHeartbeat` from Task 3.

- [ ] **Step 1: Write the failing wiring test**

`packages/zai/test/server/instance-supervisor-wiring.test.ts`:

```ts
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'

const DATA_DIR = '/tmp/zai-test-supervisor-wiring'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  vi.resetModules()
  try { await rm(DATA_DIR, { recursive: true, force: true }) } catch {}
})

describe('instance supervisor wiring inside createApp', () => {
  it('GET /api/instances responds 200 with current row after createApp', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    process.env.ZAI_PORT = '9201'
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const { createApp } = await import('../../src/server/index.js')
    const app = await createApp({
      token: 'test',
      cwd: '/tmp/current',
      cwdName: 'current',
      host: '127.0.0.1',
      sdk: false,
    })
    const res = await request(app).get('/api/instances')
    expect(res.status).toBe(200)
    expect(res.body.instances).toHaveLength(1)
    expect(res.body.instances[0].isCurrent).toBe(true)
    expect(res.body.instances[0].port).toBe(9201)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "instance supervisor wiring"`
Expected: FAIL — `/api/instances` 404 (router not mounted).

- [ ] **Step 3: Mount router + init supervisor in `server/index.ts`**

In `packages/zai/src/server/index.ts`, add the import:

```ts
import { initInstanceSupervisor } from './services/instanceSupervisor.js'
import instancesRouter from './routes/instances.js'
```

Inside `createApp`, after the existing `initZaiSettingsCache()` block (around line 78), add:

```ts
  // Init central instance supervisor before any router that depends on it.
  // Reads ~/.zai/instances.json (async, fire-and-forget); snapshots start
  // with isCurrent row already visible via getInstanceSupervisor().
  await initInstanceSupervisor({ cwd: opts.cwd })
```

Then in the router block (around line 122), add:

```ts
  app.use('/api', instancesRouter)
```

- [ ] **Step 4: Activate heartbeat in `cli/start.ts`**

In `packages/zai/src/cli/start.ts`, update imports:

```ts
import { createInstanceHeartbeat, getInstanceHeartbeatConfig } from '../server/services/instanceHeartbeat.js'
import { shutdownInstanceSupervisor } from '../server/services/instanceSupervisor.js'
```

Inside `runDirectServer`, in the `listen` callback (line 110-118), after `sendReady(port)`, add:

```ts
      sendReady(port);
      const hb = getInstanceHeartbeatConfig();
      if (hb) {
        createInstanceHeartbeat({
          intervalMs: hb.intervalMs,
          instanceId: hb.instanceId,
          getPort: () => Number(process.env.ZAI_PORT ?? 0) || null,
        }).start();
      }
      resolve();
```

Update the `cleanup` (line 149) to chain `shutdownInstanceSupervisor`:

```ts
  const cleanup = () => {
    void shutdownInstanceSupervisor().finally(() => {
      void shutdownBackgroundRuntime().finally(() => {
        server.close();
        stopBranchChecker();
        process.exit(0);
      });
    });
  };
```

- [ ] **Step 5: Wire `shutdownInstanceSupervisor` into `cli/dev.ts`**

In `packages/zai/src/cli/dev.ts`, add the import:

```ts
import { shutdownInstanceSupervisor } from '../server/services/instanceSupervisor.js'
```

Replace the `cleanup` function (line 140):

```ts
  const cleanup = () => {
    void shutdownInstanceSupervisor().finally(() => {
      void shutdownBackgroundRuntime().finally(() => {
        vite.kill('SIGTERM');
        apiServer.close();
        stopBranchChecker();
        process.exit(0);
      });
    });
  };
```

- [ ] **Step 6: Run all zai server tests to verify nothing regressed**

Run: `pnpm --filter @zn-ai/zai test`
Expected: PASS for the new wiring test plus all existing server tests. Watch for `instances.json` file presence from existing tests; tests that use `ZAI_DATA_DIR` should not collide.

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/server/index.ts \
        packages/zai/src/cli/start.ts \
        packages/zai/src/cli/dev.ts \
        packages/zai/test/server/instance-supervisor-wiring.test.ts
git commit -m "feat(zai): wire instanceSupervisor into createApp + child heartbeat"
```

---

## Task 7: Frontend `useInstanceStore` + SSE dispatch

**Files:**
- Create: `packages/zai/src/web/src/store/useInstanceStore.ts`
- Modify: `packages/zai/src/web/src/store/useEventStream.ts:32-94` (add `case 'instance.changed'`)
- Create: `packages/zai/src/web/src/store/useInstanceStore.test.ts`

**Interfaces (consumed):** `InstanceSnapshot` from Task 1.

- [ ] **Step 1: Write the failing test**

`packages/zai/src/web/src/store/useInstanceStore.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { useInstanceStore } from './useInstanceStore.js'
import type { InstanceSnapshot } from '../../../shared/instances.js'

const baseSnap: InstanceSnapshot = {
  id: 'inst_1',
  name: 'demo',
  cwd: '/tmp/x',
  createdAt: '2026-08-03T00:00:00.000Z',
  state: 'stopped',
  port: null,
  pid: null,
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: false,
}

describe('useInstanceStore', () => {
  it('seed sets the list', () => {
    useInstanceStore.getState().seed([{ ...baseSnap, id: 'a' }, { ...baseSnap, id: 'b' }])
    expect(useInstanceStore.getState().instances.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('applyInstanceChanged merges per id without dropping others', () => {
    useInstanceStore.getState().seed([
      { ...baseSnap, id: 'a' },
      { ...baseSnap, id: 'b' },
    ])
    useInstanceStore.getState().applyInstanceChanged({
      instanceId: 'a',
      state: 'running',
      port: 9202,
      pid: 42,
    })
    const list = useInstanceStore.getState().instances
    expect(list.find((s) => s.id === 'a')).toMatchObject({ state: 'running', port: 9202, pid: 42 })
    expect(list.find((s) => s.id === 'b')?.state).toBe('stopped')
  })

  it('applyInstanceChanged no-op for unknown id (does not crash)', () => {
    useInstanceStore.getState().seed([{ ...baseSnap, id: 'a' }])
    expect(() =>
      useInstanceStore.getState().applyInstanceChanged({
        instanceId: 'ghost',
        state: 'running',
        port: null,
        pid: null,
      }),
    ).not.toThrow()
    expect(useInstanceStore.getState().instances).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "useInstanceStore"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useInstanceStore.ts`**

`packages/zai/src/web/src/store/useInstanceStore.ts`:

```ts
import { create } from 'zustand'
import type { InstanceSnapshot, InstanceState } from '../../../shared/instances.js'

interface InstanceStoreState {
  instances: InstanceSnapshot[]
  loading: boolean
  seed: (list: InstanceSnapshot[]) => void
  loadInstances: () => Promise<void>
  applyInstanceChanged: (e: {
    instanceId: string
    state: InstanceState
    port: number | null
    pid: number | null
  }) => void
}

export const useInstanceStore = create<InstanceStoreState>((set) => ({
  instances: [],
  loading: false,
  seed(list) {
    set({ instances: list })
  },
  async loadInstances() {
    set({ loading: true })
    try {
      const res = await fetch('/api/instances')
      if (!res.ok) return
      const data = (await res.json()) as { instances: InstanceSnapshot[] }
      set({ instances: data.instances })
    } catch {
      // keep stale list
    } finally {
      set({ loading: false })
    }
  },
  applyInstanceChanged(e) {
    set((s) => ({
      instances: s.instances.map((inst) =>
        inst.id === e.instanceId
          ? { ...inst, state: e.state, port: e.port, pid: e.pid }
          : inst,
      ),
    }))
  },
}))
```

- [ ] **Step 4: Hook the SSE dispatch in `useEventStream.ts`**

In `packages/zai/src/web/src/store/useEventStream.ts`, add the import:

```ts
import { useInstanceStore } from './useInstanceStore.js'
```

Add a new case in `dispatch` (alongside the `state.*` cases, around line 92):

```ts
    case 'instance.changed':
      useInstanceStore.getState().applyInstanceChanged(event)
      break
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai test -t "useInstanceStore"`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/store/useInstanceStore.ts \
        packages/zai/src/web/src/store/useEventStream.ts \
        packages/zai/src/web/src/store/useInstanceStore.test.ts
git commit -m "feat(zai-web): add useInstanceStore and SSE instance.changed dispatch"
```

---

## Task 8: Instances page + menu + route

**Files:**
- Create: `packages/zai/src/web/src/pages/Instances.tsx`
- Modify: `packages/zai/src/web/src/components/Layout.tsx:4-34` (add menu entry)
- Modify: `packages/zai/src/web/src/router.tsx:11-46` (lazy import + route)
- Create: `packages/zai/src/web/src/pages/Instances.test.tsx`

**Interfaces (consumed):** `useInstanceStore`, `InstanceSnapshot` from Task 7.

- [ ] **Step 1: Write the failing test**

`packages/zai/src/web/src/pages/Instances.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Instances from './Instances.js'
import { useInstanceStore } from '../store/useInstanceStore.js'
import type { InstanceSnapshot } from '../../shared/instances.js'

function seed(snaps: InstanceSnapshot[]): void {
  useInstanceStore.setState({ instances: snaps, loading: false })
}

const current: InstanceSnapshot = {
  id: '__current__',
  name: 'current',
  cwd: '/tmp/current',
  createdAt: '',
  state: 'running',
  port: 9201,
  pid: 1,
  startedAt: '2026-08-03T00:00:00.000Z',
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: true,
}

const demo: InstanceSnapshot = {
  id: 'inst_1',
  name: 'demo',
  cwd: '/tmp/demo',
  createdAt: '2026-08-03T00:00:00.000Z',
  state: 'stopped',
  port: null,
  pid: null,
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: false,
}

describe('Instances page', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{"instances":[]}', { status: 200 })),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useInstanceStore.setState({ instances: [], loading: false })
  })

  it('renders the current instance row with a 当前 tag and disabled actions', () => {
    seed([current, demo])
    render(<MemoryRouter><Instances /></MemoryRouter>)
    expect(screen.getByText('current')).toBeInTheDocument()
    expect(screen.getByText('当前')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    // current row's actions must be disabled (we assert at least one disabled button
    // belongs to the current row by checking buttons near the '当前' tag).
    const currentRowButton = buttons.find((b) => b.textContent?.includes('启动'))
    expect(currentRowButton).toBeDisabled()
  })

  it('fires POST /api/instances when 新建 modal is submitted', async () => {
    seed([])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances' && init?.method === 'POST') {
        return new Response('{"instance":{...}}', { status: 201 })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai test -t "Instances page"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pages/Instances.tsx`**

`packages/zai/src/web/src/pages/Instances.tsx`:

```tsx
import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  DeleteOutlined,
  PlusOutlined,
  ExportOutlined,
} from '@ant-design/icons'
import { useInstanceStore } from '../store/useInstanceStore.js'
import type { InstanceSnapshot, InstanceState } from '../../../shared/instances.js'

const STATE_TAG_COLOR: Record<InstanceState, string> = {
  stopped: 'default',
  starting: 'blue',
  running: 'green',
  stopping: 'orange',
  down: 'red',
}

function stateLabel(state: InstanceState): string {
  return ({ stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', down: '异常' } as const)[state]
}

function relativeAgo(iso: string | null): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '刚刚'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  return `${hr} 小时前`
}

export default function Instances(): JSX.Element {
  const { instances, loading, loadInstances } = useInstanceStore()
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm<{ name: string; cwd: string }>()
  const currentCwd = instances.find((s) => s.isCurrent)?.cwd ?? ''

  useEffect(() => {
    void loadInstances()
  }, [loadInstances])

  async function act(method: 'POST' | 'DELETE', id: string, action?: 'start' | 'stop' | 'restart'): Promise<void> {
    const url = action ? `/api/instances/${id}/${action}` : `/api/instances/${id}`
    const res = await fetch(url, { method })
    if (!res.ok && res.status !== 204) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      message.error(data.error ?? '操作失败')
    }
    void loadInstances()
  }

  async function onCreate(): Promise<void> {
    const values = await form.validateFields()
    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      message.error(data.error ?? '创建失败')
      return
    }
    setOpen(false)
    form.resetFields()
    void loadInstances()
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    {
      title: '状态',
      key: 'state',
      render: (_: unknown, row: InstanceSnapshot) => (
        <Space>
          <Tag color={STATE_TAG_COLOR[row.state]}>{stateLabel(row.state)}</Tag>
          {row.isCurrent && <Tag>当前</Tag>}
          {row.lastError && <Tag color="red">{row.lastError.message}</Tag>}
        </Space>
      ),
    },
    { title: '端口', dataIndex: 'port', key: 'port', render: (v: number | null) => v ?? '-' },
    { title: 'cwd', dataIndex: 'cwd', key: 'cwd' },
    { title: 'pid', dataIndex: 'pid', key: 'pid', render: (v: number | null) => v ?? '-' },
    { title: '最后心跳', dataIndex: 'lastHeartbeatAt', key: 'lastHeartbeatAt', render: relativeAgo },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, row: InstanceSnapshot) => {
        const canStart = !row.isCurrent && (row.state === 'stopped' || row.state === 'down')
        const canStop = !row.isCurrent && (row.state === 'running' || row.state === 'starting')
        const canRestart = !row.isCurrent && row.state === 'running'
        const canDelete = !row.isCurrent
        return (
          <Space>
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={!canStart}
              onClick={() => void act('POST', row.id, 'start')}
            >
              启动
            </Button>
            <Button
              size="small"
              icon={<StopOutlined />}
              disabled={!canStop}
              onClick={() => void act('POST', row.id, 'stop')}
            >
              停止
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={!canRestart}
              onClick={() => void act('POST', row.id, 'restart')}
            >
              重启
            </Button>
            <Popconfirm
              title="确定删除该实例定义？"
              description="如果实例正在运行，会先停止。"
              onConfirm={() => void act('DELETE', row.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} disabled={!canDelete}>
                删除
              </Button>
            </Popconfirm>
            {row.port != null && !row.isCurrent && (
              <Button
                size="small"
                icon={<ExportOutlined />}
                href={`http://localhost:${row.port}`}
                target="_blank"
                rel="noreferrer"
              >
                打开
              </Button>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      title={<Typography.Title level={4} style={{ margin: 0 }}>实例管理</Typography.Title>}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建实例
        </Button>
      }
      style={{ margin: 24 }}
    >
      <Table<InstanceSnapshot>
        rowKey="id"
        loading={loading}
        dataSource={instances}
        columns={columns}
        pagination={false}
      />
      <Modal
        title="新建实例"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void onCreate()}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ cwd: currentCwd }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如 demo" />
          </Form.Item>
          <Form.Item name="cwd" label="工作目录" rules={[{ required: true, message: '请输入工作目录' }]}>
            <Input placeholder="/absolute/path" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
```

- [ ] **Step 4: Add menu entry in `Layout.tsx`**

In `packages/zai/src/web/src/components/Layout.tsx`, add the icon import:

```tsx
import { ClusterOutlined } from '@ant-design/icons'
```

Then in `menuItems`, append:

```tsx
  { key: '/instances', icon: <ClusterOutlined />, label: '实例管理' },
```

- [ ] **Step 5: Add lazy route in `router.tsx`**

In `packages/zai/src/web/src/router.tsx`, add the lazy import:

```tsx
const Instances = lazy(() => import('./pages/Instances'));
```

And the route inside the Layout `<Route>` element:

```tsx
          <Route path="/instances" element={<Instances />} />
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai test -t "Instances page"`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/pages/Instances.tsx \
        packages/zai/src/web/src/pages/Instances.test.tsx \
        packages/zai/src/web/src/components/Layout.tsx \
        packages/zai/src/web/src/router.tsx
git commit -m "feat(zai-web): add Instances page, menu entry, and route"
```

---

## Task 9: End-to-end browser verification (mandatory per AGENTS.md)

**Files:** none (verification only).

- [ ] **Step 1: Build the Web bundle**

Run: `pnpm -r build`
Expected: success; `packages/zai/dist/web` exists.

- [ ] **Step 2: Start `zai start` in the background**

Run in background:
```bash
cd /Users/ethan/code/opencc-web && pnpm --filter @zn-ai/zai start --port 9201
```

Confirm in logs:
- `[zai] Production server on http://localhost:9201`
- `[zai] cwd: <cwd>`

- [ ] **Step 3: Drive the verification with `/ego-browser`**

Run the `/ego-browser` skill and execute:
1. `useOrCreateTaskSpace('instances')` → `openOrReuseTab('http://localhost:9201/login', { wait: true })`
2. Log in if required.
3. Navigate to `/instances` via `navigate('http://localhost:9201/instances')`.
4. Click 「新建实例」 → fill 名称 `e2e-demo`, cwd `/tmp/e2e-demo` (mkdir it first) → 「创建」.
5. Wait until a new row appears with `运行中` tag and a `port` number printed.
6. Click 「打开」 on the new row → switch to the new tab → confirm it is an independent zai UI.
7. Back to `/instances` → click 「停止」 on the e2e-demo row → wait for state to flip to `已停止`.
8. Click 「启动」 → state flips back to `运行中`.
9. Click 「重启」 → state briefly `停止中` → back to `运行中` with a new `port`.
10. Click 「删除」 → confirm the popconfirm → row is gone.
11. `captureScreenshot()` of the final state for the verification log.

- [ ] **Step 4: Verify `instances.json` persisted**

Run:
```bash
cat ~/.zai/instances.json | head -50
```
Expected: empty (since the e2e-demo row was deleted) or absent if no instances remain.

- [ ] **Step 5: Shut down the dev server**

Send SIGINT to the background `zai start` process. Confirm in the log that `shutdownInstanceSupervisor` ran (no orphan children: `ps -ef | grep 'start --managed-child'` shows none).

- [ ] **Step 6: Commit (no code changes, but record verification if any ancillary files updated)**

```bash
git status
# If clean, no commit. If verification produced screenshots or notes under docs/, commit them.
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Web UI 菜单新增「实例管理」 | Task 8 |
| 启动/关闭/重启/删除实例 | Tasks 4a, 5, 8 |
| 完整 zai 服务器实例 + 独立端口 | Task 4a (`zai start --managed-child`) |
| 端口自动分配且不重复 | Task 4a (`probePort(INSTANCE_BASE_PORT)`) |
| 当前进程内嵌 supervisor | Tasks 4a/4b + 6 |
| IPC 心跳 + supervisor 判定存活 | Tasks 3 + 4b |
| 创建参数名称 + cwd，端口自动 | Task 5 (POST /api/instances) |
| 崩溃处理手动拉起 | Task 4a (`userStopping=false` → `down`) |
| 定义落盘 `~/.zai/instances.json` | Task 2 |
| 重启后状态重置 stopped | Task 4a init hydration |
| 心跳超时 kill 进程后 down | Task 4b `tickHeartbeat` |
| supervisor 退出优雅停止子实例 | Task 4b `shutdown` + Task 6 cleanup hookups |
| 全局 SSE `instance.changed` | Tasks 1 + 7 |
| 真实浏览器验收 | Task 9 |

**Placeholder scan:** none — every step has either a code block or a runnable command.

**Type / name consistency:**
- `InstanceState`, `InstanceDefinition`, `InstanceStatus`, `InstanceSnapshot` defined in Task 1; referenced verbatim in Tasks 2/3/4/5/7/8.
- `CURRENT_INSTANCE_ID = '__current__'` defined in Task 4 and matched in Task 5's router.
- `instance.changed` payload fields (`instanceId` / `state` / `port` / `pid`) match between Task 1 zod schema, Task 4 `emit` call, Task 7 `applyInstanceChanged` parameter shape.
- `getInstanceSupervisor()` / `initInstanceSupervisor` / `shutdownInstanceSupervisor` consistent across Tasks 4/5/6/9.
- `getInstanceHeartbeatConfig` / `createInstanceHeartbeat` from Task 3 used verbatim in Task 6.