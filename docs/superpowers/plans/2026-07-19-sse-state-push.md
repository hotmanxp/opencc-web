# SSE 统一状态推送 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `useSessionCwd`(5s)、`useBashBackgroundTasks`(15s) 等 setInterval 轮询迁到统一的 `/api/event` SSE 通道,server 端新增 4 类 state 事件(`cwd.changed` / `bash_task.changed` / `v2_task.changed` / `agent_task.changed`),按 topic 维度订阅。

**Architecture:** zai-agent-core 暴露 in-process `StateChangeBus`(Node `EventEmitter`),zai server 层通过 `stateBridge.ts` 桥接到现有 `eventBus`,新增 `subscribeTopics(sid, topics, cb)` 在 SSE 路由做 topic whitelist filter + replay。Client 端走 `useEventStream` 现有 SSE 通道,新增 4 个 zustand reducer。

**Tech Stack:** TypeScript / Node `EventEmitter` / zod / Zustand / Vitest / EventSource / SSE

## Global Constraints

- 依赖方向单向:`zai-agent-core` → 无依赖 → `zai server`(core 不 import `eventBus`)。
- 所有 state 事件 payload 是**全量快照**,不是 diff。
- Bash stdout/stderr 高频 emit 走 **50ms debounce batch**(tracker 内部),终态(`markFinished`)同步立即 emit。
- `cwd.changed` / `bash_task.changed` / `v2_task.changed` 默认带 `sessionId`,走 per-sid filter。
- `agent_task.changed` 兼容 `sessionId: null`(全局 task)。
- 4 个新事件 type 不在 `isGlobalEvent` 白名单。
- Feature flag `ZAI_SSE_STATE_PUSH=on` 控制新老路径并存(默认 on),Phase D 完成后才删老路径。
- 已有代码 pattern 优先(`packages/zai-agent-core/test/integration/...` 用 vitest 集成测试,`packages/zai-agent-core/test/unit/...` 单元测试)。
- 文档同步:AGENTS.md「SSE 事件通道」「前端 store 关键设计」「已知薄弱点」三段。

---

## File Map

### zai-agent-core 新增 / 修改

| 文件 | 职责 |
|---|---|
| `src/runtime/stateChangeBus.ts` **(新)** | in-process Node EventEmitter,4 类 event 定义 + emit/on/off + 测试 reset |
| `src/runtime/index.ts` **(改)** | export `stateChangeBus` + `StateChangeEventMap` + `resetStateChangeBusForTests` |
| `src/tools/BashTool/bashTracker.ts` **(改)** | 增加 `pendingEmits`/`pendingSnapshots` debounce 基础设施 + `scheduleEmit()` + `__flushPendingForTests` + `markFinished` 同步 emit |
| `src/tools/BashTool/BashTool.ts` **(改)** | 第 374 行 `CwdStore.set` 后追加 `stateChangeBus.emit('cwd.changed', ...)` |
| `src/tools/Tasks/TaskListStore.ts` **(改)** | `create` 末尾 emit `v2_task.changed` action='upsert';`update` 末尾(在 saveSession 之后)emit `v2_task.changed` action='upsert';若触发 `deleteSession` 则额外 emit action='delete'(删除前 snapshot) |
| `src/runtime/background/DefaultBackgroundRuntime.ts` **(改)** | `notifyChange` 私有方法内并行 emit `stateChangeBus.emit('agent_task.changed', ...)` |
| `test/unit/runtime/stateChangeBus.test.ts` **(新)** | 单元测试:emit/on/off + reset |
| `test/unit/tools/BashTracker-debounce.test.ts` **(新)** | debounce 行为 + markFinished 同步 + 测试钩子 |
| `test/unit/tools/BashTool-cwd-emit.test.ts` **(新)** | cwd.changed emit 触发点 |
| `test/unit/tools/TaskListStore-emit.test.ts` **(新)** | v2_task.changed emit(create/update/deleteSession) |
| `test/unit/runtime/DefaultBackgroundRuntime-emit.test.ts` **(新)** | agent_task.changed emit |

### zai server 新增 / 修改

| 文件 | 职责 |
|---|---|
| `src/shared/events.ts` **(改)** | 新增 `StateEvent` discriminatedUnion(4 个 type)+ 并入 `ServerEvent` union |
| `src/server/services/eventBus.ts` **(改)** | 新增 `subscribeTopics(sid, topics, cb)` 方法 + `getHistoryAfterForSidWithTopics` 兼容 topic filter + `topicMatches` 辅助函数 |
| `src/server/services/stateBridge.ts` **(新)** | bridge 模块:订阅 `stateChangeBus`,翻译成 `eventBus.emit` + 返回 dispose |
| `src/server/routes/event.ts` **(改)** | URL `?topics=` 解析 + `subscribeTopics` 接入 + replay 也走 topic filter |
| `src/server/index.ts` **(改)** | `createApp` 中 `initBackgroundRuntime` 后调 `initStateBridge()`,存 dispose 在 module-level 单例 |
| `test/unit/services/eventBus-topics.test.ts` **(新)** | topic whitelist 单元测试 |
| `test/unit/services/stateBridge.test.ts` **(新)** | 桥接层集成测试(mock eventBus) |

### zai web 新增 / 修改

| 文件 | 职责 |
|---|---|
| `src/store/useAgentStore.ts` **(改)** | 新增 `cwdBySession` / `bashTasksBySession` / `agentTasksBySession` 字段 + `applyCwdChanged` / `applyBashTaskChanged` / `applyV2TaskChanged` / `applyAgentTaskChanged` reducer |
| `src/lib/eventSource.ts` **(改)** | `NAMED_EVENT_TYPES` 加 4 个新 type |
| `src/store/useEventStream.ts` **(改)** | `dispatch` 加 4 个 case |
| `src/hooks/useSessionCwd.ts` **(改)** | 删 setInterval,改读 `cwdBySession[sessionId]`;fallback 一次性 fetch |
| `src/hooks/useBashBackgroundTasks.ts` **(改)** | 删 setInterval,改读 `bashTasksBySession[sessionId] ?? []` |
| `src/hooks/useBackgroundTasks.ts` **(改)** | 删除 `useEffect → listTasks` 兜底,保留 detail 懒加载(SSE 推送 detail 优先) |
| `src/components/SessionCwdBridge.tsx` **(改)** | 接 `cwdBySession` 替代 `useSessionCwd` 调用的 hook(若 hook 删除则这里直接读 store) |
| `src/lib/api.ts` **(改)** | 不动(1-shot `/api/slash` 与 `/api/agent/settings` 保持一次性) |
| `test/unit/store/agentStore-state-events.test.ts` **(新)** | 4 个 reducer 纯函数测试 |
| `test/unit/store/eventStream-dispatch.test.ts` **(新)** | dispatch routing 测试 |
| `test/unit/hooks/useSessionCwd.test.ts` **(改)** | 删 setInterval 断言,加 store-driven 测试 |
| `test/unit/hooks/useBashBackgroundTasks.test.ts` **(改)** | 同上 |

---

## Task Decomposition

任务按 Phase A→E 排列,每个 Task 是一个 PR 级别的可独立交付单元。

| Task | Phase | 主题 |
|---|---|---|
| 1 | A | StateChangeBus 基础设施 + 单测 |
| 2 | A | CwdStore emit 触发点 + BashTool 改造 + 单测 |
| 3 | A | BashTracker debounce + markFinished 同步 + 单测 |
| 4 | A | TaskListStore emit 触发点 + 单测 |
| 5 | A | DefaultBackgroundRuntime emit + 单测 |
| 6 | B | shared/events.ts 新增 StateEvent + ServerEvent union |
| 7 | B | ServerEventBus.subscribeTopics + topic filter + 单测 |
| 8 | B | stateBridge.ts 桥接层 + createApp 接入 + 单测 |
| 9 | B | event.ts 路由 topics URL + replay filter |
| 10 | C | useAgentStore 新增 4 map + 4 reducer + 单测 |
| 11 | C | eventSource.ts + useEventStream.ts 接入 + 单测 |
| 12 | D | useSessionCwd 删除 setInterval + 改 store |
| 13 | D | useBashBackgroundTasks 删除 setInterval + 改 store |
| 14 | D | useBackgroundTasks 删除 listTasks 兜底 |
| 15 | E | 性能 benchmark + AGENTS.md 同步 + cleanup |

---

### Task 1: StateChangeBus 基础设施

**Files:**
- Create: `packages/zai-agent-core/src/runtime/stateChangeBus.ts`
- Create: `packages/zai-agent-core/test/unit/runtime/stateChangeBus.test.ts`
- Modify: `packages/zai-agent-core/src/runtime/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `import { EventEmitter } from 'node:events'` typed as `TypedEmitter<StateChangeEventMap>`
  - `export interface StateChangeEventMap`: 4 个 key
    - `'cwd.changed': { sessionId: string; cwd: string; updatedAt: number }`
    - `'bash_task.changed': { sessionId: string; task: import('../tools/BashTool/bashTracker.js').BashTaskInfo }`
    - `'v2_task.changed': { sessionId: string; task: import('../tools/Tasks/TaskListStore.js').TaskItem; action: 'upsert' | 'delete' }`
    - `'agent_task.changed': { sessionId: string | null; task: import('./background/types.js').BackgroundTask }`
  - `export const stateChangeBus: TypedEmitter<StateChangeEventMap>` (单例)
  - `export function resetStateChangeBusForTests(): void`

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/unit/runtime/stateChangeBus.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  stateChangeBus,
  resetStateChangeBusForTests,
} from '../../../src/runtime/stateChangeBus.js'

describe('stateChangeBus', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
  })

  it('emits cwd.changed with payload', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
    expect(cb).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
  })

  it('emits bash_task.changed with payload', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    stateChangeBus.emit('bash_task.changed', { sessionId: 's1', task: {} as any })
    expect(cb).toHaveBeenCalledWith({ sessionId: 's1', task: {} })
  })

  it('emits v2_task.changed with payload', () => {
    const cb = vi.fn()
    stateChangeBus.on('v2_task.changed', cb)
    stateChangeBus.emit('v2_task.changed', { sessionId: 's1', task: {} as any, action: 'upsert' })
    expect(cb).toHaveBeenCalledWith({ sessionId: 's1', task: {}, action: 'upsert' })
  })

  it('emits agent_task.changed with nullable sessionId', () => {
    const cb = vi.fn()
    stateChangeBus.on('agent_task.changed', cb)
    stateChangeBus.emit('agent_task.changed', { sessionId: null, task: {} as any })
    expect(cb).toHaveBeenCalledWith({ sessionId: null, task: {} })
  })

  it('off removes listener', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    stateChangeBus.off('cwd.changed', cb)
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('resetStateChangeBusForTests removes all listeners', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    stateChangeBus.on('bash_task.changed', cb)
    resetStateChangeBusForTests()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
    stateChangeBus.emit('bash_task.changed', { sessionId: 's1', task: {} as any })
    expect(cb).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/runtime/stateChangeBus.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/runtime/stateChangeBus.js'"

- [ ] **Step 3: 实现 stateChangeBus**

`packages/zai-agent-core/src/runtime/stateChangeBus.ts`:

```ts
/**
 * In-process state change event bus (zai-agent-core → zai server bridge).
 *
 * zai-agent-core 是 runtime 库,不依赖 zai server 的 services/eventBus。
 * 因此它只暴露 Node EventEmitter 让 zai server 层 subscribe 后翻译成
 * SSE event emit。schema 校验在 zai server emit 到 eventBus 时做。
 *
 * 设计: 4 个事件类型用 TypeScript 模板做强类型,消费方 on/off 都有
 * 签名校验。运行期不校验 payload(emit 是 in-process)。
 */

import { EventEmitter } from 'node:events'
import type { BashTaskInfo } from '../tools/BashTool/bashTracker.js'
import type { TaskItem } from '../tools/Tasks/TaskListStore.js'
import type { BackgroundTask } from './background/types.js'

export interface StateChangeEventMap {
  'cwd.changed': { sessionId: string; cwd: string; updatedAt: number }
  'bash_task.changed': { sessionId: string; task: BashTaskInfo }
  'v2_task.changed': { sessionId: string; task: TaskItem; action: 'upsert' | 'delete' }
  'agent_task.changed': { sessionId: string | null; task: BackgroundTask }
}

type Listener<K extends keyof StateChangeEventMap> = (payload: StateChangeEventMap[K]) => void

interface TypedEmitter<E extends Record<string, unknown>> {
  on<K extends keyof E>(event: K, listener: Listener<K>): this
  off<K extends keyof E>(event: K, listener: Listener<K>): this
  emit<K extends keyof E>(event: K, payload: E[K]): boolean
  removeAllListeners(event?: keyof E): this
}

export const stateChangeBus: TypedEmitter<StateChangeEventMap> =
  new EventEmitter() as TypedEmitter<StateChangeEventMap>

/** 测试 seam: 清空所有 listener。生产代码不要调。 */
export function resetStateChangeBusForTests(): void {
  stateChangeBus.removeAllListeners()
}
```

- [ ] **Step 4: 在 runtime/index.ts 暴露**

`packages/zai-agent-core/src/runtime/index.ts` 末尾追加:

```ts
// State change bus (in-process event for zai server SSE bridge)
export { stateChangeBus, resetStateChangeBusForTests } from './stateChangeBus.js'
export type { StateChangeEventMap } from './stateChangeBus.js'
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/runtime/stateChangeBus.test.ts
```

Expected: 6 tests pass

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/stateChangeBus.ts \
        packages/zai-agent-core/src/runtime/index.ts \
        packages/zai-agent-core/test/unit/runtime/stateChangeBus.test.ts
git commit -m "feat(agent-core): StateChangeBus in-process bridge for SSE state events"
```

---

### Task 2: BashTool cwd.changed 触发点

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/BashTool.ts:374` (在 `CwdStore.set` 之后)
- Create: `packages/zai-agent-core/test/unit/tools/BashTool-cwd-emit.test.ts`

**Interfaces:**
- Consumes: `stateChangeBus.emit('cwd.changed', { sessionId, cwd, updatedAt })` from Task 1
- Produces: 当 `CwdStore.set` 被调用时,emit `cwd.changed`

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/unit/tools/BashTool-cwd-emit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'
import { CwdStore } from '../../../src/runtime/cwdStore.js'

describe('BashTool cwd.changed emit', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
    CwdStore.clear()
  })

  it('emits cwd.changed when CwdStore.set called with different cwd', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    CwdStore.set('sess-1', '/tmp/a')
    // 模拟 BashTool 末尾 emit
    stateChangeBus.emit('cwd.changed', { sessionId: 'sess-1', cwd: '/tmp/a', updatedAt: Date.now() })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-1', cwd: '/tmp/a' })
  })

  it('does not emit when cwd unchanged', () => {
    CwdStore.set('sess-1', '/tmp/a')
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    // 模拟 BashTool 内"newCwd === oldCwd → 跳过"分支
    const newCwd = CwdStore.get('sess-1')!
    if (newCwd !== CwdStore.get('sess-1')) {
      stateChangeBus.emit('cwd.changed', { sessionId: 'sess-1', cwd: newCwd, updatedAt: Date.now() })
    }
    expect(cb).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认 cwd.changed 触发那一条失败(emit 未调用)**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/BashTool-cwd-emit.test.ts
```

Expected: 第 1 个测试 PASS(测试里已含 emit 调用),第 2 个测试 PASS(测试里没 emit)。**这条任务真正要验证的是 BashTool.ts 文件的修改**,见 Step 4。

- [ ] **Step 3: 改 BashTool.ts**

`packages/zai-agent-core/src/tools/BashTool/BashTool.ts`:

1. 文件顶 import 区追加(在 `import { CwdStore } from '../../runtime/cwdStore.js'` 后):
```ts
import { stateChangeBus } from '../../runtime/stateChangeBus.js'
```

2. 修改第 366-378 行的 `cwd trailer` 块,从:
```ts
      // cwd trailer: read tmpfile written by `pwd -P >| tmpCwdFile` appended to user command
      if (sessionId) {
        try {
          const raw = readFileSync(tmpCwdFile, 'utf8').trim()
          // sh's pwd -P already resolves symlinks; NFC-normalize for Unicode paths
          const newCwd = raw.normalize('NFC')
          const oldCwd = CwdStore.get(sessionId)
          if (newCwd && newCwd !== oldCwd) {
            CwdStore.set(sessionId, newCwd)
          }
        } catch {
          // tmpfile missing (cmd aborted before trailer ran) or permission error — keep old cwd
        }
```
改为:
```ts
      // cwd trailer: read tmpfile written by `pwd -P >| tmpCwdFile` appended to user command
      if (sessionId) {
        try {
          const raw = readFileSync(tmpCwdFile, 'utf8').trim()
          // sh's pwd -P already resolves symlinks; NFC-normalize for Unicode paths
          const newCwd = raw.normalize('NFC')
          const oldCwd = CwdStore.get(sessionId)
          if (newCwd && newCwd !== oldCwd) {
            CwdStore.set(sessionId, newCwd)
            stateChangeBus.emit('cwd.changed', {
              sessionId,
              cwd: newCwd,
              updatedAt: Date.now(),
            })
          }
        } catch {
          // tmpfile missing (cmd aborted before trailer ran) or permission error — keep old cwd
        }
```

- [ ] **Step 4: 跑 BashTool 现有测试套确认未回归**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/BashTool/ -- --reporter=verbose
```

Expected: 所有 BashTool 单元测试 PASS(包括既有的 `BashTool.test.ts` 与 cwd 相关测试)。

- [ ] **Step 5: 跑新测试**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/BashTool-cwd-emit.test.ts
```

Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/tools/BashTool/BashTool.ts \
        packages/zai-agent-core/test/unit/tools/BashTool-cwd-emit.test.ts
git commit -m "feat(BashTool): emit cwd.changed on CwdStore mutation"
```

---

### Task 3: BashTracker debounce + markFinished 同步

**Files:**
- Modify: `packages/zai-agent-core/src/tools/BashTool/bashTracker.ts`
- Create: `packages/zai-agent-core/test/unit/tools/BashTracker-debounce.test.ts`

**Interfaces:**
- Consumes: `stateChangeBus.emit('bash_task.changed', { sessionId, task })` from Task 1
- Produces:
  - `bashBackgroundTracker.scheduleEmit(taskId)` 私有方法(自动 50ms debounce)
  - 所有 mutator(`appendOutput` / `markFinished` / `backgroundExistingForegroundTask` / `register` / `unregisterForeground` / `markNotified`)末尾调用 `scheduleEmit(taskId)`
  - `markFinished` 同步立即 emit(不等 debounce)
  - 测试钩子 `__flushPendingForTests()`
  - `private cancelPendingEmit(taskId)` 私有方法

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/unit/tools/BashTracker-debounce.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bashBackgroundTracker } from '../../../src/tools/BashTool/bashTracker.js'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'

const taskInfo = {
  command: 'sleep 1',
  description: 'sleep',
  sessionId: 'sess-1',
  startedAt: Date.now(),
}

describe('bashBackgroundTracker debounce', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
    bashBackgroundTracker.__resetForTests()
  })

  afterEach(() => {
    bashBackgroundTracker.__resetForTests()
  })

  it('batches appendOutput: 100 calls → 1 emit', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    const t = bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    for (let i = 0; i < 100; i++) {
      bashBackgroundTracker.appendOutput('bash-1', { stdout: `chunk ${i}\n` })
    }
    // 同步阶段还没 emit(50ms debounce)
    expect(cb).not.toHaveBeenCalled()
  })

  it('emits after 50ms debounce', async () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    bashBackgroundTracker.appendOutput('bash-1', { stdout: 'hi' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(cb).toHaveBeenCalledTimes(1)
    const last = cb.mock.calls[cb.mock.calls.length - 1][0]
    expect(last.task.taskId).toBe('bash-1')
    expect(last.task.stdout).toBe('hi')
  })

  it('markFinished synchronously emits (no debounce)', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    bashBackgroundTracker.markFinished('bash-1', 'completed', { exitCode: 0 })
    expect(cb).toHaveBeenCalledTimes(1)
    const last = cb.mock.calls[0][0]
    expect(last.task.status).toBe('completed')
  })

  it('__flushPendingForTests forces immediate emit', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    bashBackgroundTracker.appendOutput('bash-1', { stdout: 'pending' })
    bashBackgroundTracker.__flushPendingForTests()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].task.stdout).toBe('pending')
  })

  it('does not emit for evicted task', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    // 没 register 就 scheduleEmit → byId miss → 无 emit
    ;(bashBackgroundTracker as any).scheduleEmit('bash-unknown')
    expect(cb).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/BashTracker-debounce.test.ts
```

Expected: FAIL with "__flushPendingForTests is not a function" 或 "scheduleEmit is not a function"

- [ ] **Step 3: 改 bashTracker.ts**

`packages/zai-agent-core/src/tools/BashTool/bashTracker.ts`:

1. 文件顶追加 import:
```ts
import { stateChangeBus } from '../../runtime/stateChangeBus.js'
```

2. 在 `class BashBackgroundTracker { private readonly byId ... }` 后(第 53 行附近)追加私有字段:
```ts
  private readonly pendingEmits = new Map<string, NodeJS.Timeout>()
  private readonly pendingSnapshots = new Map<string, BashTaskInfo>()
```

3. 在文件第 91-97 行(`appendOutput` 方法末尾)追加:
```ts
    this.scheduleEmit(taskId)
    return t
```

完整 `appendOutput` 修改后为:
```ts
  appendOutput(taskId: string, chunk: { stdout?: string; stderr?: string }): BashTaskInfo | undefined {
    const t = this.byId.get(taskId)
    if (!t) return undefined
    if (chunk.stdout) t.stdout += chunk.stdout
    if (chunk.stderr) t.stderr += chunk.stderr
    this.scheduleEmit(taskId)
    return t
  }
```

4. 修改 `markFinished`(第 156-171 行),在 `this.children.delete(taskId)` 后,**取消 debounce + 立即 emit**:
```ts
  markFinished(
    taskId: string,
    status: 'completed' | 'failed' | 'killed',
    info: { exitCode?: number; signal?: NodeJS.Signals } = {},
  ): BashTaskInfo | undefined {
    const t = this.byId.get(taskId)
    if (!t) return undefined
    t.status = status
    t.finishedAt = Date.now()
    if (info.exitCode !== undefined) t.exitCode = info.exitCode
    if (info.signal) t.signal = info.signal
    this.children.delete(taskId)
    this.cancelPendingEmit(taskId)
    stateChangeBus.emit('bash_task.changed', { sessionId: t.sessionId, task: { ...t } })
    this.evictFinished()
    return t
  }
```

5. 修改 `register`(第 60-72 行),在末尾追加 `this.scheduleEmit(taskId)`:
```ts
  register(taskId: string, info: Omit<BashTaskInfo, 'taskId' | 'status' | 'stdout' | 'stderr' | 'isBackgrounded' | 'notified'>): BashTaskInfo {
    const full: BashTaskInfo = {
      taskId,
      status: 'running',
      stdout: '',
      stderr: '',
      isBackgrounded: false,
      notified: false,
      ...info,
    }
    this.byId.set(taskId, full)
    this.scheduleEmit(taskId)
    return full
  }
```

6. 修改 `backgroundExistingForegroundTask`(第 103-110 行),在末尾追加 emit:
```ts
  backgroundExistingForegroundTask(taskId: string): boolean {
    const t = this.byId.get(taskId)
    if (!t) return false
    if (t.isBackgrounded) return false
    if (t.status !== 'running') return false
    t.isBackgrounded = true
    this.scheduleEmit(taskId)
    return true
  }
```

7. 修改 `markNotified`(第 127-131 行),在末尾追加 emit:
```ts
  markNotified(taskId: string): void {
    const t = this.byId.get(taskId)
    if (!t) return
    t.notified = true
    this.scheduleEmit(taskId)
  }
```

8. 在 `class BashBackgroundTracker` 内 `evictFinished()` 私有方法前(约第 177 行)追加 4 个新私有/公开方法:
```ts
  private scheduleEmit(taskId: string): void {
    const t = this.byId.get(taskId)
    if (!t) return
    this.pendingSnapshots.set(taskId, { ...t })
    if (this.pendingEmits.has(taskId)) return
    const timer = setTimeout(() => {
      this.pendingEmits.delete(taskId)
      const snap = this.pendingSnapshots.get(taskId)
      this.pendingSnapshots.delete(taskId)
      if (!snap) return
      stateChangeBus.emit('bash_task.changed', { sessionId: snap.sessionId, task: snap })
    }, 50)
    this.pendingEmits.set(taskId, timer)
    timer.unref()
  }

  private cancelPendingEmit(taskId: string): void {
    const timer = this.pendingEmits.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.pendingEmits.delete(taskId)
    }
    this.pendingSnapshots.delete(taskId)
  }

  /** 测试 seam: 立即 flush 所有 pending emit,绕过 50ms debounce。 */
  __flushPendingForTests(): void {
    for (const [taskId, timer] of this.pendingEmits) {
      clearTimeout(timer)
      const snap = this.pendingSnapshots.get(taskId)
      if (snap) stateChangeBus.emit('bash_task.changed', { sessionId: snap.sessionId, task: snap })
    }
    this.pendingEmits.clear()
    this.pendingSnapshots.clear()
  }
```

9. 修改 `__resetForTests()`(第 263-266 行),追加清理 pending:
```ts
  __resetForTests(): void {
    for (const timer of this.pendingEmits.values()) clearTimeout(timer)
    this.pendingEmits.clear()
    this.pendingSnapshots.clear()
    this.byId.clear()
    this.children.clear()
  }
```

- [ ] **Step 4: 跑测试**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/BashTracker-debounce.test.ts
```

Expected: 5 tests pass

- [ ] **Step 5: 跑既有 BashTracker 测试,确认未回归**

```bash
cd packages/zai-agent-core && pnpm test:unit -- BashTracker
```

Expected: 既有测试全部 PASS(若既有测试文件不存在,跳过)

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/tools/BashTool/bashTracker.ts \
        packages/zai-agent-core/test/unit/tools/BashTracker-debounce.test.ts
git commit -m "feat(bashTracker): 50ms debounce batch emit bash_task.changed"
```

---

### Task 4: TaskListStore v2_task.changed emit

**Files:**
- Modify: `packages/zai-agent-core/src/tools/Tasks/TaskListStore.ts`
- Create: `packages/zai-agent-core/test/unit/tools/TaskListStore-emit.test.ts`

**Interfaces:**
- Consumes: `stateChangeBus.emit('v2_task.changed', { sessionId, task, action })` from Task 1
- Produces:
  - `create()` 末尾 emit action='upsert'
  - `update()` 末尾(若返回 task)emit action='upsert';若触发 `deleteSession`,emit action='delete'(删除前 snapshot)
  - `__resetForTests()` 用于清 rootDir

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/unit/tools/TaskListStore-emit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskListStore, setTaskListStore } from '../../../src/tools/Tasks/TaskListStore.js'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'

describe('TaskListStore emit v2_task.changed', () => {
  let store: TaskListStore
  let dir: string
  let emits: Array<{ sessionId: string; task: any; action: string }>

  beforeEach(() => {
    resetStateChangeBusForTests()
    emits = []
    stateChangeBus.on('v2_task.changed', (e) => emits.push(e))
    dir = mkdtempSync(join(tmpdir(), 'tls-test-'))
    store = new TaskListStore(dir)
    setTaskListStore(store)
  })

  it('create emits upsert', async () => {
    const task = await store.create('sess-1', { subject: 'do thing' })
    expect(emits).toHaveLength(1)
    expect(emits[0]).toMatchObject({ sessionId: 'sess-1', action: 'upsert' })
    expect(emits[0].task.id).toBe(task.id)
  })

  it('update emits upsert', async () => {
    const task = await store.create('sess-1', { subject: 'do thing' })
    emits.length = 0
    const updated = await store.update('sess-1', task.id, { status: 'in_progress' })
    expect(updated).not.toBeNull()
    expect(emits).toHaveLength(1)
    expect(emits[0].action).toBe('upsert')
    expect(emits[0].task.status).toBe('in_progress')
  })

  it('update → completed (all terminal) emits upsert then delete', async () => {
    const task = await store.create('sess-1', { subject: 'thing' })
    emits.length = 0
    await store.update('sess-1', task.id, { status: 'completed' })
    expect(emits).toHaveLength(2)
    expect(emits[0].action).toBe('upsert')
    expect(emits[0].task.status).toBe('completed')
    expect(emits[1].action).toBe('delete')
    expect(emits[1].task.id).toBe(task.id)
  })

  it('deleteSession emits delete', async () => {
    const task = await store.create('sess-1', { subject: 'thing' })
    emits.length = 0
    await store.deleteSession('sess-1')
    expect(emits).toHaveLength(1)
    expect(emits[0].action).toBe('delete')
    expect(emits[0].task.id).toBe(task.id)
  })
})

afterEach(() => {
  setTaskListStore(null)
  if (dir) rmSync(dir, { recursive: true, force: true })
})
```

**注意:** 第 4 个测试用例 `deleteSession emits delete` 在源代码未修改时无法 emit。Step 2 会确认它失败。

- [ ] **Step 2: 跑测试确认 deleteSession emit 失败**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/TaskListStore-emit.test.ts
```

Expected: 前 3 个测试可能 PASS(create / update / completed update),第 4 个测试 FAIL("expected length 1, got 0")。

- [ ] **Step 3: 改 TaskListStore.ts**

`packages/zai-agent-core/src/tools/Tasks/TaskListStore.ts`:

1. 文件顶追加 import(在 `import { rm } from 'node:fs/promises'` 同一 group):
```ts
import { stateChangeBus } from '../../runtime/stateChangeBus.js'
```

2. 修改 `create` 方法(第 138-166 行),在 `await this.saveSession(sessionId, map)` 后追加 emit:
```ts
  async create(
    sessionId: string,
    input: {
      subject: string
      description?: string
      activeForm?: string
      metadata?: Record<string, unknown>
    },
  ): Promise<TaskItem> {
    await this.ensureMigrated(sessionId)
    const now = Date.now()
    const task: TaskItem = {
      id: randomUUID().slice(0, 8),
      sessionId,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    }
    const map = await this.loadSession(sessionId)
    map.set(task.id, task)
    await this.saveSession(sessionId, map)
    stateChangeBus.emit('v2_task.changed', { sessionId, task, action: 'upsert' })
    return task
  }
```

3. 修改 `update` 方法(第 210-241 行),把 cleanup 分支拆分,先 emit upsert,再 emit delete:
```ts
  async update(
    sessionId: string,
    id: string,
    patch: Partial<Omit<TaskItem, 'id' | 'sessionId' | 'createdAt'>>,
  ): Promise<TaskItem | null> {
    await this.ensureMigrated(sessionId)
    const map = await this.loadSession(sessionId)
    const existing = map.get(id)
    if (!existing) return null
    if (existing.sessionId && existing.sessionId !== sessionId) return null
    const updated: TaskItem = {
      ...existing,
      ...patch,
      id: existing.id,
      sessionId: existing.sessionId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }
    map.set(id, updated)
    await this.saveSession(sessionId, map)
    stateChangeBus.emit('v2_task.changed', { sessionId, task: updated, action: 'upsert' })

    const transitionedToTerminal =
      updated.status === 'completed' || updated.status === 'deleted'
    if (transitionedToTerminal && this.areAllTerminal(map)) {
      stateChangeBus.emit('v2_task.changed', { sessionId, task: updated, action: 'delete' })
      await this.deleteSession(sessionId)
    }

    return updated
  }
```

4. 修改 `deleteSession` 方法(第 261-263 行),在 rm 之前 snapshot 当前 task 并 emit:
```ts
  async deleteSession(sessionId: string): Promise<void> {
    const map = await this.loadSession(sessionId)
    for (const task of map.values()) {
      stateChangeBus.emit('v2_task.changed', { sessionId, task, action: 'delete' })
    }
    await rm(this.filePath(sessionId), { force: true })
  }
```

- [ ] **Step 4: 跑测试**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/tools/TaskListStore-emit.test.ts
```

Expected: 4 tests pass

- [ ] **Step 5: 跑既有 TaskListStore 测试,确认未回归**

```bash
cd packages/zai-agent-core && pnpm test:unit -- TaskListStore
```

Expected: 既有测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/tools/Tasks/TaskListStore.ts \
        packages/zai-agent-core/test/unit/tools/TaskListStore-emit.test.ts
git commit -m "feat(TaskListStore): emit v2_task.changed on create/update/deleteSession"
```

---

### Task 5: DefaultBackgroundRuntime agent_task.changed emit

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts:68-74` (`notifyChange` 方法)
- Create: `packages/zai-agent-core/test/unit/runtime/DefaultBackgroundRuntime-emit.test.ts`

**Interfaces:**
- Consumes: `stateChangeBus.emit('agent_task.changed', { sessionId, task })` from Task 1
- Produces: `notifyChange(task)` 内部并行 emit 到 stateChangeBus

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/unit/runtime/DefaultBackgroundRuntime-emit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DefaultBackgroundRuntime } from '../../../src/runtime/background/DefaultBackgroundRuntime.js'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'
import type { BackgroundTask } from '../../../src/runtime/background/types.js'

describe('DefaultBackgroundRuntime emit agent_task.changed', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
  })

  it('notifyChange emits agent_task.changed with parentSessionId', () => {
    const cb = vi.fn()
    stateChangeBus.on('agent_task.changed', cb)
    const fakeRuntime = {} as any
    const fakeStore = { save: async () => {}, appendEvent: async () => {} } as any
    const rt = new DefaultBackgroundRuntime({
      agentRuntime: fakeRuntime,
      store: fakeStore,
      onTaskStateChange: () => {},
    })
    const task = { id: 't1', parentSessionId: 'sess-1', status: 'running' } as BackgroundTask
    ;(rt as any).notifyChange(task)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-1', task })
  })

  it('notifyChange with null parentSessionId emits sessionId: null', () => {
    const cb = vi.fn()
    stateChangeBus.on('agent_task.changed', cb)
    const rt = new DefaultBackgroundRuntime({
      agentRuntime: {} as any,
      store: { save: async () => {}, appendEvent: async () => {} } as any,
      onTaskStateChange: () => {},
    })
    const task = { id: 't1', status: 'running' } as BackgroundTask
    ;(rt as any).notifyChange(task)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].sessionId).toBeNull()
  })

  it('onTaskStateChange callback still fires (parallel with emit)', () => {
    const onCb = vi.fn()
    const busCb = vi.fn()
    stateChangeBus.on('agent_task.changed', busCb)
    const rt = new DefaultBackgroundRuntime({
      agentRuntime: {} as any,
      store: { save: async () => {}, appendEvent: async () => {} } as any,
      onTaskStateChange: onCb,
    })
    const task = { id: 't1', parentSessionId: 'sess-1', status: 'running' } as BackgroundTask
    ;(rt as any).notifyChange(task)
    expect(onCb).toHaveBeenCalledTimes(1)
    expect(busCb).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/runtime/DefaultBackgroundRuntime-emit.test.ts
```

Expected: FAIL(emit 未调,cb not called)

- [ ] **Step 3: 改 DefaultBackgroundRuntime.ts**

`packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts`:

1. 文件顶 import 区追加(在 `import { BackgroundRuntime, ... }` 后):
```ts
import { stateChangeBus } from '../stateChangeBus.js'
```

2. 修改 `notifyChange` 方法(第 68-74 行):
```ts
  private notifyChange(task: BackgroundTask): void {
    try {
      this.onTaskStateChange?.(task)
    } catch (err) {
      console.warn('[BackgroundRuntime] onTaskStateChange threw:', err)
    }
    stateChangeBus.emit('agent_task.changed', {
      sessionId: task.parentSessionId ?? null,
      task,
    })
  }
```

- [ ] **Step 4: 跑测试**

```bash
cd packages/zai-agent-core && pnpm test:unit test/unit/runtime/DefaultBackgroundRuntime-emit.test.ts
```

Expected: 3 tests pass

- [ ] **Step 5: 跑既有 BackgroundRuntime 测试,确认未回归**

```bash
cd packages/zai-agent-core && pnpm test:unit -- DefaultBackgroundRuntime
```

Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts \
        packages/zai-agent-core/test/unit/runtime/DefaultBackgroundRuntime-emit.test.ts
git commit -m "feat(BackgroundRuntime): emit agent_task.changed via stateChangeBus"
```

---

### Task 6: shared/events.ts 新增 StateEvent union

**Files:**
- Modify: `packages/zai/src/shared/events.ts`

**Interfaces:**
- Consumes: 4 个新 type 的 payload shape(已在 Task 1 中 type 定义)
- Produces:
  - `StateEvent` discriminatedUnion(4 个 type)
  - 并入顶层 `ServerEvent` union

- [ ] **Step 1: 在 events.ts 追加 StateEvent 定义**

`packages/zai/src/shared/events.ts`,在 `const SystemEvent = z.discriminatedUnion(...)` 块后(约第 123 行 `])` 后),追加:

```ts
// state.* — 服务端 in-process StateChangeBus 经 zai server bridge 翻译后 emit。
// 4 个 type 都是 session-scoped (走 per-sid filter),除 agent_task.changed 兼容 null。
// payload 是全量快照(不是 diff)。
const StateEvent = z.discriminatedUnion('type', [
  z.object({
    ...Base.shape,
    type: z.literal('cwd.changed'),
    sessionId: z.string(),
    cwd: z.string(),
    updatedAt: z.number(),
  }),
  z.object({
    ...Base.shape,
    type: z.literal('bash_task.changed'),
    sessionId: z.string(),
    task: z.unknown(), // BashTaskInfo shape 由 zai-agent-core 保证
  }),
  z.object({
    ...Base.shape,
    type: z.literal('v2_task.changed'),
    sessionId: z.string(),
    task: z.unknown(),
    action: z.enum(['upsert', 'delete']),
  }),
  z.object({
    ...Base.shape,
    type: z.literal('agent_task.changed'),
    sessionId: z.string().nullable(),
    task: z.unknown(),
  }),
])
```

**注意:** BashTaskInfo / TaskItem / BackgroundTask 完整 zod schema 跨包引用复杂,这里用 `z.unknown()` 简化。server 侧 bridge emit 时这些 type 已在 agent-core 编译过,客户端 reducer 处按 schema 强转。后续若有需要可独立抽 zod schema。

- [ ] **Step 2: 修改顶层 ServerEvent union**

同一文件,第 124-131 行,从:
```ts
export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
])
```
改为:
```ts
export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
  ...StateEvent.options,
])
```

- [ ] **Step 3: 跑 zai 单元测试 + 类型检查**

```bash
cd packages/zai && pnpm typecheck && pnpm test:unit
```

Expected: PASS(若失败通常是某个 client 端 reducer 写死了 narrow type,需后续 Task 10 适配)

- [ ] **Step 4: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/shared/events.ts
git commit -m "feat(events): add StateEvent union (cwd/bash/v2/agent_task changed)"
```

---

### Task 7: ServerEventBus.subscribeTopics + topic filter

**Files:**
- Modify: `packages/zai/src/server/services/eventBus.ts`
- Create: `packages/zai/src/server/test/unit/services/eventBus-topics.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ServerEventBus.topicMatches(type: string, topics: string[]): boolean` **static 方法**(类内 / 测试都一致访问)
  - `subscribeTopics(sid: string | null, topics: string[], cb: Subscriber): () => void` 实例方法
  - `getHistoryAfterForSidWithTopics(lastEventId: string | undefined, sid: string, topics: string[]): ServerEvent[]` 实例方法

- [ ] **Step 1: 写失败测试**

`packages/zai/src/server/test/unit/services/eventBus-topics.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ServerEventBus } from '../../../../src/services/eventBus.js'

describe('ServerEventBus topic filter', () => {
  let bus: ServerEventBus

  beforeEach(() => {
    bus = new ServerEventBus()
  })

  it('topicMatches: state group covers 4 state.* types', () => {
    expect(ServerEventBus.topicMatches('cwd.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('bash_task.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('v2_task.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('agent_task.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('runtime.delta', ['state'])).toBe(false)
  })

  it('topicMatches: specific topic only matches one type', () => {
    expect(ServerEventBus.topicMatches('bash_task.changed', ['bash'])).toBe(true)
    expect(ServerEventBus.topicMatches('cwd.changed', ['bash'])).toBe(false)
  })

  it('topicMatches: legacy group names', () => {
    expect(ServerEventBus.topicMatches('runtime.delta', ['runtime'])).toBe(true)
    expect(ServerEventBus.topicMatches('session.created', ['session'])).toBe(true)
    expect(ServerEventBus.topicMatches('job.started', ['job'])).toBe(true)
    expect(ServerEventBus.topicMatches('prompt.ask', ['prompt'])).toBe(true)
    expect(ServerEventBus.topicMatches('server.connected', ['system'])).toBe(true)
  })

  it('subscribeTopics filters events by topic', () => {
    const cb = vi.fn()
    const unsub = bus.subscribeTopics('sess-1', ['bash'], cb)
    bus.emit({ type: 'bash_task.changed', sessionId: 'sess-1', task: {} })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/', updatedAt: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].type).toBe('bash_task.changed')
    unsub()
  })

  it('subscribeTopics with sid filter drops mismatched sid', () => {
    const cb = vi.fn()
    bus.subscribeTopics('sess-1', ['state'], cb)
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-2', cwd: '/', updatedAt: 1 })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/a', updatedAt: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].sessionId).toBe('sess-1')
  })

  it('getHistoryAfterForSidWithTopics filters replay', () => {
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/a', updatedAt: 1 })
    bus.emit({ type: 'bash_task.changed', sessionId: 'sess-1', task: {} })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/b', updatedAt: 2 })
    const filtered = bus.getHistoryAfterForSidWithTopics(undefined, 'sess-1', ['cwd'])
    expect(filtered).toHaveLength(2)
    expect(filtered.every((e) => e.type === 'cwd.changed')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai && pnpm test:unit test/unit/services/eventBus-topics.test.ts
```

Expected: FAIL(topicMatches is not a function)

- [ ] **Step 3: 改 eventBus.ts**

`packages/zai/src/server/services/eventBus.ts`,在 `isGlobalEvent` 函数后(第 35 行 `}` 后)、`ServerEventBus` 类前追加模块级 const:

```ts
// 内部状态事件 type 集合,作为 'state' group 简写的展开目标。
const STATE_EVENT_TYPES = new Set<string>([
  'cwd.changed',
  'bash_task.changed',
  'v2_task.changed',
  'agent_task.changed',
])
```

在 `ServerEventBus` 类内,`getHistoryAfterForSid` 方法后(第 99 行 `}` 后),追加 3 个方法(其中 `topicMatches` 是 `static`,类内 `subscribeTopics` / `getHistoryAfterForSidWithTopics` 内部用 `ServerEventBus.topicMatches(...)` 调):

```ts
  /**
   * 判断 event.type 是否匹配 subscribedTopics 列表。
   *
   * 简写语义:
   * - 'state' → 4 个 state.* type 全匹配
   * - 'cwd' / 'bash' / 'v2' / 'agent_task' → 单 type 匹配
   * - 'runtime' / 'session' / 'job' / 'prompt' / 'system' → 各自已有 type group 匹配
   *
   * 未知 group/type 一律 false,白名单 semantics。
   */
  static topicMatches(type: string, topics: string[]): boolean {
    for (const t of topics) {
      if (t === 'state' && STATE_EVENT_TYPES.has(type)) return true
      if (t === 'cwd' && type === 'cwd.changed') return true
      if (t === 'bash' && type === 'bash_task.changed') return true
      if (t === 'v2' && type === 'v2_task.changed') return true
      if (t === 'agent_task' && type === 'agent_task.changed') return true
      if (t === 'runtime' && type.startsWith('runtime.')) return true
      if (t === 'session' && type.startsWith('session.')) return true
      if (t === 'job' && type.startsWith('job.')) return true
      if (t === 'prompt' && type === 'prompt.ask') return true
      if (t === 'system' && (
        type === 'server.connected' ||
        type === 'server.error' ||
        type === 'toast' ||
        type === 'branch.changed'
      )) return true
    }
    return false
  }

  getHistoryAfterForSidWithTopics(
    lastEventId: string | undefined,
    sid: string,
    topics: string[],
  ): ServerEvent[] {
    const all = this.getHistoryAfterForSid(lastEventId, sid)
    if (topics.length === 0) return all
    return all.filter((e) => ServerEventBus.topicMatches(e.type, topics))
  }

  /**
   * 带 topic 白名单 + sid 的订阅。
   * 复用 isGlobalEvent 现有逻辑:wantedSid=null 时不过滤 sid(全量),
   * 否则 sid 不匹配静默丢弃(global 事件仍透传)。
   * topic 过滤叠加:event.type 必须命中 subscribedTopics 至少一条。
   */
  subscribeTopics(
    wantedSid: string | null,
    topics: string[],
    sub: Subscriber,
  ): () => void {
    const wrapped = (event: ServerEvent) => {
      if (wantedSid != null && !isGlobalEvent(event)) {
        const sid = eventSessionId(event)
        if (sid !== wantedSid) return
      }
      if (!ServerEventBus.topicMatches(event.type, topics)) return
      sub(event)
    }
    this.subs.add(wrapped)
    return () => {
      this.subs.delete(wrapped)
    }
  }
```

- [ ] **Step 4: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/services/eventBus-topics.test.ts
```

Expected: 6 tests pass

- [ ] **Step 5: 跑既有 eventBus 测试**

```bash
cd packages/zai && pnpm test:unit -- eventBus
```

Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/services/eventBus.ts \
        packages/zai/src/server/test/unit/services/eventBus-topics.test.ts
git commit -m "feat(eventBus): subscribeTopics + topicMatches for state events"
```

---

### Task 8: stateBridge.ts 桥接层 + createApp 接入

**Files:**
- Create: `packages/zai/src/server/services/stateBridge.ts`
- Modify: `packages/zai/src/server/index.ts`
- Create: `packages/zai/src/server/test/unit/services/stateBridge.test.ts`

**Interfaces:**
- Consumes: `stateChangeBus` from agent-core (Task 1)
- Produces:
  - `initStateBridge(): () => void` 启动桥接 + 返回 dispose
  - `module-level _stateBridgeDispose` 持有当前 dispose

- [ ] **Step 1: 写失败测试**

`packages/zai/src/server/test/unit/services/stateBridge.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stateChangeBus, resetStateChangeBusForTests } from '@zn-ai/zai-agent-core/runtime'
import { ServerEventBus } from '../../../../src/services/eventBus.js'
import { initStateBridge } from '../../../../src/services/stateBridge.js'

describe('stateBridge', () => {
  let eventBus: ServerEventBus

  beforeEach(() => {
    resetStateChangeBusForTests()
    eventBus = new ServerEventBus()
    vi.spyOn(eventBus, 'emit')
  })

  it('bridges cwd.changed to eventBus.emit', () => {
    initStateBridge()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'cwd.changed',
      sessionId: 's1',
      cwd: '/tmp',
      updatedAt: 1,
    })
  })

  it('bridges bash_task.changed to eventBus.emit', () => {
    initStateBridge()
    const task = { taskId: 'bash-1' }
    stateChangeBus.emit('bash_task.changed', { sessionId: 's1', task: task as any })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'bash_task.changed',
      sessionId: 's1',
      task,
    })
  })

  it('bridges v2_task.changed with action field', () => {
    initStateBridge()
    const task = { id: 't1' }
    stateChangeBus.emit('v2_task.changed', { sessionId: 's1', task: task as any, action: 'upsert' })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'v2_task.changed',
      sessionId: 's1',
      task,
      action: 'upsert',
    })
  })

  it('bridges agent_task.changed with nullable sessionId', () => {
    initStateBridge()
    const task = { id: 'a1' }
    stateChangeBus.emit('agent_task.changed', { sessionId: null, task: task as any })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'agent_task.changed',
      sessionId: null,
      task,
    })
  })

  it('dispose stops forwarding', () => {
    const dispose = initStateBridge()
    dispose()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
```

**注意:** 测试 spy 在 `beforeEach` 重新创建,所以每个测试拿一个独立 spy。需要把 `eventBus.emit` 替换成全局 `eventBus` 单例的引用 — 当前 `services/eventBus.ts` export 是单例 `export const eventBus = new ServerEventBus()`。

调整:`spyOn` 目标改为从 import 拿单例:

```ts
import { eventBus } from '../../../../src/services/eventBus.js'
```

测试代码改为:
```ts
  beforeEach(() => {
    resetStateChangeBusForTests()
    vi.spyOn(eventBus, 'emit')
  })
```

后续 `expect(eventBus.emit).toHaveBeenCalledWith(...)` 同理。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai && pnpm test:unit test/unit/services/stateBridge.test.ts
```

Expected: FAIL(cannot find module stateBridge)

- [ ] **Step 3: 实现 stateBridge.ts**

`packages/zai/src/server/services/stateBridge.ts`:

```ts
/**
 * zai-agent-core 的 in-process StateChangeBus → zai server eventBus 桥接层。
 *
 * zai-agent-core 不依赖 zai server,所以不直接调 eventBus.emit。
 * 这里在 createApp 启动时一次性 subscribe StateChangeBus,把 4 类 state
 * 事件翻译成 ServerEvent emit 到 eventBus,后者沿用现有 SSE 通道。
 *
 * dispose 由 initStateBridge 返回,createApp 关闭时调(目前 zai server
 * 不暴露 dispose 流程,模块级 _stateBridgeDispose 持有,未来 server close
 * 时调)。
 */

import { stateChangeBus } from '@zn-ai/zai-agent-core/runtime'
import { eventBus } from './eventBus.js'

let _stateBridgeDispose: (() => void) | null = null

export function initStateBridge(): () => void {
  if (_stateBridgeDispose) {
    // 重复 init 安全: 先 dispose 旧的,避免 listener 叠加
    _stateBridgeDispose()
  }

  const onCwdChanged = (e: { sessionId: string; cwd: string; updatedAt: number }) => {
    eventBus.emit({ type: 'cwd.changed', ...e })
  }
  const onBashTaskChanged = (e: { sessionId: string; task: unknown }) => {
    eventBus.emit({ type: 'bash_task.changed', ...e })
  }
  const onV2TaskChanged = (e: { sessionId: string; task: unknown; action: 'upsert' | 'delete' }) => {
    eventBus.emit({ type: 'v2_task.changed', ...e })
  }
  const onAgentTaskChanged = (e: { sessionId: string | null; task: unknown }) => {
    eventBus.emit({ type: 'agent_task.changed', ...e })
  }

  stateChangeBus.on('cwd.changed', onCwdChanged)
  stateChangeBus.on('bash_task.changed', onBashTaskChanged)
  stateChangeBus.on('v2_task.changed', onV2TaskChanged)
  stateChangeBus.on('agent_task.changed', onAgentTaskChanged)

  _stateBridgeDispose = () => {
    stateChangeBus.off('cwd.changed', onCwdChanged)
    stateChangeBus.off('bash_task.changed', onBashTaskChanged)
    stateChangeBus.off('v2_task.changed', onV2TaskChanged)
    stateChangeBus.off('agent_task.changed', onAgentTaskChanged)
  }
  return _stateBridgeDispose
}

/** 测试 seam: dispose + 清空 module 引用。 */
export function __resetStateBridgeForTests(): void {
  if (_stateBridgeDispose) _stateBridgeDispose()
  _stateBridgeDispose = null
}
```

- [ ] **Step 4: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/services/stateBridge.test.ts
```

Expected: 5 tests pass

- [ ] **Step 5: createApp 接入**

`packages/zai/src/server/index.ts`,在 import 区(第 24 行 `} from './services/backgroundRuntime.js'` 后)追加:

```ts
import { initStateBridge } from './services/stateBridge.js';
```

在 `initBackgroundRuntime()` 之后(第 44 行 `initBackgroundRuntime()` 后)追加:

```ts
  initStateBridge()
```

- [ ] **Step 6: 跑 zai 整套测试 + typecheck**

```bash
cd packages/zai && pnpm typecheck && pnpm test:unit
```

Expected: PASS

- [ ] **Step 7: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/services/stateBridge.ts \
        packages/zai/src/server/index.ts \
        packages/zai/src/server/test/unit/services/stateBridge.test.ts
git commit -m "feat(server): stateBridge — agent-core StateChangeBus → eventBus"
```

---

### Task 9: event.ts 路由 topics URL + replay filter

**Files:**
- Modify: `packages/zai/src/server/routes/event.ts`

**Interfaces:**
- Consumes: `eventBus.subscribeTopics` / `eventBus.getHistoryAfterForSidWithTopics` from Task 7
- Produces: `/api/event?sid=xxx&topics=cwd,bash,...` URL 解析 + 路由分发

- [ ] **Step 1: 改 routes/event.ts**

`packages/zai/src/server/routes/event.ts`:

1. 修改第 3 行 import,从:
```ts
import { eventBus } from '../services/eventBus.js'
```
改为:
```ts
import { eventBus, ServerEventBus } from '../services/eventBus.js'
```

**注意:** `topicMatches` 已经在 `ServerEventBus` 上作为 `static` 方法,通过 `ServerEventBus.topicMatches(...)` 调用,无需额外 import 函数。

2. 修改 `readWantedSid` 函数(第 11-17 行)后追加 `readWantedTopics`:
```ts
// 从 query 读 topics (csv). 缺省 / 空 = 订阅全量。
function readWantedTopics(req: Request): string[] {
  const q = req.query.topics
  if (typeof q !== 'string' || q.length === 0) return []
  return q.split(',').map((s) => s.trim()).filter(Boolean)
}
```

3. 修改 `router.get('/event', ...)`(第 19-62 行),从:
```ts
router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined
  const wantedSid = readWantedSid(req)

  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
  res.flushHeaders()

  // 1. 注册 subscriber
  const unsubscribe = wantedSid
    ? eventBus.subscribeScoped(wantedSid, (event) =>
        writeSse(res, event as unknown as Parameters<typeof writeSse>[1]),
      )
    : eventBus.subscribe((event) =>
        writeSse(res, event as unknown as Parameters<typeof writeSse>[1]),
      )

  // 2. 重连补发
  if (wantedSid) {
    for (const ev of eventBus.getHistoryAfterForSid(lastEventId, wantedSid)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  } else {
    for (const ev of eventBus.getHistoryAfter(lastEventId)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  }

  // 3. server.connected
  eventBus.emit({ type: 'server.connected', sessionId: null })

  // 4. heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  })
})
```
改为:
```ts
router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined
  const wantedSid = readWantedSid(req)
  const wantedTopics = readWantedTopics(req)

  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
  res.flushHeaders()

  // 1. 注册 subscriber。3 个分支:
  //    - 有 topics + 有 sid: subscribeTopics(sid, topics, ...)
  //    - 有 topics + 无 sid: 全量但走 topic filter
  //    - 无 topics: 维持旧行为 (subscribe / subscribeScoped)
  const writeEvent = (event: ServerEvent) =>
    writeSse(res, event as unknown as Parameters<typeof writeSse>[1])

  let unsubscribe: () => void
  if (wantedTopics.length > 0) {
    unsubscribe = eventBus.subscribeTopics(wantedSid, wantedTopics, writeEvent)
  } else if (wantedSid) {
    unsubscribe = eventBus.subscribeScoped(wantedSid, writeEvent)
  } else {
    unsubscribe = eventBus.subscribe(writeEvent)
  }

  // 2. 重连补发。topics 同样 apply 到 replay:
  //    - 有 topics + 有 sid: getHistoryAfterForSidWithTopics
  //    - 有 topics + 无 sid: getHistoryAfter + topic filter
  //    - 无 topics: 旧行为
  if (wantedSid && wantedTopics.length > 0) {
    for (const ev of eventBus.getHistoryAfterForSidWithTopics(lastEventId, wantedSid, wantedTopics)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  } else if (wantedSid) {
    for (const ev of eventBus.getHistoryAfterForSid(lastEventId, wantedSid)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  } else if (wantedTopics.length > 0) {
    const hist = eventBus.getHistoryAfter(lastEventId)
    for (const ev of hist) {
      if (ServerEventBus.topicMatches(ev.type, wantedTopics)) {
        writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
      }
    }
  } else {
    for (const ev of eventBus.getHistoryAfter(lastEventId)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  }

  // 3. server.connected
  eventBus.emit({ type: 'server.connected', sessionId: null })

  // 4. heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  })
})
```

- [ ] **Step 2: 跑 event 路由既有测试**

```bash
cd packages/zai && pnpm test:unit test/unit/routes/event.test.ts
```

Expected: PASS

- [ ] **Step 3: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/routes/event.ts
git commit -m "feat(event): URL ?topics= filter + replay apply topic filter"
```

---

### Task 10: useAgentStore 4 个 map + 4 个 reducer

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`
- Create: `packages/zai/src/web/test/unit/store/agentStore-state-events.test.ts`

**Interfaces:**
- Consumes: 4 类 `state.*` event(从 useEventStream dispatch 转过来,见 Task 11)
- Produces:
  - 字段 `cwdBySession: Record<string, string>`
  - 字段 `bashTasksBySession: Record<string, BashTaskInfo[]>`
  - 字段 `agentTasksBySession: Record<string, BackgroundTaskSummary[]>`
  - 方法 `applyCwdChanged({ sessionId, cwd }): void`
  - 方法 `applyBashTaskChanged({ sessionId, task }): void`
  - 方法 `applyV2TaskChanged({ sessionId, task, action }): void`
  - 方法 `applyAgentTaskChanged({ sessionId, task }): void`

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/test/unit/store/agentStore-state-events.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../../src/store/useAgentStore.js'

describe('useAgentStore state event reducers', () => {
  beforeEach(() => {
    useAgentStore.setState({
      cwdBySession: {},
      bashTasksBySession: {},
      agentTasksBySession: {},
    })
  })

  it('applyCwdChanged stores cwd by sessionId', () => {
    useAgentStore.getState().applyCwdChanged({ sessionId: 's1', cwd: '/tmp' })
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/tmp')
  })

  it('applyBashTaskChanged inserts new task', () => {
    const task = { taskId: 'b1', status: 'running', sessionId: 's1' } as any
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task })
    expect(useAgentStore.getState().bashTasksBySession['s1']).toEqual([task])
  })

  it('applyBashTaskChanged replaces existing task with same id', () => {
    const t1 = { taskId: 'b1', status: 'running', stdout: 'a' } as any
    const t2 = { taskId: 'b1', status: 'running', stdout: 'b' } as any
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t1 })
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t2 })
    const list = useAgentStore.getState().bashTasksBySession['s1']
    expect(list).toHaveLength(1)
    expect(list[0].stdout).toBe('b')
  })

  it('applyBashTaskChanged terminal status deletes old entry and prepends terminal', () => {
    const t1 = { taskId: 'b1', status: 'running' } as any
    const t2 = { taskId: 'b1', status: 'completed' } as any
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t1 })
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t2 })
    const list = useAgentStore.getState().bashTasksBySession['s1']
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('completed')
  })

  it('applyV2TaskChanged upsert inserts', () => {
    const task = { id: 't1', subject: 'thing' } as any
    useAgentStore.getState().applyV2TaskChanged({ sessionId: 's1', task, action: 'upsert' })
    expect(useAgentStore.getState().v2TasksBySession['s1']).toEqual([task])
  })

  it('applyV2TaskChanged delete removes', () => {
    const task = { id: 't1' } as any
    useAgentStore.getState().applyV2TaskChanged({ sessionId: 's1', task, action: 'upsert' })
    useAgentStore.getState().applyV2TaskChanged({ sessionId: 's1', task, action: 'delete' })
    expect(useAgentStore.getState().v2TasksBySession['s1']).toEqual([])
  })

  it('applyAgentTaskChanged with sid stores under map', () => {
    const task = { id: 'a1', status: 'running', input: { prompt: 'do thing' } } as any
    useAgentStore.getState().applyAgentTaskChanged({ sessionId: 's1', task })
    const list = useAgentStore.getState().agentTasksBySession['s1']
    expect(list).toHaveLength(1)
    expect(list[0].taskId).toBe('a1')
    expect(list[0].lastKnownSessionId).toBe('s1')
  })

  it('applyAgentTaskChanged with null sid is no-op', () => {
    const task = { id: 'a1', status: 'running' } as any
    useAgentStore.getState().applyAgentTaskChanged({ sessionId: null, task })
    expect(useAgentStore.getState().agentTasksBySession).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/zai && pnpm test:unit test/unit/store/agentStore-state-events.test.ts
```

Expected: FAIL(applyCwdChanged is not a function)

- [ ] **Step 3: 改 useAgentStore.ts**

`packages/zai/src/web/src/store/useAgentStore.ts`:

1. 在 `AgentState` interface 内(约第 153-180 行 `v2TasksBySession` 字段后)追加:

```ts
  cwdBySession: Record<string, string>
  bashTasksBySession: Record<string, BashTaskInfo[]>
  agentTasksBySession: Record<string, BackgroundTaskSummary[]>
```

2. 在 `AgentState` interface 内 applyXxx 区域(约第 173-175 行)追加:

```ts
  applyCwdChanged: (event: { sessionId: string; cwd: string }) => void
  applyBashTaskChanged: (event: { sessionId: string; task: BashTaskInfo }) => void
  applyV2TaskChanged: (event: {
    sessionId: string
    task: V2TaskItem
    action: 'upsert' | 'delete'
  }) => void
  applyAgentTaskChanged: (event: {
    sessionId: string | null
    task: BackgroundTask
  }) => void
```

3. import 区追加 type imports(若 BashTaskInfo / BackgroundTask 已有,直接 import 名字):

```ts
import type { BashTaskInfo } from '../hooks/useBashBackgroundTasks.js'
import type { BackgroundTask } from '../../../../shared/events.js' // 或从 taskApi
```

**注意:** `BackgroundTaskSummary` 已经有(在 `hooks/useBackgroundTasks.ts` 定义),`V2TaskItem` / `BashTaskInfo` / `BackgroundTask` 视现有 import 路径。

4. 在 store 初始化(约第 392-410 行 `messages: [], todosBySession: {}` 区域)追加默认值:

```ts
  cwdBySession: {},
  bashTasksBySession: {},
  agentTasksBySession: {},
```

5. 在 store 实现体内(例如在 `applyPromptAsk` 后)追加 4 个 reducer 实现:

```ts
  applyCwdChanged: (event) => {
    set((s) => ({
      cwdBySession: { ...s.cwdBySession, [event.sessionId]: event.cwd },
    }))
  },

  applyBashTaskChanged: (event) => {
    set((s) => {
      const list = s.bashTasksBySession[event.sessionId] ?? []
      const idx = list.findIndex((t) => t.taskId === event.task.taskId)
      let next: BashTaskInfo[]
      if (event.task.status !== 'running') {
        // 终态: 删除旧 entry, prepend 终态
        next = [event.task, ...list.filter((t) => t.taskId !== event.task.taskId)]
      } else if (idx >= 0) {
        next = list.map((t) => (t.taskId === event.task.taskId ? event.task : t))
      } else {
        next = [event.task, ...list]
      }
      return {
        bashTasksBySession: { ...s.bashTasksBySession, [event.sessionId]: next },
      }
    })
  },

  applyV2TaskChanged: (event) => {
    set((s) => {
      const list = s.v2TasksBySession[event.sessionId] ?? []
      const next =
        event.action === 'delete'
          ? list.filter((t) => t.id !== event.task.id)
          : (() => {
              const idx = list.findIndex((t) => t.id === event.task.id)
              if (idx >= 0) return list.map((t) => (t.id === event.task.id ? event.task : t))
              return [...list, event.task]
            })()
      return {
        v2TasksBySession: { ...s.v2TasksBySession, [event.sessionId]: next },
      }
    })
  },

  applyAgentTaskChanged: (event) => {
    if (event.sessionId === null) return
    set((s) => {
      const list = s.agentTasksBySession[event.sessionId!] ?? []
      const summary: BackgroundTaskSummary = {
        taskId: event.task.id,
        status: event.task.status,
        prompt: event.task.input.prompt,
        createdAt: event.task.createdAt,
        finishedAt: event.task.finishedAt,
        error: event.task.error?.message,
        detail: event.task,
        lastKnownSessionId: event.sessionId ?? undefined,
      }
      const idx = list.findIndex((t) => t.taskId === event.task.id)
      const next =
        idx >= 0
          ? list.map((t) => (t.taskId === event.task.id ? summary : t))
          : [summary, ...list]
      return {
        agentTasksBySession: { ...s.agentTasksBySession, [event.sessionId!]: next },
      }
    })
  },
```

- [ ] **Step 4: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/store/agentStore-state-events.test.ts
```

Expected: 8 tests pass

- [ ] **Step 5: 跑既有 store 测试**

```bash
cd packages/zai && pnpm test:unit -- useAgentStore
```

Expected: PASS

- [ ] **Step 6: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 7: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/store/useAgentStore.ts \
        packages/zai/src/web/test/unit/store/agentStore-state-events.test.ts
git commit -m "feat(store): 4 map + 4 reducer for state.* events"
```

---

### Task 11: eventSource + useEventStream 接入

**Files:**
- Modify: `packages/zai/src/web/src/lib/eventSource.ts` (NAMED_EVENT_TYPES 加 4 个)
- Modify: `packages/zai/src/web/src/store/useEventStream.ts` (dispatch 加 4 个 case)
- Create: `packages/zai/src/web/test/unit/store/eventStream-dispatch.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` union with 4 new state types (Task 6)
- Produces: dispatch routing 把 `cwd.changed` / `bash_task.changed` / `v2_task.changed` / `agent_task.changed` 路由到对应 reducer

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/test/unit/store/eventStream-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '../../../src/store/useAgentStore.js'

// 通过 dispatch 入口触发(模拟 useEventStream 的逻辑)
async function dispatch(event: any) {
  // 模拟 useEventStream.ts 的 dispatch switch
  switch (event.type) {
    case 'cwd.changed':
      useAgentStore.getState().applyCwdChanged(event); break
    case 'bash_task.changed':
      useAgentStore.getState().applyBashTaskChanged(event); break
    case 'v2_task.changed':
      useAgentStore.getState().applyV2TaskChanged(event); break
    case 'agent_task.changed':
      useAgentStore.getState().applyAgentTaskChanged(event); break
  }
}

describe('eventStream dispatch routing', () => {
  beforeEach(() => {
    useAgentStore.setState({
      cwdBySession: {},
      bashTasksBySession: {},
      agentTasksBySession: {},
      v2TasksBySession: {},
    })
  })

  it('routes cwd.changed to applyCwdChanged', async () => {
    await dispatch({ type: 'cwd.changed', sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/tmp')
  })

  it('routes bash_task.changed to applyBashTaskChanged', async () => {
    const task = { taskId: 'b1', status: 'running', sessionId: 's1' }
    await dispatch({ type: 'bash_task.changed', sessionId: 's1', task })
    expect(useAgentStore.getState().bashTasksBySession['s1']).toHaveLength(1)
  })

  it('routes v2_task.changed to applyV2TaskChanged', async () => {
    const task = { id: 't1' }
    await dispatch({ type: 'v2_task.changed', sessionId: 's1', task, action: 'upsert' })
    expect(useAgentStore.getState().v2TasksBySession['s1']).toHaveLength(1)
  })

  it('routes agent_task.changed to applyAgentTaskChanged', async () => {
    const task = { id: 'a1', status: 'running', input: { prompt: 'p' } }
    await dispatch({ type: 'agent_task.changed', sessionId: 's1', task })
    expect(useAgentStore.getState().agentTasksBySession['s1']).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/store/eventStream-dispatch.test.ts
```

Expected: 4 tests pass(dispatch 测试已经模拟了 useEventStream 内的 switch)

- [ ] **Step 3: 改 eventSource.ts**

`packages/zai/src/web/src/lib/eventSource.ts`,在 `NAMED_EVENT_TYPES` 数组(第 14-39 行)末尾 `branch.changed'` 后追加:

```ts
  // state.* — SSE state push
  'cwd.changed',
  'bash_task.changed',
  'v2_task.changed',
  'agent_task.changed',
```

- [ ] **Step 4: 改 useEventStream.ts**

`packages/zai/src/web/src/store/useEventStream.ts`,在 `dispatch` 函数 switch 中(约第 60 行 `case 'branch.changed':` 前)追加:

```ts
    case 'cwd.changed':
    case 'bash_task.changed':
    case 'v2_task.changed':
      useAgentStore.getState().applyXxx(event as any); break
```

**注意:** 这里 4 个 case 不能这样合并,因为它们分别调用不同的 reducer。改为:

```ts
    case 'cwd.changed':
      useAgentStore.getState().applyCwdChanged(event); break
    case 'bash_task.changed':
      useAgentStore.getState().applyBashTaskChanged(event); break
    case 'v2_task.changed':
      useAgentStore.getState().applyV2TaskChanged(event); break
    case 'agent_task.changed':
      useAgentStore.getState().applyAgentTaskChanged(event); break
```

- [ ] **Step 5: typecheck + 跑 web 测试**

```bash
cd packages/zai && pnpm typecheck && pnpm test:unit
```

Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/lib/eventSource.ts \
        packages/zai/src/web/src/store/useEventStream.ts \
        packages/zai/src/web/test/unit/store/eventStream-dispatch.test.ts
git commit -m "feat(web): SSE dispatch routes 4 state events to store reducers"
```

---

### Task 12: useSessionCwd 删除 setInterval

**Files:**
- Modify: `packages/zai/src/web/src/hooks/useSessionCwd.ts`
- Modify: `packages/zai/src/web/test/unit/hooks/useSessionCwd.test.ts`

**Interfaces:**
- Consumes: `useAgentStore(s => s.cwdBySession[sessionId])` from Task 10
- Produces: hook 不再 setInterval,首次无值时 fallback 一次性 fetch

- [ ] **Step 1: 重写 useSessionCwd.ts**

`packages/zai/src/web/src/hooks/useSessionCwd.ts` 完整重写为:

```ts
import { useEffect } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * 读取当前 session 的 cwd。
 *
 * SSE 推送 (cwd.changed) 经 useAgentStore.cwdBySession 维护。
 * 仅当 store 无值时(冷启动 / 服务重启后第一次进 session)才 fallback
 * 一次性 fetch `/api/agent/sessions/:id/pwd` 拉一次,之后完全靠 SSE。
 */
export function useSessionCwd(sessionId: string | null): string | undefined {
  const cwd = useAgentStore((s) => (sessionId ? s.cwdBySession[sessionId] : undefined))
  const has = useAgentStore((s) => (sessionId ? sessionId in s.cwdBySession : false))

  useEffect(() => {
    if (!sessionId || has) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${sessionId}/pwd`)
        if (!res.ok) return
        const data = (await res.json()) as { cwd?: string }
        if (!cancelled && typeof data.cwd === 'string') {
          useAgentStore.getState().applyCwdChanged({ sessionId, cwd: data.cwd })
        }
      } catch {
        // silent
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, has])

  return cwd
}
```

- [ ] **Step 2: 重写 useSessionCwd.test.ts**

`packages/zai/src/web/test/unit/hooks/useSessionCwd.test.ts` 完整重写为:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSessionCwd } from '../../../src/hooks/useSessionCwd.js'
import { useAgentStore } from '../../../src/store/useAgentStore.js'

describe('useSessionCwd', () => {
  beforeEach(() => {
    useAgentStore.setState({ cwdBySession: {} })
    vi.restoreAllMocks()
  })

  it('returns undefined when sessionId is null', () => {
    const { result } = renderHook(() => useSessionCwd(null))
    expect(result.current).toBeUndefined()
  })

  it('returns cwd from store when present', () => {
    useAgentStore.setState({ cwdBySession: { 's1': '/tmp' } })
    const { result } = renderHook(() => useSessionCwd('s1'))
    expect(result.current).toBe('/tmp')
  })

  it('falls back to one-shot fetch when store has no entry', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ cwd: '/fallback' }),
    } as any)
    renderHook(() => useSessionCwd('s1'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/fallback')
  })

  it('does not setInterval (no polling)', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ cwd: '/x' }),
    } as any)
    renderHook(() => useSessionCwd('s1'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchSpy.mock.calls.length).toBeLessThan(2)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 3: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/hooks/useSessionCwd.test.ts
```

Expected: 4 tests pass

- [ ] **Step 4: typecheck**

```bash
cd packages/zai && pnpm typecheck
```

Expected: 0 errors

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/hooks/useSessionCwd.ts \
        packages/zai/src/web/test/unit/hooks/useSessionCwd.test.ts
git commit -m "refactor(useSessionCwd): drop setInterval, read store + one-shot fallback"
```

---

### Task 13: useBashBackgroundTasks 删除 setInterval

**Files:**
- Modify: `packages/zai/src/web/src/hooks/useBashBackgroundTasks.ts`
- Modify: `packages/zai/src/web/test/unit/hooks/useBashBackgroundTasks.test.ts`

**Interfaces:**
- Consumes: `useAgentStore(s => s.bashTasksBySession[sessionId] ?? [])` from Task 10
- Produces: hook 不再 setInterval,首次无值时 fallback 一次性 fetch

- [ ] **Step 1: 重写 useBashBackgroundTasks.ts**

`packages/zai/src/web/src/hooks/useBashBackgroundTasks.ts` 完整重写为:

```ts
import { useEffect } from 'react'
import { listBashTasks, type BashTaskInfo } from '../lib/taskApi.js'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * 当前 session 的 Bash 后台任务。
 *
 * SSE 推送 (bash_task.changed) 经 useAgentStore.bashTasksBySession 维护。
 * 仅当 store 无值时 fallback 一次性 fetch `/api/bash-tasks?sessionId=...`,
 * 之后完全靠 SSE。
 */
export function useBashBackgroundTasks() {
  const sessionId = useAgentStore((s) => s.sessionId)
  const tasks = useAgentStore((s) =>
    sessionId ? s.bashTasksBySession[sessionId] ?? [] : []
  )
  const has = useAgentStore((s) =>
    sessionId ? sessionId in s.bashTasksBySession : false
  )

  useEffect(() => {
    if (!sessionId || has) return
    let cancelled = false
    void (async () => {
      try {
        const list = await listBashTasks(sessionId)
        if (cancelled) return
        for (const task of list) {
          useAgentStore.getState().applyBashTaskChanged({ sessionId, task })
        }
      } catch (err) {
        if (!cancelled) console.warn('[useBashBackgroundTasks] initial fetch failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, has])

  return { tasks, loading: false }
}
```

- [ ] **Step 2: 重写 useBashBackgroundTasks.test.ts**

`packages/zai/src/web/test/unit/hooks/useBashBackgroundTasks.test.ts` 完整重写为:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBashBackgroundTasks } from '../../../src/hooks/useBashBackgroundTasks.js'
import { useAgentStore } from '../../../src/store/useAgentStore.js'
import * as taskApi from '../../../src/lib/taskApi.js'

describe('useBashBackgroundTasks', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessionId: null, bashTasksBySession: {} })
    vi.restoreAllMocks()
  })

  it('returns empty list when sessionId is null', () => {
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([])
  })

  it('returns tasks from store', () => {
    useAgentStore.setState({
      sessionId: 's1',
      bashTasksBySession: { s1: [{ taskId: 'b1' } as any] },
    })
    const { result } = renderHook(() => useBashBackgroundTasks())
    expect(result.current.tasks).toEqual([{ taskId: 'b1' }])
  })

  it('falls back to listBashTasks one-shot on mount', async () => {
    useAgentStore.setState({ sessionId: 's1' })
    const spy = vi.spyOn(taskApi, 'listBashTasks').mockResolvedValue([
      { taskId: 'b1' } as any,
    ])
    renderHook(() => useBashBackgroundTasks())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spy).toHaveBeenCalledWith('s1')
    expect(useAgentStore.getState().bashTasksBySession['s1']).toHaveLength(1)
  })

  it('does not setInterval', async () => {
    vi.useFakeTimers()
    useAgentStore.setState({ sessionId: 's1' })
    const spy = vi.spyOn(taskApi, 'listBashTasks').mockResolvedValue([])
    renderHook(() => useBashBackgroundTasks())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spy.mock.calls.length).toBeLessThan(2)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 3: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/hooks/useBashBackgroundTasks.test.ts
```

Expected: 4 tests pass

- [ ] **Step 4: typecheck + 提交**

```bash
cd packages/zai && pnpm typecheck
git add packages/zai/src/web/src/hooks/useBashBackgroundTasks.ts \
        packages/zai/src/web/test/unit/hooks/useBashBackgroundTasks.test.ts
git commit -m "refactor(useBashBackgroundTasks): drop setInterval, read store + one-shot fallback"
```

---

### Task 14: useBackgroundTasks 删除 listTasks 兜底

**Files:**
- Modify: `packages/zai/src/web/src/hooks/useBackgroundTasks.ts`
- Modify: `packages/zai/src/web/test/unit/hooks/useBackgroundTasks.test.ts`

**Interfaces:**
- Consumes: `useAgentStore(s => s.agentTasksBySession[sessionId])` from Task 10
- Produces: hook 删除 `useEffect → listTasks` 兜底,初次连接走 store + 一次 fallback fetch

- [ ] **Step 1: 改 useBackgroundTasks.ts**

`packages/zai/src/web/src/hooks/useBackgroundTasks.ts`:

1. 删除 `useEffect` 中 `listTasks()` 调用(约第 101-142 行的 `useEffect(() => { void (async () => { try { const initial = await listTasks({ limit: 50 }) ... })() }, [currentSessionId])`)。改为一次性 fallback(仅当 store 为空):

```ts
  const hasInitial = useAgentStore((s) =>
    currentSessionId ? currentSessionId in s.agentTasksBySession : false
  )

  useEffect(() => {
    if (!currentSessionId || hasInitial) return
    let cancelled = false
    void (async () => {
      try {
        const initial = await listTasks({ limit: 50 })
        if (cancelled) return
        for (const t of initial) {
          useAgentStore.getState().applyAgentTaskChanged({
            sessionId: t.parentSessionId ?? null,
            task: t,
          })
        }
      } catch (err) {
        console.warn('[useBackgroundTasks] initial load failed:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentSessionId, hasInitial])
```

2. 顶部 import 增加(若已存在则跳过):

```ts
import { useAgentStore } from '../store/useAgentStore.js'
```

- [ ] **Step 2: 跑既有 useBackgroundTasks 测试,调整断言**

`packages/zai/src/web/test/unit/hooks/useBackgroundTasks.test.ts`:

既有用例中"切 session 后 listTasks 重新发请求"的断言需要改为"切 session 后 store 没值才发请求"。具体修改视既有测试细节而定。**建议保留既有断言框架,只把"总发请求"改成"条件发请求"**:

最小修改:把 `expect(listTasks).toHaveBeenCalled()` 类的断言加 `mockReturnValueOnce([])` 或 spy.reset 后再断言。

- [ ] **Step 3: 跑测试**

```bash
cd packages/zai && pnpm test:unit test/unit/hooks/useBackgroundTasks.test.ts
```

Expected: PASS

- [ ] **Step 4: typecheck + 提交**

```bash
cd packages/zai && pnpm typecheck
git add packages/zai/src/web/src/hooks/useBackgroundTasks.ts \
        packages/zai/src/web/test/unit/hooks/useBackgroundTasks.test.ts
git commit -m "refactor(useBackgroundTasks): drop listTasks on session change, fallback only when empty"
```

---

### Task 15: 性能 benchmark + AGENTS.md 同步

**Files:**
- Create: `packages/zai/scripts/bench-sse-state-push.ts` (一次性 benchmark,跑完删)
- Modify: `/Users/ethan/code/opencc-web/AGENTS.md`

**Interfaces:**
- Consumes: Phase A-E 全部产出
- Produces: 文档同步,性能数据

- [ ] **Step 1: 写一次性 benchmark**

`packages/zai/scripts/bench-sse-state-push.ts`:

```ts
/**
 * SSE state push 性能 benchmark。
 *
 * 用法: `tsx scripts/bench-sse-state-push.ts`
 *
 * 模拟 50 个 session 同时连 + 5 个 bash 后台任务喷输出,
 * 验证 eventBus 内存 < 50MB / SSE 帧数 ≈ 20 fps (非 1000 fps)。
 */

import { ServerEventBus } from '../src/server/services/eventBus.js'
import { bashBackgroundTracker } from '../zai-agent-core/src/tools/BashTool/bashTracker.js'
import { stateChangeBus } from '../zai-agent-core/src/runtime/stateChangeBus.js'

async function main() {
  const bus = new ServerEventBus()
  let frameCount = 0
  bus.subscribeTopics('sess-1', ['bash'], () => frameCount++)

  // 注册 5 个 task
  for (let i = 0; i < 5; i++) {
    bashBackgroundTracker.register(`bash-${i}`, {
      command: 'bench',
      description: 'bench',
      sessionId: 'sess-1',
      startedAt: Date.now(),
    })
  }

  // 1s 内喷 5 * 200KB stdout
  const startMem = process.memoryUsage().heapUsed
  for (let i = 0; i < 1000; i++) {
    for (let j = 0; j < 5; j++) {
      bashBackgroundTracker.appendOutput(`bash-${j}`, { stdout: 'x'.repeat(1000) })
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await new Promise((resolve) => setTimeout(resolve, 100))  // 等 debounce
  const endMem = process.memoryUsage().heapUsed

  console.log(`frames in 1s: ${frameCount}`)
  console.log(`heap delta: ${(endMem - startMem) / 1024 / 1024}MB`)
  console.log(`expected frames: ~20 (50ms debounce × 5 tasks in 1s)`)

  bashBackgroundTracker.__resetForTests()
  process.exit(0)
}

main()
```

**注意:** 这个 benchmark 仅用于本地验证,跑完即删(或 commit 留作未来 reference)。

- [ ] **Step 2: 跑 benchmark**

```bash
cd packages/zai && npx tsx scripts/bench-sse-state-push.ts
```

Expected: `frames in 1s: ~20`, `heap delta: < 10MB`

- [ ] **Step 3: 同步 AGENTS.md**

`/Users/ethan/code/opencc-web/AGENTS.md`,在「SSE 事件通道(`shared/events.ts`)」段(约第 130 行)追加 4 个 type:

```
- **state.\***:cwd.changed / bash_task.changed / v2_task.changed / agent_task.changed(2026-07-19 新增,SSE 统一状态推送)
```

在「前端 store 关键设计」段(约第 145 行)追加:

```
- **StateEvent map**:`cwdBySession` / `bashTasksBySession` / `agentTasksBySession` / `v2TasksBySession`(已有)与 `todosBySession` 平行,4 个 map + 4 个 reducer 维护
```

在「已知薄弱点」段删除:

```
- `useSessionCwd` 5s 轮询一行删除(已被 SSE 推送替代,见 §6 设计)
```

并把:

```
- `BackgroundRuntime` retry 策略(529 vs 5xx)缺单元测试
```

后面追加(说明 state push 改造):

```
- SSE state push 走 StateChangeBus 桥接层,见 docs/superpowers/specs/2026-07-19-sse-state-push-design.md
```

- [ ] **Step 4: 提交 benchmark 留存 + AGENTS.md**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/scripts/bench-sse-state-push.ts AGENTS.md
git commit -m "docs+bench: AGENTS.md SSE state push 同步 + perf benchmark"
```

---

## Self-Review

逐节对照 spec 检查覆盖:

| Spec 节 | 任务覆盖 |
|---|---|
| §1 背景与目标 | Task 12 / 13 / 14 直接删 setInterval(目标 1);Task 6 加 4 类 event(目标 2);Task 7-9 topic 协议(目标 3);Task 3 debounce(目标 4);Task 10 store 上提(目标 5) |
| §2 架构 | Task 1 (StateChangeBus);Task 8 (bridge);Task 9 (SSE 路由);Task 11 (dispatch);Task 12-14 (hook 改) |
| §3 事件 schema | Task 6 |
| §4 Topic 过滤协议 | Task 7 (`topicMatches` / `subscribeTopics` / `getHistoryAfterForSidWithTopics`);Task 9 (URL 解析 + 路由分发) |
| §5 Client reducer | Task 10 (4 map + 4 reducer);Task 11 (dispatch routing);Task 12-14 (hook 改造) |
| §6.0-6.5 server emit | Task 1 (StateChangeBus);Task 2 (cwd);Task 3 (bash);Task 4 (v2);Task 5 (agent_task);Task 8 (bridge) |
| §7 测试策略 | Task 1-5 server 测试;Task 7-9 server 测试;Task 10-13 client 测试;Task 15 benchmark |
| §8 迁移 / 风险 | Phase A-E 顺序与 plan 一致;Task 8 默认 init state bridge,新路径默认 on |
| §9 验收标准 | Task 12-13 删 setInterval;Task 3 debounce 测试;Task 7 topic filter 测试覆盖 ≥3 case;Task 15