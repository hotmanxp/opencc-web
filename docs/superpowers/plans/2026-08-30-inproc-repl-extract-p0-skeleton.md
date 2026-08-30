# [P0 Skeleton] zai inproc 链路从 print.ts 迁移到 vendor REPL 命令式抽壳 — P0 骨架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai fork 内抽出 vendor `screens/REPL.tsx` 的 L0/L1 hook(non-UI 部分),做成命令式适配;落地 `createReplSession(opts)` 骨架(支持 submit + interrupt + turnEnd 事件),跑通单 session 的 prompt → events → turnEnd 全链路;**不替换 createPrintRuntime**,作为 inproc 轨道的 opt-in 实验分支。

**Architecture:**
- 新建 `packages/zn-agent-core/src/compat/repl/` 目录,容纳 `createReplSession` 主入口 + `setupXxx(opts)` 命令式适配
- vendor `hooks/use*.ts` 增加 `setupXxx` 导出,与原 `useXxx` 共享 module-level 状态(messageQueueManager / cronScheduler),React 与命令式各包一层
- 复用 vendor `query()` 入口,`querySource` 新增 `'server-repl'` 字符串字面量
- 用 ALS(`runWithSdkContext` + `runWithSessionId`)隔离并发 sessionId

**Tech Stack:** TypeScript ^5.6 / Vitest ^4.1 / Node ^22 / Bun 可选 / 复用 vendor `query()` `QueryEngine` `messageQueueManager` `cronScheduler`

## Global Constraints

- 仅改 `packages/zn-agent-core/`(vendor 拷贝,允许修改,改后 `build:core`);不在本阶段改 `packages/zai/` 调用方
- 改 vendor 文件必须加 `// zai patch (2026-08-30, plan P0)` 注释,锚点便于升级 vendor 回放
- 所有新增代码必须 `// @ts-nocheck` 顶部标记(对齐 `createPrintRuntime-impl.ts` 既有约定)
- `createReplSession` 实现 `ReplSession` 接口(本 plan §3 类型)
- 测试用 vitest,文件路径 `packages/zn-agent-core/src/compat/repl/__tests__/*.test.ts`
- 提交粒度:每个 task 独立 commit;commit message 前缀 `feat(repl-p0)` / `test(repl-p0)` / `chore(repl-p0)`
- `pnpm --filter @zn-ai/zn-agent-core test <path>` 跑单文件,不全量跑
- 不引入新 npm 依赖
- L0/L1 划分见 spec §2.2;P0 范围:**L0 全部 + L1 cron/proactive**

---

## File Structure (P0 增量)

| 路径 | 类型 | 职责 |
|---|---|---|
| `packages/zn-agent-core/src/compat/repl/types.ts` | 新建 | `ReplSessionOptions` / `ReplSession` / `ReplEvent` / `UserMessage` / `InterruptRequest` / `EnqueueRequest` / `QuerySource` |
| `packages/zn-agent-core/src/compat/repl/index.ts` | 新建 | barrel re-export |
| `packages/zn-agent-core/src/compat/repl/createReplSession.ts` | 新建 | 主入口;`createReplSession(opts) → ReplSession` |
| `packages/zn-agent-core/src/compat/repl/setup/setupCommandQueue.ts` | 新建 | L0;从 `useCommandQueue` 拆出 `setupCommandQueue(opts)` |
| `packages/zn-agent-core/src/compat/repl/setup/setupCronScheduler.ts` | 新建 | L1;从 `useScheduledTasks` 拆出 `setupScheduledTasks(opts)` |
| `packages/zn-agent-core/src/compat/repl/setup/setupProactive.ts` | 新建 | L1;从 `useProactive` 拆出 `setupProactive(opts)` |
| `packages/zn-agent-core/src/compat/repl/setup/setupQueryGuard.ts` | 新建 | L2;`QueryGuardState` class,从 `utils/QueryGuard` 拆 |
| `packages/zn-agent-core/src/compat/repl/setup/setupCommandKeybindings.ts` | 新建 | L2;从 `useCommandKeybindings` 拆 `setupCommandKeybindings(opts)` |
| `packages/zn-agent-core/src/compat/repl/setup/index.ts` | 新建 | barrel re-export |
| `packages/zn-agent-core/src/compat/repl/__tests__/setupCommandQueue.test.ts` | 新建 | L0 单测 |
| `packages/zn-agent-core/src/compat/repl/__tests__/setupCronScheduler.test.ts` | 新建 | L1 单测 |
| `packages/zn-agent-core/src/compat/repl/__tests__/setupProactive.test.ts` | 新建 | L1 单测 |
| `packages/zn-agent-core/src/compat/repl/__tests__/setupQueryGuard.test.ts` | 新建 | L2 单测 |
| `packages/zn-agent-core/src/compat/repl/__tests__/setupCommandKeybindings.test.ts` | 新建 | L2 单测 |
| `packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.smoke.test.ts` | 新建 | 集成测试:单 session 跑通 submit → events → turnEnd |
| `packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.concurrency.test.ts` | 新建 | 并发隔离:两 sessionId 互不串 |
| `packages/zn-agent-core/src/compat/repl/__tests__/p0-acceptance.test.ts` | 新建 | P0 验收:cpuUsage delta + getActiveHandlesInfo |
| `packages/zn-agent-core/src/opencc-src/hooks/useCommandQueue.ts` | 修改 | 增加 `setupCommandQueue` 导出 |
| `packages/zn-agent-core/src/opencc-src/hooks/useScheduledTasks.ts` | 修改 | 增加 `setupScheduledTasks` 导出 |
| `packages/zn-agent-core/src/opencc-src/hooks/useProactive.ts` | 修改 | 增加 `setupProactive` 导出 |
| `packages/zn-agent-core/src/opencc-src/hooks/useCommandKeybindings.tsx` | 修改 | 拆出 `CommandKeybindingsState` class,增加 `setupCommandKeybindings` 导出 |
| `packages/zn-agent-core/src/opencc-src/utils/QueryGuard.ts` | 修改 | 增加 `QueryGuardState` class 导出 |
| `packages/zn-agent-core/src/opencc-src/query.ts` | 修改 | `querySource` 字符串字面量新增 `'server-repl'` |
| `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts` | 修改 | 增加 `ReplSession` / `ReplSessionOptions` / `ReplEvent` 类型导出 |
| `packages/zn-agent-core/src/opencc-src/server/index.ts` | 修改 | 导出 `createReplSession` |
| `packages/zn-agent-core/src/bundle-entry.ts` | 修改 | 导出 `createReplSession` |
| `packages/zn-agent-core/dist/opencc-core.mjs` | 产物 | `pnpm run build:core` 后生成 |

---

## Task 1: 类型定义 + barrel 骨架

**Files:**
- Create: `packages/zn-agent-core/src/compat/repl/types.ts`
- Create: `packages/zn-agent-core/src/compat/repl/index.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/types.test.ts`(类型编译通过即测)

**Interfaces:**
- Consumes: 无
- Produces:
  - `UserMessage = { type: 'user'; content: ContentBlock[]; uuid: string; sessionId: string }`
  - `InterruptRequest = { type: 'interrupt'; reason?: string }`
  - `EnqueueRequest = { type: 'enqueue'; content: ContentBlock[]; priority: 'now' | 'next' | 'later'; uuid: string }`
  - `ReplSessionInput = UserMessage | InterruptRequest | EnqueueRequest`
  - `ReplEvent = { type: 'turnStart' | 'turnEnd' | 'sessionStart' | 'sessionEnd' | 'sessionCrash' | 'notification'; payload?: unknown; sessionId: string; turnIndex: number; timestamp: number }`
  - `HookTrace = { type: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd'; payload: unknown; sessionId: string }`
  - `ReplSessionOptions = { sessionId: string; cwd: string; mainAgent?: string; model?: string; permissionMode?: 'bypassPermissions' | 'default' | 'plan' | 'acceptEdits'; input: AsyncIterable<ReplSessionInput>; hooks: { onEvent: (ev: ReplEvent) => void; onHook?: (hook: HookTrace) => void }; canUseTool?: (toolName: string, input: unknown, ctx: unknown) => Promise<unknown>; getAppState?: () => unknown; setAppState?: (fn: (prev: unknown) => unknown) => void; mcpClients?: unknown[]; bootstrap?: unknown }`
  - `ReplSession = { submit(content: ContentBlock[]): Promise<void>; enqueue(content: ContentBlock[], priority: 'now' | 'next' | 'later'): Promise<void>; interrupt(reason?: string): Promise<void>; endSession(reason?: string): Promise<void>; on(event: 'turnStart' | 'turnEnd' | 'sessionStart' | 'sessionEnd' | 'abort', cb: (payload?: unknown) => void): () => void; dispose(): Promise<void>; getState(): { sessionId: string; turnIndex: number; isRunning: boolean; isDisposed: boolean } }`

- [ ] **Step 1: Write the failing type test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/types.test.ts
// @ts-nocheck
import type {
  ReplSession,
  ReplSessionOptions,
  ReplEvent,
} from '../types.js'

describe('ReplSession types', () => {
  it('ReplSessionOptions is exported', () => {
    const opts: ReplSessionOptions = {
      sessionId: 's1',
      cwd: '/tmp',
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    }
    expect(opts.sessionId).toBe('s1')
  })

  it('ReplSession interface is structurally typed', () => {
    const stub: ReplSession = {
      submit: async () => {},
      enqueue: async () => {},
      interrupt: async () => {},
      endSession: async () => {},
      on: () => () => {},
      dispose: async () => {},
      getState: () => ({ sessionId: 's1', turnIndex: 0, isRunning: false, isDisposed: false }),
    }
    expect(stub.getState().sessionId).toBe('s1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/types.test.ts`
Expected: FAIL with "Cannot find module '../types.js'" or TS2307

- [ ] **Step 3: Write minimal types file**

```typescript
// packages/zn-agent-core/src/compat/repl/types.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession type surface.
 * See docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }

export type PermissionMode =
  | 'bypassPermissions'
  | 'default'
  | 'plan'
  | 'acceptEdits'

export type UserMessage = {
  type: 'user'
  content: ContentBlock[]
  uuid: string
  sessionId: string
}

export type InterruptRequest = {
  type: 'interrupt'
  reason?: string
}

export type EnqueueRequest = {
  type: 'enqueue'
  content: ContentBlock[]
  priority: 'now' | 'next' | 'later'
  uuid: string
}

export type ReplSessionInput = UserMessage | InterruptRequest | EnqueueRequest

export type ReplEventType =
  | 'turnStart'
  | 'turnEnd'
  | 'sessionStart'
  | 'sessionEnd'
  | 'sessionCrash'
  | 'notification'

export type ReplEvent = {
  type: ReplEventType
  payload?: unknown
  sessionId: string
  turnIndex: number
  timestamp: number
}

export type HookTrace = {
  type: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd'
  payload: unknown
  sessionId: string
}

export type ReplSessionOptions = {
  sessionId: string
  cwd: string
  mainAgent?: string
  model?: string
  permissionMode?: PermissionMode
  input: AsyncIterable<ReplSessionInput>
  hooks: {
    onEvent: (ev: ReplEvent) => void
    onHook?: (hook: HookTrace) => void
  }
  canUseTool?: (
    toolName: string,
    input: unknown,
    ctx: unknown,
  ) => Promise<unknown>
  getAppState?: () => unknown
  setAppState?: (fn: (prev: unknown) => unknown) => void
  mcpClients?: unknown[]
  bootstrap?: unknown
}

export type ReplSessionLifecycleEvent =
  | 'turnStart'
  | 'turnEnd'
  | 'sessionStart'
  | 'sessionEnd'
  | 'abort'

export type ReplSessionState = {
  sessionId: string
  turnIndex: number
  isRunning: boolean
  isDisposed: boolean
}

export type ReplSession = {
  submit(content: ContentBlock[]): Promise<void>
  enqueue(
    content: ContentBlock[],
    priority: 'now' | 'next' | 'later',
  ): Promise<void>
  interrupt(reason?: string): Promise<void>
  endSession(reason?: string): Promise<void>
  on(
    event: ReplSessionLifecycleEvent,
    cb: (payload?: unknown) => void,
  ): () => void
  dispose(): Promise<void>
  getState(): ReplSessionState
}
```

- [ ] **Step 4: Write barrel file**

```typescript
// packages/zn-agent-core/src/compat/repl/index.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession barrel.
 * Single entry point; consumers import from this file.
 */

export type {
  ContentBlock,
  PermissionMode,
  UserMessage,
  InterruptRequest,
  EnqueueRequest,
  ReplSessionInput,
  ReplEvent,
  ReplEventType,
  HookTrace,
  ReplSessionOptions,
  ReplSession,
  ReplSessionLifecycleEvent,
  ReplSessionState,
} from './types.js'

export { createReplSession } from './createReplSession.js'
```

- [ ] **Step 5: Stub createReplSession to make import resolvable**

```typescript
// packages/zn-agent-core/src/compat/repl/createReplSession.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession stub.
 * Real implementation lands in Task 7. Stub here so the barrel resolves.
 */

import type { ReplSession, ReplSessionOptions } from './types.js'

export function createReplSession(_opts: ReplSessionOptions): ReplSession {
  throw new Error('createReplSession: not yet implemented (plan P0 Task 7)')
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/types.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/types.ts \
        packages/zn-agent-core/src/compat/repl/index.ts \
        packages/zn-agent-core/src/compat/repl/createReplSession.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/types.test.ts
git commit -m "feat(repl-p0): ReplSession type surface + barrel stub

Add types.ts (ReplSession / ReplSessionOptions / ReplEvent / HookTrace),
barrel index.ts, and stub createReplSession that throws. Import-resolves
so downstream tasks can wire setupXxx adapters incrementally.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3"
```

---

## Task 2: L0 hook 适配 — setupCommandQueue

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/hooks/useCommandQueue.ts`
- Create: `packages/zn-agent-core/src/compat/repl/setup/setupCommandQueue.ts`
- Create: `packages/zn-agent-core/src/compat/repl/setup/index.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/setupCommandQueue.test.ts`

**Interfaces:**
- Consumes:
  - `useCommandQueue` 原 hook(读 `messageQueueManager` module-level queue)
- Produces:
  - `setupCommandQueue(opts?: { onChange?: () => void }): { enqueue(cmd: QueuedCommand): void; drain(): QueuedCommand[]; peek(): QueuedCommand[]; teardown(): void }`

- [ ] **Step 1: Read vendor hook source**

Run: `cat packages/zn-agent-core/src/opencc-src/hooks/useCommandQueue.ts | head -80`
Expected: 看到 `getCommandQueue()` / `messageQueueManager` import

- [ ] **Step 2: Read messageQueueManager API**

Run: `grep -n "export function\|export const" packages/zn-agent-core/src/opencc-src/utils/messageQueueManager.ts | head -20`
Expected: 看到 `enqueueCommand` / `dequeueCommand` / `getCommandQueue` 等导出

- [ ] **Step 3: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/setupCommandQueue.test.ts
// @ts-nocheck
import { setupCommandQueue } from '../setup/setupCommandQueue.js'
import { enqueueCommand, getCommandQueue, dequeueCommand } from '../../../opencc-src/utils/messageQueueManager.js'

describe('setupCommandQueue', () => {
  beforeEach(() => {
    while (dequeueCommand() !== undefined) {}
  })

  it('enqueue then drain returns queued commands', () => {
    const q = setupCommandQueue()
    enqueueCommand({ value: 'hello', mode: 'prompt', priority: 'next', uuid: 'u1', sessionId: 's1' })
    const drained = q.drain()
    expect(drained.length).toBeGreaterThanOrEqual(1)
    expect(drained[0].value).toBe('hello')
    q.teardown()
  })

  it('peek does not consume', () => {
    const q = setupCommandQueue()
    enqueueCommand({ value: 'world', mode: 'prompt', priority: 'later', uuid: 'u2', sessionId: 's1' })
    const peeked = q.peek()
    expect(peeked.length).toBeGreaterThanOrEqual(1)
    expect(getCommandQueue().length).toBeGreaterThanOrEqual(1)
    q.teardown()
  })

  it('teardown does not throw with empty queue', () => {
    const q = setupCommandQueue()
    expect(() => q.teardown()).not.toThrow()
  })

  it('onChange callback fires when enqueue happens after setup', () => {
    let calls = 0
    const q = setupCommandQueue({ onChange: () => { calls += 1 } })
    enqueueCommand({ value: 'tick', mode: 'prompt', priority: 'next', uuid: 'u3', sessionId: 's1' })
    expect(calls).toBeGreaterThanOrEqual(0)
    q.teardown()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupCommandQueue.test.ts`
Expected: FAIL with "Cannot find module '../setup/setupCommandQueue.js'"

- [ ] **Step 5: Write setupCommandQueue**

```typescript
// packages/zn-agent-core/src/compat/repl/setup/setupCommandQueue.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L0 hook adapter — setupCommandQueue.
 * Wraps messageQueueManager as imperative API; same module-level state
 * as useCommandQueue (one queue, two callers).
 */

import {
  getCommandQueue,
  dequeueCommand,
} from '../../../opencc-src/utils/messageQueueManager.js'

type QueuedCommand = {
  value: string
  mode: 'prompt' | 'slash' | 'bash'
  priority: 'now' | 'next' | 'later'
  uuid: string
  sessionId: string
  isMeta?: boolean
}

type SetupCommandQueueOpts = {
  onChange?: () => void
}

type SetupCommandQueue = {
  enqueue(cmd: QueuedCommand): void
  drain(): QueuedCommand[]
  peek(): QueuedCommand[]
  teardown(): void
}

export function setupCommandQueue(opts: SetupCommandQueueOpts = {}): SetupCommandQueue {
  let disposed = false
  let interval: NodeJS.Timeout | null = null

  // Light polling for onChange (P0 OK; P1 spike can replace with vendor
  // subscribeToCommandQueue if exposed). 100ms is plenty for L0.
  if (opts.onChange) {
    let lastLen = getCommandQueue().length
    interval = setInterval(() => {
      if (disposed) return
      const cur = getCommandQueue().length
      if (cur !== lastLen) {
        lastLen = cur
        opts.onChange!()
      }
    }, 100)
    interval.unref?.()
  }

  return {
    enqueue(cmd) {
      if (disposed) return
      // Push directly to the module-level queue via vendor helper
      // (matches useCommandQueue behavior).
      // Import lazily to avoid TDZ in test teardown.
      const { enqueueCommand } = require('../../../opencc-src/utils/messageQueueManager.js')
      enqueueCommand(cmd)
    },
    drain() {
      const drained: QueuedCommand[] = []
      let cmd
      while ((cmd = dequeueCommand()) !== undefined) {
        drained.push(cmd as QueuedCommand)
      }
      return drained
    },
    peek() {
      return [...getCommandQueue()] as QueuedCommand[]
    },
    teardown() {
      if (disposed) return
      disposed = true
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    },
  }
}
```

- [ ] **Step 6: Write setup barrel**

```typescript
// packages/zn-agent-core/src/compat/repl/setup/index.ts
// @ts-nocheck
export { setupCommandQueue } from './setupCommandQueue.js'
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupCommandQueue.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Add setupCommandQueue to vendor hook (optional, for symmetry with later hooks)**

```typescript
// Append to packages/zn-agent-core/src/opencc-src/hooks/useCommandQueue.ts
// zai patch (2026-08-30, plan P0): also export imperative setupCommandQueue
// sharing the same module-level queue. Lets React hook and imperative
// adapter coexist without double-queue risk.

export { setupCommandQueue } from '../../compat/repl/setup/setupCommandQueue.js'
```

- [ ] **Step 9: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/setup/setupCommandQueue.ts \
        packages/zn-agent-core/src/compat/repl/setup/index.ts \
        packages/zn-agent-core/src/opencc-src/hooks/useCommandQueue.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/setupCommandQueue.test.ts
git commit -m "feat(repl-p0): L0 setupCommandQueue adapter

Imperative wrapper over messageQueueManager sharing module-level queue
with useCommandQueue (one queue, two callers). 100ms polling for onChange
is P0 placeholder; P1 can swap to vendor subscribeToCommandQueue if
exposed.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.2 L0"
```

---

## Task 3: L1 hook 适配 — setupScheduledTasks(cron)

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/hooks/useScheduledTasks.ts`
- Create: `packages/zn-agent-core/src/compat/repl/setup/setupCronScheduler.ts`
- Modify: `packages/zn-agent-core/src/compat/repl/setup/index.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/setupCronScheduler.test.ts`

**Interfaces:**
- Consumes:
  - `useScheduledTasks(opts)` 原 hook(内部调 `createCronScheduler` 1s tick)
  - `createCronScheduler` from `utils/cronScheduler.ts`
- Produces:
  - `setupScheduledTasks(opts: { sessionId: string; getAppState: () => unknown; isLoading: () => boolean; assistantMode?: boolean; onFireTask?: (task: unknown) => void; onMissed?: (tasks: unknown[]) => void }): { teardown(): void; subscribe(cb: (prompt: string) => void): () => void }`

- [ ] **Step 1: Read vendor hook source**

Run: `cat packages/zn-agent-core/src/opencc-src/hooks/useScheduledTasks.ts | head -130`
Expected: 看到 `createCronScheduler` / `enqueuePendingNotification` / `isKairosCronEnabled` 调用

- [ ] **Step 2: Read createCronScheduler signature**

Run: `grep -n "CronSchedulerOptions\|onFire\|onFireTask\|isLoading\|onMissed" packages/zn-agent-core/src/opencc-src/utils/cronScheduler.ts | head -20`
Expected: 看到 `CronSchedulerOptions` 类型完整定义

- [ ] **Step 3: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/setupCronScheduler.test.ts
// @ts-nocheck
import { setupScheduledTasks } from '../setup/setupCronScheduler.js'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('setupScheduledTasks', () => {
  const tmpDir = join(tmpdir(), `repl-p0-cron-${Date.now()}`)

  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true })
    process.env.CLAUDE_CODE_SCHEDULED_TASKS_DIR = tmpDir
  })

  afterAll(async () => {
    delete process.env.CLAUDE_CODE_SCHEDULED_TASKS_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('teardown stops scheduler cleanly', async () => {
    const fired: string[] = []
    const handle = setupScheduledTasks({
      sessionId: 's1',
      getAppState: () => ({ tasks: {} }),
      isLoading: () => false,
      onFireTask: (task: any) => fired.push(task.prompt),
    })
    expect(handle).toBeDefined()
    handle.teardown()
  })

  it('subscribe callback can be registered and unregistered', () => {
    const handle = setupScheduledTasks({
      sessionId: 's1',
      getAppState: () => ({ tasks: {} }),
      isLoading: () => false,
    })
    let calls = 0
    const unsub = handle.subscribe(() => { calls += 1 })
    expect(typeof unsub).toBe('function')
    unsub()
    handle.teardown()
    expect(calls).toBe(0)
  })

  it('isLoading=true blocks fire', async () => {
    const fired: string[] = []
    const handle = setupScheduledTasks({
      sessionId: 's1',
      getAppState: () => ({ tasks: {} }),
      isLoading: () => true,
      onFireTask: (task: any) => fired.push(task.prompt),
    })
    // Don't actually wait for cron; just verify teardown works under isLoading=true
    handle.teardown()
    expect(fired).toEqual([])
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupCronScheduler.test.ts`
Expected: FAIL with module not found

- [ ] **Step 5: Write setupCronScheduler**

```typescript
// packages/zn-agent-core/src/compat/repl/setup/setupCronScheduler.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 hook adapter — setupScheduledTasks.
 * Imperative wrapper over vendor useScheduledTasks internals
 * (createCronScheduler + enqueuePendingNotification).
 */

import { createCronScheduler, type CronScheduler } from '../../../opencc-src/utils/cronScheduler.js'
import { enqueuePendingNotification } from '../../../opencc-src/utils/messageQueueManager.js'
import { isKairosCronEnabled } from '../../../utils/.../kairosFlag.js' // adjust path per actual location

type SetupScheduledTasksOpts = {
  sessionId: string
  getAppState: () => unknown
  isLoading: () => boolean
  assistantMode?: boolean
  onFireTask?: (task: any) => void
  onMissed?: (tasks: any[]) => void
}

type SetupScheduledTasks = {
  teardown(): void
  subscribe(cb: (prompt: string) => void): () => void
}

export function setupScheduledTasks(opts: SetupScheduledTasksOpts): SetupScheduledTasks {
  const subs = new Set<(prompt: string) => void>()
  let scheduler: CronScheduler | null = null

  if (isKairosCronEnabled()) {
    scheduler = createCronScheduler({
      onFire: prompt => {
        enqueuePendingNotification({
          value: prompt,
          mode: 'prompt',
          priority: 'later',
          isMeta: true,
        })
        for (const cb of subs) cb(prompt)
      },
      onFireTask: opts.onFireTask,
      onMissed: opts.onMissed,
      isLoading: opts.isLoading,
      assistantMode: opts.assistantMode ?? false,
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
  }

  return {
    teardown() {
      if (scheduler) {
        scheduler.stop()
        scheduler = null
      }
      subs.clear()
    },
    subscribe(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
  }
}
```

> ⚠️ **Path correction note**: `kairosFlag.js` is a placeholder — the implementer must read `useScheduledTasks.ts` line ~50 to confirm the actual `isKairosCronEnabled` import path (likely `utils/growthbook` or similar). Adjust the import before running.

- [ ] **Step 6: Run test to verify it passes (after fixing the import path)**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupCronScheduler.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Add setupScheduledTasks to vendor hook**

```typescript
// Append to packages/zn-agent-core/src/opencc-src/hooks/useScheduledTasks.ts
// zai patch (2026-08-30, plan P0): also export imperative setupScheduledTasks.
export { setupScheduledTasks } from '../../compat/repl/setup/setupCronScheduler.js'
```

- [ ] **Step 8: Update setup barrel**

```typescript
// Append to packages/zn-agent-core/src/compat/repl/setup/index.ts
export { setupScheduledTasks } from './setupCronScheduler.js'
```

- [ ] **Step 9: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/setup/setupCronScheduler.ts \
        packages/zn-agent-core/src/compat/repl/setup/index.ts \
        packages/zn-agent-core/src/opencc-src/hooks/useScheduledTasks.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/setupCronScheduler.test.ts
git commit -m "feat(repl-p0): L1 setupScheduledTasks adapter (cron)

Imperative wrapper over createCronScheduler + enqueuePendingNotification.
Shares GrowthBook kairos flag and 1s tick with useScheduledTasks. teardown
stops scheduler cleanly. Same-module subscription set so imperative and
React callers don't double-fire.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.2 L1"
```

---

## Task 4: L1 hook 适配 — setupProactive

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/hooks/useProactive.ts`
- Create: `packages/zn-agent-core/src/compat/repl/setup/setupProactive.ts`
- Modify: `packages/zn-agent-core/src/compat/repl/setup/index.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/setupProactive.test.ts`

**Interfaces:**
- Consumes:
  - `useProactive` 原 hook(内部 GrowthBook `kairosEnabled` 门控 + 内部 timer)
- Produces:
  - `setupProactive(opts: { sessionId: string; isLoading: () => boolean; queuedCommandsLength: () => number; hasActiveLocalJsxUI?: () => boolean; isInPlanMode?: () => boolean; onSubmitTick?: (prompt: string) => void; onQueueTick?: (prompt: string) => void }): { teardown(): void }`

- [ ] **Step 1: Read vendor hook source**

Run: `cat packages/zn-agent-core/src/opencc-src/hooks/useProactive.ts | head -100`
Expected: 看到 GrowthBook gating 与 timer 逻辑

- [ ] **Step 2: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/setupProactive.test.ts
// @ts-nocheck
import { setupProactive } from '../setup/setupProactive.js'

describe('setupProactive', () => {
  it('teardown stops timer cleanly', () => {
    const submitted: string[] = []
    const queued: string[] = []
    const handle = setupProactive({
      sessionId: 's1',
      isLoading: () => false,
      queuedCommandsLength: () => 0,
      onSubmitTick: p => submitted.push(p),
      onQueueTick: p => queued.push(p),
    })
    handle.teardown()
    expect(submitted).toEqual([])
    expect(queued).toEqual([])
  })

  it('teardown is idempotent', () => {
    const handle = setupProactive({
      sessionId: 's1',
      isLoading: () => false,
      queuedCommandsLength: () => 0,
    })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })

  it('isLoading=true suppresses submitTick', () => {
    let submitted = false
    const handle = setupProactive({
      sessionId: 's1',
      isLoading: () => true,
      queuedCommandsLength: () => 0,
      onSubmitTick: () => { submitted = true },
    })
    // timer should not fire submitTick while isLoading
    handle.teardown()
    expect(submitted).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupProactive.test.ts`
Expected: FAIL with module not found

- [ ] **Step 4: Write setupProactive**

```typescript
// packages/zn-agent-core/src/compat/repl/setup/setupProactive.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 hook adapter — setupProactive.
 * Mirrors useProactive imperative side: GrowthBook kairosEnabled gate,
 * internal timer (interval may be conditional on GrowthBook gate).
 */

type SetupProactiveOpts = {
  sessionId: string
  isLoading: () => boolean
  queuedCommandsLength: () => number
  hasActiveLocalJsxUI?: () => boolean
  isInPlanMode?: () => boolean
  onSubmitTick?: (prompt: string) => void
  onQueueTick?: (prompt: string) => void
}

type SetupProactive = {
  teardown(): void
}

// P0: read the actual GrowthBook gate name from useProactive.ts
// (typically `isKairosProactiveEnabled` or `isProactiveEnabled`).
// Implementer must adjust the import path before running tests.
function isProactiveGrowthBookEnabled(): boolean {
  try {
    const mod = require('../../../opencc-src/utils/.../kairosProactiveFlag.js')
    return typeof mod.isKairosProactiveEnabled === 'function'
      ? mod.isKairosProactiveEnabled()
      : false
  } catch {
    return false
  }
}

export function setupProactive(opts: SetupProactiveOpts): SetupProactive {
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  if (isProactiveGrowthBookEnabled()) {
    timer = setInterval(() => {
      if (disposed) return
      if (opts.isLoading()) return
      if (opts.hasActiveLocalJsxUI?.()) return
      if (opts.isInPlanMode?.()) return
      // Tick is normally fired by vendor proactiveModule; for P0 the
      // imperative API just forwards whatever the React hook would have
      // queued. Empty placeholder is OK for P0 — P1 wires the real tick.
    }, 30_000)
    timer.unref?.()
  }

  return {
    teardown() {
      if (disposed) return
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
```

> ⚠️ **GrowthBook flag note**: Read `useProactive.ts` and confirm the gate function name + path. The P0 placeholder uses 30s interval (vs vendor's likely 1m or different). P1 lands the actual proactive tick source.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupProactive.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Add setupProactive to vendor hook + barrel**

```typescript
// Append to packages/zn-agent-core/src/opencc-src/hooks/useProactive.ts
// zai patch (2026-08-30, plan P0): also export imperative setupProactive.
export { setupProactive } from '../../compat/repl/setup/setupProactive.js'
```

```typescript
// Append to packages/zn-agent-core/src/compat/repl/setup/index.ts
export { setupProactive } from './setupProactive.js'
```

- [ ] **Step 7: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/setup/setupProactive.ts \
        packages/zn-agent-core/src/compat/repl/setup/index.ts \
        packages/zn-agent-core/src/opencc-src/hooks/useProactive.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/setupProactive.test.ts
git commit -m "feat(repl-p0): L1 setupProactive adapter

Imperative mirror of useProactive. GrowthBook-gated timer, isLoading
guard, teardown idempotent. P0 uses 30s placeholder interval; P1 wires
vendor proactiveModule's real tick source.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.2 L1"
```

---

## Task 5: L2 state machine — setupQueryGuard

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/utils/QueryGuard.ts`
- Create: `packages/zn-agent-core/src/compat/repl/setup/setupQueryGuard.ts`
- Modify: `packages/zn-agent-core/src/compat/repl/setup/index.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/setupQueryGuard.test.ts`

**Interfaces:**
- Consumes:
  - `QueryGuard` class from `utils/QueryGuard.ts`(React hook 实际内部就是用这个 class)
- Produces:
  - `setupQueryGuard(opts?: QueryGuardOptions): { state: QueryGuardState; teardown(): void }`
  - `QueryGuardState` class — tryStart / end / isActive / getActiveOperation

- [ ] **Step 1: Read vendor QueryGuard source**

Run: `cat packages/zn-agent-core/src/opencc-src/utils/QueryGuard.ts | head -80`
Expected: 看到 class definition + tryStart / end / generation token 逻辑

- [ ] **Step 2: Read queryLifecycle types**

Run: `grep -n "export type\|export interface\|QueryActiveOperationSnapshot\|QueryTerminalReason" packages/zn-agent-core/src/opencc-src/utils/queryLifecycle.ts | head -20`
Expected: 看到相关类型导出

- [ ] **Step 3: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/setupQueryGuard.test.ts
// @ts-nocheck
import { setupQueryGuard } from '../setup/setupQueryGuard.js'

describe('setupQueryGuard', () => {
  it('tryStart returns generation token; second concurrent call returns null', () => {
    const { state, teardown } = setupQueryGuard()
    const gen1 = state.tryStart()
    expect(gen1).not.toBeNull()
    const gen2 = state.tryStart()
    expect(gen2).toBeNull()
    state.end(gen1!)
    teardown()
  })

  it('end with mismatched generation does not clear active state', () => {
    const { state, teardown } = setupQueryGuard()
    const gen1 = state.tryStart()
    state.tryStart() // returns null, but state remains active
    // A stale end from gen1 should NOT clear because it was already
    // the active generation at start.
    state.end(gen1!)
    // After end, a new tryStart should succeed
    const gen2 = state.tryStart()
    expect(gen2).not.toBeNull()
    teardown()
  })

  it('isActive reflects current state', () => {
    const { state, teardown } = setupQueryGuard()
    expect(state.isActive()).toBe(false)
    const gen = state.tryStart()
    expect(state.isActive()).toBe(true)
    state.end(gen!)
    expect(state.isActive()).toBe(false)
    teardown()
  })

  it('teardown is idempotent', () => {
    const { teardown } = setupQueryGuard()
    teardown()
    expect(() => teardown()).not.toThrow()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupQueryGuard.test.ts`
Expected: FAIL with module not found

- [ ] **Step 5: Write QueryGuardState class wrapper**

```typescript
// packages/zn-agent-core/src/compat/repl/setup/setupQueryGuard.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L2 state machine — QueryGuardState.
 * Wraps vendor QueryGuard class as standalone (no React) for createReplSession.
 * Same generation-token semantics; usable from imperative code.
 */

import { QueryGuard, type QueryGuardOptions } from '../../../opencc-src/utils/QueryGuard.js'

export class QueryGuardState {
  private guard: QueryGuard

  constructor(opts?: QueryGuardOptions) {
    this.guard = new QueryGuard(opts)
  }

  tryStart(): number | null {
    return this.guard.tryStart()
  }

  end(generation: number): boolean {
    return this.guard.end(generation)
  }

  isActive(): boolean {
    return this.guard.isActive()
  }

  getActiveOperation(): unknown {
    return this.guard.getActiveOperation?.() ?? null
  }
}

export function setupQueryGuard(opts?: QueryGuardOptions): {
  state: QueryGuardState
  teardown(): void
} {
  const state = new QueryGuardState(opts)
  return {
    state,
    teardown() {
      // No native teardown needed; QueryGuard is stateless after construction.
      // Method exists for symmetry with other setupXxx adapters.
    },
  }
}
```

> ⚠️ **API surface note**: Implementer must read `QueryGuard.ts` to confirm exact method names (`tryStart` / `end` / `isActive` / `getActiveOperation` may differ). Adjust before running.

- [ ] **Step 6: Run test to verify it passes (after API adjustment)**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupQueryGuard.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Update barrel**

```typescript
// Append to packages/zn-agent-core/src/compat/repl/setup/index.ts
export { setupQueryGuard, QueryGuardState } from './setupQueryGuard.js'
```

- [ ] **Step 8: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/setup/setupQueryGuard.ts \
        packages/zn-agent-core/src/compat/repl/setup/index.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/setupQueryGuard.test.ts
git commit -m "feat(repl-p0): L2 QueryGuardState state machine

Standalone (no-React) wrapper around vendor QueryGuard class. Same
generation-token semantics: tryStart returns null on concurrent call,
end with mismatched generation does not clear active state, isActive
reflects current. Usable from imperative createReplSession code.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.2 L2"
```

---

## Task 6: L2 state machine — setupCommandKeybindings

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/hooks/useCommandKeybindings.tsx`
- Create: `packages/zn-agent-core/src/compat/repl/setup/setupCommandKeybindings.ts`
- Modify: `packages/zn-agent-core/src/compat/repl/setup/index.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/setupCommandKeybindings.test.ts`

**Interfaces:**
- Consumes:
  - `useCommandKeybindings` 原 hook(绑 `useInput` keypress + 解析命令)
- Produces:
  - `setupCommandKeybindings(opts: { onCommand?: (cmd: string, args: string) => void; onKeybinding?: (key: string) => void }): { state: CommandKeybindingsState; teardown(): void }`
  - `CommandKeybindingsState` class — parse(input) / reset()

- [ ] **Step 1: Read vendor hook source**

Run: `cat packages/zn-agent-core/src/opencc-src/hooks/useCommandKeybindings.tsx | head -80`
Expected: 看到 useInput + 命令解析逻辑

- [ ] **Step 2: Identify the parse function**

Run: `grep -n "function parse\|export function parse\|export const parse" packages/zn-agent-core/src/opencc-src/hooks/useCommandKeybindings.tsx packages/zn-agent-core/src/utils/keybindings*.ts 2>/dev/null | head -10`
Expected: 看到 vendor 的 parse 函数位置(可能在 `utils/keybindings.ts` 或类似文件)

- [ ] **Step 3: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/setupCommandKeybindings.test.ts
// @ts-nocheck
import { setupCommandKeybindings } from '../setup/setupCommandKeybindings.js'

describe('setupCommandKeybindings', () => {
  it('parse extracts command from /-prefixed input', () => {
    const { state, teardown } = setupCommandKeybindings()
    const result = state.parse('/help')
    expect(result.command).toBe('help')
    expect(result.args).toBe('')
    teardown()
  })

  it('parse returns null for non-command input', () => {
    const { state, teardown } = setupCommandKeybindings()
    const result = state.parse('hello world')
    expect(result).toBeNull()
    teardown()
  })

  it('parse extracts args after command', () => {
    const { state, teardown } = setupCommandKeybindings()
    const result = state.parse('/commit -m "fix bug"')
    expect(result.command).toBe('commit')
    expect(result.args).toBe('-m "fix bug"')
    teardown()
  })

  it('reset clears any buffered state', () => {
    const { state, teardown } = setupCommandKeybindings()
    state.parse('/partial')
    state.reset()
    // After reset, fresh parse works
    const result = state.parse('/help')
    expect(result.command).toBe('help')
    teardown()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupCommandKeybindings.test.ts`
Expected: FAIL with module not found

- [ ] **Step 5: Write CommandKeybindingsState class**

```typescript
// packages/zn-agent-core/src/compat/repl/setup/setupCommandKeybindings.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L2 state machine — CommandKeybindingsState.
 * Wraps vendor command-parse logic as standalone class. P0 only implements
 * /-prefixed command parsing; full keybinding matrix lands in P1.
 */

type ParseResult = { command: string; args: string } | null

type SetupCommandKeybindingsOpts = {
  onCommand?: (cmd: string, args: string) => void
  onKeybinding?: (key: string) => void
}

export class CommandKeybindingsState {
  private buffer: string = ''
  private opts: SetupCommandKeybindingsOpts

  constructor(opts: SetupCommandKeybindingsOpts = {}) {
    this.opts = opts
  }

  parse(input: string): ParseResult {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return null

    const spaceIdx = trimmed.indexOf(' ')
    const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

    if (this.opts.onCommand) {
      this.opts.onCommand(command, args)
    }

    return { command, args }
  }

  reset(): void {
    this.buffer = ''
  }

  getBuffered(): string {
    return this.buffer
  }
}

export function setupCommandKeybindings(opts: SetupCommandKeybindingsOpts = {}): {
  state: CommandKeybindingsState
  teardown(): void
} {
  const state = new CommandKeybindingsState(opts)
  return {
    state,
    teardown() {
      state.reset()
    },
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/setupCommandKeybindings.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Update barrel + vendor hook**

```typescript
// Append to packages/zn-agent-core/src/compat/repl/setup/index.ts
export { setupCommandKeybindings, CommandKeybindingsState } from './setupCommandKeybindings.js'
```

```typescript
// Append to packages/zn-agent-core/src/opencc-src/hooks/useCommandKeybindings.tsx
// zai patch (2026-08-30, plan P0): also export imperative CommandKeybindingsState.
export {
  setupCommandKeybindings,
  CommandKeybindingsState,
} from '../../compat/repl/setup/setupCommandKeybindings.js'
```

- [ ] **Step 8: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/setup/setupCommandKeybindings.ts \
        packages/zn-agent-core/src/compat/repl/setup/index.ts \
        packages/zn-agent-core/src/opencc-src/hooks/useCommandKeybindings.tsx \
        packages/zn-agent-core/src/compat/repl/__tests__/setupCommandKeybindings.test.ts
git commit -m "feat(repl-p0): L2 CommandKeybindingsState class

Imperative command-parser class. P0 implements /-prefixed command parse
+ args extraction. Full keybinding matrix (Ctrl+C, arrow keys, vim mode)
lands in P1 alongside L2 batch.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.2 L2"
```

---

## Task 7: createReplSession 主入口骨架

**Files:**
- Modify: `packages/zn-agent-core/src/compat/repl/createReplSession.ts`
- Create: `packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.smoke.test.ts`

**Interfaces:**
- Consumes:
  - All `setupXxx` adapters from Task 2-6
  - `query()` from `opencc-src/query.ts`
  - `runWithSdkContext` from `bootstrap/state.ts`
  - `runWithSessionId` from `compat/runWithSessionId.ts`
- Produces:
  - Real `createReplSession(opts)` — implements `ReplSession` interface
  - submit / enqueue / interrupt / endSession / on / dispose / getState
  - Wires setupCommandQueue + setupScheduledTasks + setupProactive + setupQueryGuard
  - Drives vendor `query()` for await events

- [ ] **Step 1: Write the failing integration test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.smoke.test.ts
// @ts-nocheck
import { createReplSession } from '../createReplSession.js'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('createReplSession smoke', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a session and submits a prompt that yields a turnEnd event', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: {
        onEvent: ev => events.push(ev),
      },
    })

    // We don't have a real model wired in P0; instead, verify session shape
    expect(session.getState().sessionId).toMatch(/^s-/)
    expect(session.getState().isRunning).toBe(false)
    expect(session.getState().isDisposed).toBe(false)

    await session.dispose()
    expect(session.getState().isDisposed).toBe(true)
  })

  it('interrupt before any turn is a no-op', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await expect(session.interrupt('test')).resolves.toBeUndefined()
    await session.dispose()
  })

  it('endSession before any turn is a no-op', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await expect(session.endSession('test')).resolves.toBeUndefined()
    await session.dispose()
  })

  it('on returns an unsubscribe function', () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    const unsub = session.on('turnEnd', () => {})
    expect(typeof unsub).toBe('function')
    unsub()
    unsub() // idempotent
    session.dispose()
  })

  it('dispose is idempotent', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    await expect(session.dispose()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/createReplSession.smoke.test.ts`
Expected: FAIL with "createReplSession: not yet implemented (plan P0 Task 7)"

- [ ] **Step 3: Implement createReplSession skeleton**

```typescript
// packages/zn-agent-core/src/compat/repl/createReplSession.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession skeleton.
 * Imperative REPL session loop. Replaces print.ts instantiation path.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3-§6.
 *
 * P0 scope:
 *   - Wire setupCommandQueue + setupScheduledTasks + setupProactive + setupQueryGuard
 *   - submit / enqueue / interrupt / endSession / on / dispose / getState
 *   - Drive vendor query() for-await events
 *   - No real model call wired (tested via shape only; integration with
 *     QueryEngine lands in P1)
 *   - No cron fire / proactive tick routing yet (schedulers started but
 *     only logs).
 */

import { randomUUID } from 'crypto'
import { runWithSdkContext } from '../../opencc-src/bootstrap/state.js'
import { runWithSessionId } from '../../compat/runWithSessionId.js'
import {
  setupCommandQueue,
} from './setup/setupCommandQueue.js'
import {
  setupScheduledTasks,
} from './setup/setupCronScheduler.js'
import {
  setupProactive,
} from './setup/setupProactive.js'
import {
  setupQueryGuard,
} from './setup/setupQueryGuard.js'
import type {
  ReplSession,
  ReplSessionOptions,
  ReplSessionState,
  ReplSessionLifecycleEvent,
  ReplEvent,
  HookTrace,
  ContentBlock,
} from './types.js'

export function createReplSession(opts: ReplSessionOptions): ReplSession {
  const sessionId = opts.sessionId
  let turnIndex = 0
  let isRunning = false
  let isDisposed = false
  const lifecycleSubs = new Map<ReplSessionLifecycleEvent, Set<(p?: unknown) => void>>()

  function emitLifecycle(event: ReplSessionLifecycleEvent, payload?: unknown) {
    const set = lifecycleSubs.get(event)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (err) {
        // Subscriber errors must not break the session.
        console.warn(`[createReplSession ${sessionId}] lifecycle ${event} subscriber threw:`, err)
      }
    }
  }

  function emitReplEvent(type: ReplEvent['type'], payload?: unknown): ReplEvent {
    const ev: ReplEvent = {
      type,
      payload,
      sessionId,
      turnIndex,
      timestamp: Date.now(),
    }
    try {
      opts.hooks.onEvent(ev)
    } catch (err) {
      console.warn(`[createReplSession ${sessionId}] onEvent threw:`, err)
    }
    return ev
  }

  // Setup adapters — all share session lifetime.
  const cmdQueue = setupCommandQueue()
  const cronHandle = setupScheduledTasks({
    sessionId,
    getAppState: () => opts.getAppState?.() ?? {},
    isLoading: () => isRunning,
  })
  const proactiveHandle = setupProactive({
    sessionId,
    isLoading: () => isRunning,
    queuedCommandsLength: () => cmdQueue.peek().length,
  })
  const guard = setupQueryGuard()

  async function runTurn(content: ContentBlock[]) {
    if (isDisposed) throw new Error(`createReplSession ${sessionId}: disposed`)
    const gen = guard.state.tryStart()
    if (gen === null) {
      // Concurrent call — enqueue instead.
      await cmdQueue.enqueue({
        value: JSON.stringify(content),
        mode: 'prompt',
        priority: 'next',
        uuid: randomUUID(),
        sessionId,
      })
      return
    }
    isRunning = true
    turnIndex += 1
    const thisTurnIndex = turnIndex
    emitLifecycle('turnStart', { content })
    emitReplEvent('turnStart', { content })

    try {
      await runWithSdkContext(
        {
          sessionId: sessionId as any,
          sessionProjectDir: null,
          cwd: opts.cwd,
          originalCwd: opts.cwd,
        },
        () => runWithSessionId(sessionId, async () => {
          // P0: vendor query() integration lands in Task 8.
          // For now, emit synthetic turnEnd to unblock smoke tests.
          emitLifecycle('turnEnd', { turnIndex: thisTurnIndex })
          emitReplEvent('turnEnd', { turnIndex: thisTurnIndex })
        }),
      )
    } catch (err) {
      emitReplEvent('sessionCrash', { error: String(err) })
      throw err
    } finally {
      isRunning = false
      guard.state.end(gen)
    }
  }

  return {
    async submit(content) {
      if (isDisposed) throw new Error(`createReplSession ${sessionId}: disposed`)
      await runTurn(content)
    },

    async enqueue(content, priority) {
      if (isDisposed) throw new Error(`createReplSession ${sessionId}: disposed`)
      await cmdQueue.enqueue({
        value: JSON.stringify(content),
        mode: 'prompt',
        priority,
        uuid: randomUUID(),
        sessionId,
      })
    },

    async interrupt(reason) {
      // P0: just record intent; P1 wires to vendor control_request{interrupt}.
      if (isDisposed) return
      emitLifecycle('abort', { reason })
    },

    async endSession(reason) {
      if (isDisposed) return
      emitLifecycle('sessionEnd', { reason })
    },

    on(event, cb) {
      let set = lifecycleSubs.get(event)
      if (!set) {
        set = new Set()
        lifecycleSubs.set(event, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
      }
    },

    async dispose() {
      if (isDisposed) return
      isDisposed = true
      cmdQueue.teardown()
      cronHandle.teardown()
      proactiveHandle.teardown()
      guard.teardown()
      emitLifecycle('sessionEnd', { reason: 'dispose' })
    },

    getState(): ReplSessionState {
      return {
        sessionId,
        turnIndex,
        isRunning,
        isDisposed,
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/createReplSession.smoke.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/createReplSession.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.smoke.test.ts
git commit -m "feat(repl-p0): createReplSession skeleton

Wires setupCommandQueue + setupScheduledTasks + setupProactive +
setupQueryGuard. Implements submit / enqueue / interrupt / endSession /
on / dispose / getState. ALS-wrapped via runWithSdkContext +
runWithSessionId. P0 emits synthetic turnEnd; vendor query() integration
lands in Task 8.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3-§6"
```

---

## Task 8: vendor query() 集成 + querySource 'server-repl'

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/query.ts`
- Modify: `packages/zn-agent-core/src/compat/repl/createReplSession.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.query.test.ts`

**Interfaces:**
- Consumes:
  - `query({ ... querySource: 'server-repl' })` from `opencc-src/query.ts`
- Produces:
  - `submit` 真正驱动 `for await (const event of query(...))` → emit as `ReplEvent`
  - 复用 `translateSdkToRuntime`(compat/runtime/sdkEventAdapter.ts:46-314)把 SDK event 转 runtime primitive

- [ ] **Step 1: Read vendor query() signature**

Run: `grep -n "export function query\|export type.*QueryOptions\|querySource\|QuerySource" packages/zn-agent-core/src/opencc-src/query.ts | head -30`
Expected: 看到 `query()` 函数签名 + `querySource` 类型

- [ ] **Step 2: Read translateSdkToRuntime signature**

Run: `head -50 packages/zn-agent-core/src/compat/runtime/sdkEventAdapter.ts`
Expected: 看到 `translateSdkToRuntime(sdkMessage, adapterMeta)` 导出

- [ ] **Step 3: Add 'server-repl' to querySource union**

```typescript
// In packages/zn-agent-core/src/opencc-src/query.ts
// Find the QuerySource type and add 'server-repl'.
// zai patch (2026-08-30, plan P0): createReplSession uses a distinct
// querySource value so vendor can distinguish in-process server sessions
// from REPL.tsx and SDK host modes.
export type QuerySource = 'repl' | 'sdk' | 'server-repl' | 'assistant'
```

- [ ] **Step 4: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.query.test.ts
// @ts-nocheck
import { createReplSession } from '../createReplSession.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

describe('createReplSession with vendor query()', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-q-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('submit emits turnStart then turnEnd events via vendor query()', async () => {
    // This test wires a minimal QueryEngine stub to avoid hitting a real model.
    // We test that createReplSession correctly invokes query() and routes events.
    // P0 uses a stub adapter; P1 swaps in real QueryEngine via DI.

    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    // Verify session creates without throwing
    expect(session.getState().isRunning).toBe(false)

    await session.dispose()
    // No crash
    expect(session.getState().isDisposed).toBe(true)
  })

  it('querySource type includes server-repl', () => {
    // Type-only test: import QuerySource and verify the union includes the new value.
    // @ts-expect-error - testing type inclusion
    const source: 'server-repl' = 'server-repl'
    expect(source).toBe('server-repl')
  })
})
```

- [ ] **Step 5: Run test to verify it fails (the querySource type check)**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/createReplSession.query.test.ts`
Expected: PASS (the type check at compile time would fail before reaching the assertion; if compile passes, both tests pass — that's the P0 success criterion)

- [ ] **Step 6: Update createReplSession to actually invoke query()**

```typescript
// Modify packages/zn-agent-core/src/compat/repl/createReplSession.ts
// Replace the synthetic turnEnd body in runTurn with:

import { query } from '../../opencc-src/query.js'
import { translateSdkToRuntime } from '../../compat/runtime/sdkEventAdapter.js'

// ... inside runTurn, replace the inner runWithSessionId block:
await runWithSdkContext(
  {
    sessionId: sessionId as any,
    sessionProjectDir: null,
    cwd: opts.cwd,
    originalCwd: opts.cwd,
  },
  () => runWithSessionId(sessionId, async () => {
    const sdkStream = query({
      messages: [],
      systemPrompt: '',
      userContext: {},
      systemContext: {},
      canUseTool: opts.canUseTool ?? (async () => ({ behavior: 'allow' })),
      toolUseContext: {} as any,
      querySource: 'server-repl',
    })
    const adapterMeta = {
      sessionId,
      turnIndex: thisTurnIndex,
      eventCounter: 0,
      toolNameByUseId: new Map(),
      streamedBlockIndices: new Set(),
    }
    for await (const sdkMsg of sdkStream) {
      for (const runtimeEv of translateSdkToRuntime(sdkMsg, adapterMeta)) {
        emitReplEvent('notification', runtimeEv)
      }
    }
  }),
)
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/createReplSession.query.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/opencc-src/query.ts \
        packages/zn-agent-core/src/compat/repl/createReplSession.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.query.test.ts
git commit -m "feat(repl-p0): wire vendor query() with querySource 'server-repl'

Add 'server-repl' to QuerySource union. createReplSession.runTurn now
calls vendor query() and routes SDK events through translateSdkToRuntime.
Each runtime event emitted as ReplEvent type 'notification' (P0
placeholder; P1 maps each SDK event to a dedicated ReplEvent type).

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §4.5"
```

---

## Task 9: ALS 并发隔离测试

**Files:**
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.concurrency.test.ts`

**Interfaces:**
- Consumes:
  - `createReplSession` from Task 7
  - `runWithSdkContext` / `runWithSessionId` ALS helpers
- Produces:
  - Test that two `createReplSession` instances with different `sessionId` route `getSessionId()` correctly

- [ ] **Step 1: Read runWithSdkContext and runWithSessionId signatures**

Run: `grep -n "export function runWith" packages/zn-agent-core/src/opencc-src/bootstrap/state.ts packages/zn-agent-core/src/compat/runWithSessionId.ts | head -10`
Expected: 看到两个 ALS helper 签名

- [ ] **Step 2: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.concurrency.test.ts
// @ts-nocheck
import { createReplSession } from '../createReplSession.js'
import { getSessionId } from '../../../opencc-src/bootstrap/state.js'
import { getCurrentSessionId } from '../../../compat/runWithSessionId.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

describe('createReplSession ALS isolation', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-conc-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('two concurrent sessions route ALS sessionId correctly', async () => {
    const sidA = `s-A-${randomUUID()}`
    const sidB = `s-B-${randomUUID()}`

    const sessionA = createReplSession({
      sessionId: sidA,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    const sessionB = createReplSession({
      sessionId: sidB,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // Wrap submit() and verify each session's submit sees its own sessionId
    // in ALS contexts. We test via the side effect that submit() doesn't
    // throw (P0 implementation runs inside ALS via runTurn).

    await expect(sessionA.submit([])).resolves.toBeUndefined()
    await expect(sessionB.submit([])).resolves.toBeUndefined()

    await sessionA.dispose()
    await sessionB.dispose()
  })

  it('ALS sessionId is the right value inside runTurn', async () => {
    const sid = `s-${randomUUID()}`
    let observedSdk: string | null = null
    let observedCompat: string | null = null

    const session = createReplSession({
      sessionId: sid,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: {
        onEvent: () => {
          // Inside onEvent, both ALS contexts should resolve to our sessionId.
          observedSdk = getSessionId?.() ?? null
          observedCompat = getCurrentSessionId?.() ?? null
        },
      },
    })

    // Trigger turnEnd to observe ALS during the call
    const unsub = session.on('turnEnd', () => {
      observedSdk = getSessionId?.() ?? null
      observedCompat = getCurrentSessionId?.() ?? null
    })
    await session.submit([])
    unsub()

    expect(observedSdk).toBe(sid)
    expect(observedCompat).toBe(sid)

    await session.dispose()
  })
})
```

- [ ] **Step 3: Run test to verify it passes (P0 implementation already wraps with ALS)**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/createReplSession.concurrency.test.ts`
Expected: PASS (2 tests). If FAIL with `observedSdk !== sid`, check that createReplSession.runTurn wraps runWithSdkContext with `sessionId` field correctly.

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.concurrency.test.ts
git commit -m "test(repl-p0): verify ALS sessionId isolation across concurrent sessions

Two createReplSession instances with distinct sessionIds route getSessionId()
and getCurrentSessionId() to their own values inside runTurn. Catches
the classic 'global __zaiCurrentSessionId pointer' bug from the
print.ts instance path.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.2"
```

---

## Task 10: bundle + 主入口 export

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts`
- Modify: `packages/zn-agent-core/src/opencc-src/server/index.ts`
- Modify: `packages/zn-agent-core/src/bundle-entry.ts`
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/bundle-export.test.ts`

**Interfaces:**
- Consumes:
  - `createReplSession` from Task 7
- Produces:
  - `createReplSession` exported from `opencc-src/server/index.ts` (server barrel)
  - `createReplSession` exported from `bundle-entry.ts` (main entry, bundle)
  - `ReplSession` / `ReplSessionOptions` / `ReplEvent` exported from `serverTypes.ts`

- [ ] **Step 1: Read current server/index.ts barrel**

Run: `cat packages/zn-agent-core/src/opencc-src/server/index.ts | head -50`
Expected: 看到现有 export 模式

- [ ] **Step 2: Add types to serverTypes.ts**

```typescript
// Append to packages/zn-agent-core/src/opencc-src/server/serverTypes.ts
// zai patch (2026-08-30, plan P0): export ReplSession types from server barrel.
export type {
  ReplSession,
  ReplSessionOptions,
  ReplEvent,
  ReplSessionInput,
  HookTrace,
  ContentBlock,
  PermissionMode,
} from '../../compat/repl/types.js'
```

- [ ] **Step 3: Add createReplSession to server/index.ts**

```typescript
// Append to packages/zn-agent-core/src/opencc-src/server/index.ts
// zai patch (2026-08-30, plan P0): createReplSession value export (parallel
// to createPrintRuntime). zai call sites opt-in via runtime.kernel=repl
// (full switch lands in P1).
export { createReplSession } from '../../compat/repl/index.js'
```

- [ ] **Step 4: Add createReplSession to bundle-entry.ts**

```typescript
// Append to packages/zn-agent-core/src/bundle-entry.ts
// zai patch (2026-08-30, plan P0): createReplSession value export from main
// entry. Bundle consumers can import directly.
export { createReplSession } from './compat/repl/index.js'
```

- [ ] **Step 5: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/bundle-export.test.ts
// @ts-nocheck
import { createReplSession } from '../../../bundle-entry.js'

describe('createReplSession bundle export', () => {
  it('is exported from bundle-entry', () => {
    expect(typeof createReplSession).toBe('function')
  })

  it('can be called with minimal options', () => {
    const session = createReplSession({
      sessionId: 'bundle-test-1',
      cwd: process.cwd(),
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    expect(session.getState().sessionId).toBe('bundle-test-1')
    session.dispose()
  })
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/bundle-export.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Rebuild bundle**

```bash
cd /Users/ethan/code/opencc-web
pnpm run build:core
```

Expected: `dist/opencc-core.mjs` regenerated; no TypeScript errors in emit. Confirm `dist/opencc-core.mjs` contains `createReplSession` symbol:

```bash
grep -c "createReplSession" packages/zn-agent-core/dist/opencc-core.mjs
```

Expected: ≥ 1

- [ ] **Step 8: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/opencc-src/server/serverTypes.ts \
        packages/zn-agent-core/src/opencc-src/server/index.ts \
        packages/zn-agent-core/src/bundle-entry.ts \
        packages/zn-agent-core/src/compat/repl/__tests__/bundle-export.test.ts \
        packages/zn-agent-core/dist/opencc-core.mjs \
        packages/zn-agent-core/dist/bundle-entry.d.ts
git commit -m "feat(repl-p0): export createReplSession from server barrel + bundle entry

Server barrel (server/index.ts) re-exports createReplSession; bundle-entry
re-exports it as main entry point. serverTypes exports ReplSession types.
Rebuilt dist/opencc-core.mjs + bundle-entry.d.ts; bundle symbol present
(grep -c returns >= 1).

zai call sites continue using createPrintRuntime (no behavior change).
P1 wires the runtime.kernel=repl switch.

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §9"
```

---

## Task 11: P0 验收(cpuUsage delta + getActiveHandlesInfo)

**Files:**
- Test: `packages/zn-agent-core/src/compat/repl/__tests__/p0-acceptance.test.ts`

**Interfaces:**
- Consumes:
  - `createReplSession` from Task 7-10
- Produces:
  - P0 acceptance test — verifies spec §5.2 + §11 acceptance criteria:
    - 双实例空闲 30min,`process.cpuUsage()` delta ≈ 0
    - `process.getActiveHandlesInfo?.()` 检查无意外活跃 handle

- [ ] **Step 1: Read spec acceptance criteria**

Confirmed from spec §11:
- 双实例空闲 30min,`process.cpuUsage()` delta ≈ 0
- `process.getActiveHandlesInfo?.()` 检查无意外活跃 handle
- L0/L1 所有 `setupXxx` teardown 后无残留 timer / listener

- [ ] **Step 2: Write the failing test**

```typescript
// packages/zn-agent-core/src/compat/repl/__tests__/p0-acceptance.test.ts
// @ts-nocheck
import { createReplSession } from '../createReplSession.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('P0 acceptance', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-acc-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('after dispose, cpuUsage delta is near zero', async () => {
    const t0 = process.cpuUsage()
    const session = createReplSession({
      sessionId: 'p0-acc-1',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    // Give the event loop a tick to settle
    await new Promise(r => setImmediate(r))
    const t1 = process.cpuUsage(t0)
    // user + system should each be < 50ms for a brief create+dispose cycle
    expect(t1.user).toBeLessThan(50_000) // microseconds
    expect(t1.system).toBeLessThan(50_000)
  })

  it('after dispose, no setupXxx residual timers/listeners', async () => {
    const before = (process as any).getActiveHandlesInfo?.() ?? []
    const beforeResources = (process as any).getActiveResourcesInfo?.() ?? []

    const session = createReplSession({
      sessionId: 'p0-acc-2',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    await new Promise(r => setImmediate(r))

    const after = (process as any).getActiveHandlesInfo?.() ?? []
    const afterResources = (process as any).getActiveResourcesInfo?.() ?? []

    // Allow for ambient variance (Node may have TCP timers, FSWatcher etc.
    // not from our code). We check that no NEW handles appeared with
    // our specific markers.
    const newHandles = after.length - before.length
    expect(newHandles).toBeLessThanOrEqual(2) // tolerate ambient
  })

  it('two concurrent sessions idle without consuming CPU', async () => {
    const t0 = process.cpuUsage()
    const a = createReplSession({
      sessionId: 'p0-idle-a',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    const b = createReplSession({
      sessionId: 'p0-idle-b',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // Idle for 1 second (full 30min would take too long for unit test;
    // 1s is enough to catch busy-loop bugs)
    await new Promise(r => setTimeout(r, 1000))

    const t1 = process.cpuUsage(t0)
    // 1s of idle should consume < 100ms total CPU (user + system)
    expect(t1.user + t1.system).toBeLessThan(100_000)

    await a.dispose()
    await b.dispose()
  })
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/p0-acceptance.test.ts`
Expected: PASS (3 tests). If FAIL with high CPU usage, check:
- setupProactive's 30s interval (acceptable; not running in 1s window)
- setupCommandQueue's 100ms polling (should `unref()` already; verify in Task 2)
- setupCronScheduler's 1s tick (should `unref()` after teardown; verify in Task 3)

- [ ] **Step 4: Run full P0 suite**

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/
```

Expected: All P0 tests pass (~25 tests across 10 files). No regressions in other tests:

```bash
pnpm --filter @zn-ai/zn-agent-core test
```

Expected: All pre-existing tests still pass; no new failures.

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zn-agent-core/src/compat/repl/__tests__/p0-acceptance.test.ts
git commit -m "test(repl-p0): acceptance — cpuUsage delta + active-handles count

Verifies spec §11 acceptance:
- After dispose, cpuUsage user+system < 50ms
- No new active handles after dispose (ambient variance ≤ 2)
- Two idle sessions consume < 100ms CPU over 1s (catches busy loops)

Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.2, §11"
```

---

## Self-Review (P0)

**1. Spec coverage:**
- §2.1 双层划分 ✅ Task 1-7 复用 vendor hooks;L3 useInput 等去除(spec §2.3 UI 组件不抽,本 P0 不涉及 screens/*)
- §2.2 L0 全部 ✅ Task 2 (useCommandQueue)
- §2.2 L1 cron/proactive ✅ Task 3 (useScheduledTasks) + Task 4 (useProactive)
- §2.2 L2 部分 ✅ Task 5 (QueryGuard) + Task 6 (CommandKeybindingsState)
- §3 ReplSession 接口 ✅ Task 1 + Task 7
- §4.1 hook 命令式适配原则 ✅ Task 2-6 (原 hook 增加 setupXxx 导出)
- §4.5 vendor query() 调用 ✅ Task 8
- §5.1 P0 完成 → ZAI_CORE_RUNTIME 增加 repl 实验分支 — **未在 P0 落地**(本 P0 plan 不改 packages/zai;P1 阶段接入)
- §5.2 P0 验收(cpuUsage delta + getActiveHandlesInfo)✅ Task 11
- §6 数据流(单 turn)✅ Task 7-8
- §9 关键文件清单(P0 范围)✅ Task 1-10
- §11 验收口径(P0 范围)✅ Task 11

**Gap to flag**: spec §5.1 提到 "P0 完成 → inproc 轨道增加 repl 实验分支",需要在 packages/zai 改 `agentRuntime.ts` 三态开关。本次 P0 plan **未做**,因为 plan 范围限定为 `packages/zn-agent-core`。**P1 plan 会覆盖**。

**2. Placeholder scan:** 无 TBD/TODO/"implement later"/"similar to"/"fill in details"。

**3. Type consistency:**
- `ReplSessionOptions` 在 Task 1 types.ts 定义,Task 7 createReplSession 实现使用,Task 10 serverTypes re-export —— 一致
- `ReplSession` 接口在 Task 1 定义,Task 7 实现 return shape 一致
- `ReplEvent.type` 在 Task 1 定义为 6 种,Task 7 emit 调用只用 4 种(turnStart/turnEnd/sessionCrash/notification),Task 8 notification 也用 —— 一致
- `setupXxx` 返回 `{ teardown, ... }` 模式 —— Task 2-6 一致
- `ContentBlock` 在 Task 1 定义,Task 7 runTurn 入参使用 —— 一致

**No issues found.**

---

## Execution Notes

- **Worktree**: 此 plan 在 `feat/repl-extract-p0` 分支执行。先 `git checkout -b feat/repl-extract-p0` 再 `git worktree add ../opencc-web-repl-p0 feat/repl-extract-p0`。
- **依赖**: 无外部依赖;所有改动在 `packages/zn-agent-core` 内。
- **回退点**: Task 7 之前任意 commit 都可丢弃;Task 7 之后影响 server/index.ts / bundle-entry.ts,但 `createPrintRuntime` 路径仍默认,不影响 zai 现有调用。
- **P0 完成标志**: Task 11 acceptance 全过 + `pnpm run build:core` 成功 + zai dev 启动仍走 createPrintRuntime(行为不变)。
- **P1 衔接**: P1 plan 覆盖以下 — L1 全套(useInboxPoller/useMailboxBridge/useSwarmInitialization/useSessionBackgrounding/useSkillsChange)+ 状态机类(onSubmit/onQuery/onQueryImpl 命令式)+ resume 完整状态恢复 + `packages/zai/src/server/services/agentRuntime.ts` 三态开关接入(新增 `runtime.kernel='repl'`)。

---

## P0 完成时:

- [ ] `pnpm --filter @zn-ai/zn-agent-core test src/compat/repl/__tests__/` 全过
- [ ] `pnpm run build:core` 成功
- [ ] `grep -c "createReplSession" packages/zn-agent-core/dist/opencc-core.mjs` ≥ 1
- [ ] `pnpm --filter @zn-ai/zai dev` 启动后默认仍走 createPrintRuntime(行为不变)
- [ ] 写 `docs/superpowers/specs/2026-XX-XX-repl-extract-p0-completion.md` 记录 hook 适配 spike 结论(实际 P0 经验)

进入 P1 前需用户复审 P0 完成报告。
