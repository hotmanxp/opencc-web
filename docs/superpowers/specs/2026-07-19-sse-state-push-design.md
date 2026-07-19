# SSE 统一状态推送 设计规格

> 把当前 `useSessionCwd`(5s 轮询)、`useBashBackgroundTasks`(15s 轮询)、以及若干 1-shot 兜底 fetch 全部迁移到 `/api/event` SSE 通道,新增 4 类状态事件(`cwd.changed` / `bash_task.changed` / `v2_task.changed` / `agent_task.changed`),按 topic 维度订阅。

---

## 1. 背景与目标

### 1.1 当前轮询点

| 状态 | 轮询点 | 间隔 | 备注 |
|---|---|---|---|
| session cwd | `useSessionCwd` | 5s | AGENTS.md 已知薄弱点:>50 session 打爆 server |
| Bash 后台任务列表 | `useBashBackgroundTasks` | 15s | tracker stdout/stderr 没 emit,只能轮询 |
| Background agent tasks | `useBackgroundTasks` 初次 + session 切换时 `listTasks` | 非定时 | job.* SSE 已在推,但 session 切换需要兜底 |
| V2 TaskList | `/v2-tasks` | 一次性 | TodoWrite 守卫把 tool_use 吞了,没 SSE |
| Agent input slash | `/api/slash` | 一次性 | 真正 1-shot,不改造 |

### 1.2 已有基础设施(复用,不重建)

- `ServerEventBus`(`packages/zai/src/server/services/eventBus.ts`):subscriber Set + 256 ring buffer + per-sid 切片 + Last-Event-ID replay。
- `GET /api/event`(`packages/zai/src/server/routes/event.ts`):单条 SSE 连接,`?sid=xxx` per-sid filter + 15s heartbeat。
- `subscribeServerEvents`(`packages/zai/src/web/src/lib/eventSource.ts`):前端 EventSource 注册 18 个 NAMED_EVENT_TYPES。

### 1.3 目标

1. **删 setInterval 轮询**:`useSessionCwd`、`useBashBackgroundTasks` 改纯订阅。
2. **新增 4 类 state 事件**,payload 是全量快照(不是 diff)。
3. **topic 维度订阅**:`/api/event?topics=cwd,bash,v2,agent_task` 显式声明,server 用 whitelist filter。
4. **降带宽**:Bash stdout/stderr 高频 emit 走 50ms debounce batch(track 内部),不击穿 SSE。
5. **store 上提**:`useBackgroundTasks` 的 local map 提到 `useAgentStore`,跨组件共享。

### 1.4 非目标 (YAGNI)

- 不实现 WebSocket / gRPC。EventSource + SSE 已经够用。
- 不实现订阅"动态增删 topic" — 前端每个 session 重建连接时一次声明。
- 不实现服务端主动 push 系统级状态(如磁盘使用率) — 留给未来。
- 不实现 multi-server 场景 — zai 当前是单 Node 进程,in-memory state 没问题。
- 不重写 `job.*` 通道 — `agent_task.changed` 与 `job.*` 并存(agent task 详情走前者,job 进度条走后者)。

---

## 2. 架构

```
┌──────────── zai-agent-core (runtime 库, 不依赖 zai server) ──────────────┐
│                                                                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │ CwdStore    │  │ BashTracker │  │ TaskList    │  │ BgRuntime   │       │
│  │ setter      │  │ 50ms debch  │  │ Store       │  │ onStateChg  │       │
│  │ BashTool    │  │ batch       │  │ append/del  │  │             │       │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │
│         │                │                │                │              │
│         └────────────────┴────────────────┴────────────────┘              │
│                                  │                                        │
│                                  ▼                                        │
│                  StateChangeBus (Node EventEmitter)                       │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ (进程内事件)
                                   ▼
┌──────────────────────── zai server (delivery 层) ──────────────────────────┐
│                                                                            │
│  stateBridge.ts: subscribe StateChangeBus → eventBus.emit                  │
│                                  │                                        │
│                                  ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │             ServerEventBus  (ext: subscribeTopics)                │     │
│  │  • topic whitelist  • per-sid history  • Last-Event-ID replay     │     │
│  └─────────────────────────────────────┬────────────────────────────┘     │
│                                        │                                  │
│                                        ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │  GET /api/event?sid=xxx&topics=cwd,bash,v2,agent_task,…           │     │
│  │  topic filter at subscribe time, replay at connect                │     │
│  └──────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────┘
                                   │ SSE
                                   ▼
┌──────────────────────────── Client (zai web) ──────────────────────────────┐
│                                                                            │
│  useEventStream  →  useAgentStore (cwdBySession / bashTasksBySession /    │
│                                  v2TasksBySession / agentTasksBySession)   │
│                                                                            │
│  useSessionCwd       ─▶ 不再 setInterval,改订阅 cwd.changed                │
│  useBashBackgroundTasks ─▶ 不再 setInterval,改订阅 bash_task.changed       │
│  useBackgroundTasks  ─▶ 不再 listTasks 兜底(初次连接 replay 已经覆盖)      │
│  useConversationInfo ─▶ 不变(一次性)                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

**关键边界**:
- **zai-agent-core 只暴露 StateChangeBus**(Node EventEmitter),**不 import zai 的 eventBus**。依赖方向单向:core → 无依赖 → server。
- **zai server 通过 `stateBridge.ts` 桥接**:把 `stateChangeBus` 事件翻译成 `eventBus.emit({type: 'cwd.changed', ...})`,复用现有 SSE 通道。
- **topic 是 server 端 first-class 概念**,前端通过 URL 参数声明,server 用 whitelist filter。
- **跨 tab 隔离仍走 sid**:subscribed topics 全局共享,但 emit 时按 `event.sessionId` 走 sid filter。

---

## 3. 事件 schema

`shared/events.ts` 当前 5 类 discriminatedUnion (`runtime.*` / `session.*` / `job.*` / `prompt.ask` / `system.*`) 扩为 6 类,新增 `StateEvent`:

```ts
const StateEvent = z.discriminatedUnion('type', [
  // cwd 状态变更 — 每个 BashTool.runShellCommand 结束后 emit
  // payload 是 session 维度的最新 cwd (全量, 不带 diff)
  z.object({
    ...Base.shape,
    type: z.literal('cwd.changed'),
    sessionId: z.string(),
    cwd: z.string(),
    /** server 时间戳, 客户端用来去重 / debug */
    updatedAt: z.number(),
  }),

  // bash 后台任务任一字段变化 — tracker 50ms debounce batch 后 emit
  // payload 是整个 BashTaskInfo 快照
  z.object({
    ...Base.shape,
    type: z.literal('bash_task.changed'),
    sessionId: z.string(),
    task: BashTaskInfoSchema, // 复用 zai-agent-core 的 BashTaskInfo zod schema
  }),

  // V2 TaskList 任一条目变化 (TaskCreate/Update/Delete tool 调后)
  // payload 是单条更新后的 V2TaskItem 快照
  z.object({
    ...Base.shape,
    type: z.literal('v2_task.changed'),
    sessionId: z.string(),
    task: V2TaskItemSchema,
    /** 'upsert' | 'delete' — 前端 reducer 一处 switch */
    action: z.enum(['upsert', 'delete']),
  }),

  // Background agent task 状态变化 — 走现有 onTaskStateChange 通道
  // payload 是整个 BackgroundTask 快照 (与 GET /api/tasks/:id 返回一致)
  z.object({
    ...Base.shape,
    type: z.literal('agent_task.changed'),
    sessionId: z.string().nullable(), // null = 全局
    task: BackgroundTaskSchema,
  }),
])

export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
  ...StateEvent.options,
])
```

**约束**:
- 所有 4 种 type **必带 `sessionId`**(除 `agent_task.changed` 的 `null` 兼容老 `job.*` 模式)。`sid` filter 不需要给 StateEvent 开特例。
- **Payload 永远是全量快照**,不是 diff。原因:丢一条不能导致后续全错,且 reducer 简单。
- 4 个 type **不属于 `isGlobalEvent` 白名单** — 走 per-sid filter。`cwd.changed` 跨 tab 不应穿透(切 session 后旧 sid 的 cwd 不应再显示)。

---

## 4. Topic 过滤协议

### 4.1 URL 协议

```
GET /api/event?sid=<sid>&topics=<csv>
```

- `topics` 可选,缺省 = 订阅全部(`['runtime','session','job','prompt','system','state']` 全 group)。
- 简写 → 内部 topic 名映射:

| 简写 | 内部 topic 名 | 包含的 event.type |
|---|---|---|
| `state` (group) | `state` | `cwd.changed` / `bash_task.changed` / `v2_task.changed` / `agent_task.changed` |
| `cwd` | `state.cwd` | `cwd.changed` |
| `bash` | `state.bash` | `bash_task.changed` |
| `v2` | `state.v2` | `v2_task.changed` |
| `agent_task` | `state.agent_task` | `agent_task.changed` |
| (兼容老) | `runtime` `session` `job` `prompt` `system` | 各自已有 type |

### 4.2 Server filter 规则

```
function matchesTopic(event, subscribedTopics):
  if 'state' in subscribedTopics and event.type in [
    'cwd.changed', 'bash_task.changed',
    'v2_task.changed', 'agent_task.changed'
  ]:
    return true
  if any('state.cwd' / 'state.bash' / 'state.v2' / 'state.agent_task')
      in subscribedTopics and event.type === thatType:
    return true
  if 'runtime' in subscribedTopics and event.type.startswith('runtime.'):
    return true
  if 'session' in subscribedTopics and event.type.startswith('session.'):
    return true
  if 'job'     in subscribedTopics and event.type.startswith('job.'):
    return true
  if 'prompt'  in subscribedTopics and event.type === 'prompt.ask':
    return true
  if 'system'  in subscribedTopics and event.type in [
    'server.connected', 'server.error', 'toast', 'branch.changed'
  ]:
    return true
  return false
```

- 兼容老 URL 不带 `topics` → 走全量转发(同今天的 `subscribe`)。
- 新 URL 带 `topics` → 走 `subscribeScoped(sid, topics, cb)` 新方法。

### 4.3 Replay 时同样应用 topic filter

```
/api/event?sid=x&topics=bash
  → Last-Event-ID 续读 + replay 都只走 bash_topic 的事件
```

实现:`getHistoryAfterForSid` + topic filter(`historyBySid.get(sid).filter(e => matchesTopic(e, topics))`)。

### 4.4 Frontend 连接策略

`useEventStream` 改为:从 zustand store 读 desiredTopics,拼到 URL 上。session 切换时 close + 重建(现有逻辑不变,只是 URL 多 `&topics=...`)。

当前所有 hook 都需要 `state` 全 group,所以 desiredTopics = `['runtime','session','job','prompt','system','state']`,跟缺省一致 — 但**显式声明**,便于将来某个组件只想要 `bash`。

---

## 5. Client reducer 改动

### 5.1 新增 store 字段

`useAgentStore` 新增 3 个 map(与现有 `todosBySession` / `v2TasksBySession` 平行):

```ts
cwdBySession: Record<string, string>                      // sid → cwd path
bashTasksBySession: Record<string, BashTaskInfo[]>       // sid → 列表 (newest first)
agentTasksBySession: Record<string, BackgroundTaskSummary[]>  // sid → 列表
```

**关键决定:`useBackgroundTasks` 的 local map 上提到 zustand store**。理由:这个 hook 当前只服务于 TaskDock 一处,但 SSE 推送是全局可消费的;后续若 TaskDrawer 之外(例如新面板)需要展示同一 session 的 task 列表,store 共享避免双源 state drift。

`v2TasksBySession` 已经存在,不动。

### 5.2 dispatch(event) 新增分支(`useEventStream.ts`)

```ts
case 'cwd.changed':
  useAgentStore.getState().applyCwdChanged(event); break
case 'bash_task.changed':
  useAgentStore.getState().applyBashTaskChanged(event); break
case 'v2_task.changed':
  useAgentStore.getState().applyV2TaskChanged(event); break
case 'agent_task.changed':
  useAppStore.getState().applyAgentTaskChanged(event); break
```

### 5.3 Reducer 方法

```ts
applyCwdChanged({ sessionId, cwd }):
  set(state => ({
    cwdBySession: { ...state.cwdBySession, [sessionId]: cwd },
  }))

applyBashTaskChanged({ sessionId, task }):
  set(state => {
    const list = state.bashTasksBySession[sessionId] ?? []
    const idx = list.findIndex(t => t.taskId === task.taskId)
    let next: BashTaskInfo[]
    if (task.status !== 'running') {
      // 终态: 删除旧 entry (running 或已存在的同 id), replace 终态
      next = [
        task,
        ...list.filter(t => t.taskId !== task.taskId),
      ]
    } else if (idx >= 0) {
      next = list.map(t => (t.taskId === task.taskId ? task : t))
    } else {
      next = [task, ...list]
    }
    return {
      bashTasksBySession: {
        ...state.bashTasksBySession,
        [sessionId]: next,
      },
    }
  })

applyV2TaskChanged({ sessionId, task, action }):
  set(state => {
    const list = state.v2TasksBySession[sessionId] ?? []
    const next =
      action === 'delete'
        ? list.filter(t => t.id !== task.id)
        : (() => {
            const idx = list.findIndex(t => t.id === task.id)
            if (idx >= 0) {
              return list.map(t => (t.id === task.id ? task : t))
            }
            return [...list, task]
          })()
    return {
      v2TasksBySession: {
        ...state.v2TasksBySession,
        [sessionId]: next,
      },
    }
  })

applyAgentTaskChanged({ sessionId, task }):
  // 走 useAppStore.jobs (已有 logic) + agentTasksBySession map 同步
  set(state => {
    if (sessionId === null) return state  // 全局, 由 job.* 通道处理
    const list = state.agentTasksBySession[sessionId] ?? []
    const idx = list.findIndex(t => t.taskId === task.id)
    const summary: BackgroundTaskSummary = {
      taskId: task.id,
      status: task.status,
      prompt: task.input.prompt,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      error: task.error?.message,
      detail: task,
      lastKnownSessionId: sessionId ?? undefined,
    }
    const next =
      idx >= 0
        ? list.map(t => (t.taskId === task.id ? summary : t))
        : [summary, ...list]
    return {
      agentTasksBySession: {
        ...state.agentTasksBySession,
        [sessionId]: next,
      },
    }
  })
```

### 5.4 Hook 改造

| Hook | Before | After |
|---|---|---|
| `useSessionCwd` | `setInterval` 5s | `useAgentStore(s => s.cwdBySession[sid])` |
| `useBashBackgroundTasks` | `setInterval` 15s | `useAgentStore(s => s.bashTasksBySession[sid] ?? [])` |
| `useBackgroundTasks` | `useEffect → listTasks()` on mount + session 切换 | 删除 `listTasks` 兜底(初次连接 SSE replay 已经覆盖),保留 `detail` 懒加载(SSE 推送的 detail 优先,fetch 兜底) |
| `useConversationInfo` | 1-shot `/api/agent/settings` | 不变 |

> 落地时序与回退策略见 §8.2(`ZAI_SSE_STATE_PUSH` feature flag 控制新 / 老路径并存 1 个 release)。

---

## 6. Server 端 emit 触发点

### 6.0 依赖边界 — 关键设计约束

`zai-agent-core` 是 runtime 库,**不依赖 zai 的 services**(具体说:不 import `eventBus`)。所有 SSE event 都在 zai server 层 emit。

为了不破坏依赖方向,设计模式:**zai-agent-core 暴露 `StateChangeBus`(in-process Node `EventEmitter`),zai server 层在启动时 subscribe `StateChangeBus` 并桥接到 `eventBus.emit`**。

```
zai-agent-core (runtime)                zai server (delivery)
─────────────────────────               ────────────────────
CwdStore.set ─┐                         initStateBridge()
BashTracker ──┼─▶ StateChangeBus ─────▶ subscribe ─▶ eventBus.emit
TaskListStore ┤                         (按 type 翻译成 SSE event)
BgRuntime    ─┘
```

`StateChangeBus` 接口:

```ts
// zai-agent-core: 新文件 src/runtime/stateChangeBus.ts
import { EventEmitter } from 'node:events'

export interface StateChangeEventMap {
  'cwd.changed': { sessionId: string; cwd: string; updatedAt: number }
  'bash_task.changed': { sessionId: string; task: BashTaskInfo }
  'v2_task.changed': { sessionId: string; task: V2TaskItem; action: 'upsert' | 'delete' }
  'agent_task.changed': { sessionId: string | null; task: BackgroundTask }
}

export const stateChangeBus = new EventEmitter() as TypedEmitter<StateChangeEventMap>

// 进程退出时清理(避免 listener leak)
export function resetStateChangeBusForTests(): void {
  stateChangeBus.removeAllListeners()
}
```

> **为什么是 Node EventEmitter 而不是 zod schema discriminated union?** 因为 `StateChangeBus` 是 in-process event,不走 SSE wire,不需要 zod 校验。schema 校验在 zai server emit 到 eventBus 时做(那里 schema 已经在 §3 定义)。

### 6.1 cwd.changed

`zai-agent-core/src/tools/BashTool/BashTool.ts` 末尾,`CwdStore.set(sessionId, newCwd)` 之后:

```ts
import { stateChangeBus } from '../../runtime/stateChangeBus.js'

CwdStore.set(sessionId, newCwd)
stateChangeBus.emit('cwd.changed', { sessionId, cwd: newCwd, updatedAt: Date.now() })
```

注意:`BashTool` 当前用 `runWithSessionId` AsyncLocalStorage 拿到 sessionId,emit 不需要额外参数(从 ALS 拿)。

### 6.2 bash_task.changed

在 `zai-agent-core/src/tools/BashTool/bashTracker.ts` 内部,所有 mutator 方法末尾调 `scheduleEmit(taskId)`,`stateChangeBus.emit` 在 50ms debounce 后 batch 触发:

```ts
import { stateChangeBus } from '../../runtime/stateChangeBus.js'

class BashBackgroundTracker {
  private pendingEmits = new Map<string, NodeJS.Timeout>()
  private pendingSnapshots = new Map<string, BashTaskInfo>()

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

  __flushPendingForTests(): void {
    for (const [taskId, timer] of this.pendingEmits) {
      clearTimeout(timer)
      const snap = this.pendingSnapshots.get(taskId)
      if (snap) stateChangeBus.emit('bash_task.changed', { sessionId: snap.sessionId, task: snap })
    }
    this.pendingEmits.clear()
    this.pendingSnapshots.clear()
  }
}
```

`markFinished` 同步立即 flush(终态不能 debounce):

```ts
markFinished(taskId, status, info): BashTaskInfo | undefined {
  // ... existing logic
  this.cancelPendingEmit(taskId)
  stateChangeBus.emit('bash_task.changed', { sessionId: t.sessionId, task: { ...t } })
  return t
}
```

### 6.3 v2_task.changed

`zai-agent-core/src/transcript/taskListStore.ts`(或对应文件)append/update/delete 路径:

```ts
import { stateChangeBus } from '../runtime/stateChangeBus.js'

async append(sid: string, item: TaskItem): Promise<void> {
  // ... existing logic
  stateChangeBus.emit('v2_task.changed', { sessionId: sid, task: trimToClientShape(item), action: 'upsert' })
}

async remove(sid: string, taskId: string): Promise<void> {
  const snapshot = this.peek(sid, taskId) // 已有或新增 helper
  // ... existing logic
  stateChangeBus.emit('v2_task.changed', { sessionId: sid, task: snapshot, action: 'delete' })
}
```

### 6.4 agent_task.changed

`zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts` 内部 `runOne` 的 task 状态变更点(创建 / 完成 / 失败 / 取消),在现有 `onTaskStateChange` 回调之前/同步调 `stateChangeBus.emit`。这样 `onTaskStateChange` 仍然是 server 注入的回调(用于 emit `job.*`),`stateChangeBus.emit` 是 agent-core 自己的活:

```ts
// 在 runOne task lifecycle 关键点:
stateChangeBus.emit('agent_task.changed', { sessionId: task.parentSessionId ?? null, task })
this.onTaskStateChange?.(task)  // 现有 callback, server 注入 emit job.*
```

> **避免重复 emit 路径**:`agent_task.changed` 与 `job.*` 各自独立,但 consumer 不同(job.\* → useAppStore 进度条;agent_task.changed → useAgentStore 详情)。server 侧 `initBackgroundRuntime` 不需要改。

### 6.5 zai server 桥接层

`packages/zai/src/server/services/stateBridge.ts`(新文件),在 `createApp` 启动时调一次:

```ts
import { stateChangeBus } from '@zn-ai/zai-agent-core/runtime'
import { eventBus } from './eventBus.js'

export function initStateBridge(): () => void {
  const onCwdChanged = (e: { sessionId: string; cwd: string; updatedAt: number }) => {
    eventBus.emit({ type: 'cwd.changed', ...e })
  }
  const onBashTaskChanged = (e: { sessionId: string; task: BashTaskInfo }) => {
    eventBus.emit({ type: 'bash_task.changed', ...e })
  }
  const onV2TaskChanged = (e: { sessionId: string; task: V2TaskItem; action: 'upsert' | 'delete' }) => {
    eventBus.emit({ type: 'v2_task.changed', ...e })
  }
  const onAgentTaskChanged = (e: { sessionId: string | null; task: BackgroundTask }) => {
    eventBus.emit({ type: 'agent_task.changed', ...e })
  }

  stateChangeBus.on('cwd.changed', onCwdChanged)
  stateChangeBus.on('bash_task.changed', onBashTaskChanged)
  stateChangeBus.on('v2_task.changed', onV2TaskChanged)
  stateChangeBus.on('agent_task.changed', onAgentTaskChanged)

  return () => {
    stateChangeBus.off('cwd.changed', onCwdChanged)
    stateChangeBus.off('bash_task.changed', onBashTaskChanged)
    stateChangeBus.off('v2_task.changed', onV2TaskChanged)
    stateChangeBus.off('agent_task.changed', onAgentTaskChanged)
  }
}
```

`createApp`(`packages/zai/src/server/index.ts`)启动顺序:在 `initBackgroundRuntime` 之后调 `initStateBridge()`,返回的 `dispose` 在 server `close` 时调。

### 6.6 与 zod schema 校验的关系

`zai-agent-core` 内部 emit 时不校验(`StateChangeBus` 是 in-process EventEmitter)。schema 校验发生在两处:
- `zai server` emit 到 `eventBus` 时(`shared/events.ts` 的 zod discriminatedUnion 已经在现有 `routes/agent.ts` 路径上隐式依赖,新增 type 自动校验)。
- `zai web` 收到 SSE 帧时(`eventSource.ts` 已 `ServerEvent.parse(JSON.parse(e.data))`)。

---

## 7. 测试策略

### 7.1 Server 端(zai-agent-core + zai server)

1. **BashTracker batching 测试**
   - 1s 内连续 `appendOutput` 100 次 → expect 只有 1 条 `bash_task.changed` 出去,payload 是最新快照。
   - 50ms timer 触发后清空 `pendingEmits` / `pendingSnapshots`。
   - 测试钩子 `__flushPendingForTests()` 立刻 flush,绕过 debounce。
   - `markFinished` 同步立即 emit,不等 debounce。

2. **CwdStore emit 测试**
   - spy `stateChangeBus` listener → `BashTool.runShellCommand` 末尾 `cd /tmp` → expect `stateChangeBus.emit('cwd.changed', …)` 1 次,cwd = `/tmp`。
   - 没变化时(同 cwd)不 emit。

3. **Topic filter 单元测试**
   - `eventBus.subscribeScoped(sid, ['bash'], cb)` 只收 `bash_task.changed`,其它静默丢弃。
   - `eventBus.subscribeScoped(sid, ['state'], cb)` 收全部 4 个 state.* type。
   - `eventBus.subscribeScoped(sid, ['cwd', 'bash'], cb)` 收 `cwd.changed` + `bash_task.changed` 两条。

4. **Replay + topic filter**
   - mock emit 5 个不同 type 事件 → `eventBus.getHistoryAfterForSid(lastId, sid, ['bash'])` 只返回 `bash_task.changed` 那条。

5. **heartbeat 兼容**:15s 不变,跨 topic 一样。

6. **agent_task.changed 路由**
   - `onTaskStateChange` 触发时 expect 既有 `job.*` event 也有 `agent_task.changed` event。
   - `parentSessionId === undefined` → emit `sessionId: null`。

### 7.2 Client 端(zai web,vitest)

1. **Reducer 纯函数测试**
   - `applyBashTaskChanged` running → completed 转换、duplicate taskId 不重复 push、终态 + 同 id 旧 running 删除。
   - `applyV2TaskChanged` upsert / delete 两条路径、新建 / 已存在两条路径。
   - `applyCwdChanged` 简单赋值覆盖。
   - `applyAgentTaskChanged` sessionId=null(全局)不写 store、具体 sid 走 map。

2. **useEventStream 集成**
   - mock EventSource,模拟 server 推送 → store 正确更新 → hook 重渲染拿到最新值。
   - sessionId 切换 → close + 重建,旧 sid 事件被 filter 丢弃。

3. **Hook 回归**
   - `useSessionCwd.test.ts` 改成"store 已有值时直接拿到,store 没值时主动触发一次 fetch"(不再 setInterval)。
   - `useBashBackgroundTasks.test.ts` 同上,首次走 store,fallback 一次性 fetch。
   - `useBackgroundTasks.test.ts` 删除 `listTasks` 兜底依赖,改为"初次连接 store 为空时主动 fetch 一次 detail"。

4. **NAMED_EVENT_TYPES 同步**
   - `eventSource.ts` 的 18 个 type list 扩为 22 个,新增 4 个 state type。

### 7.3 性能 / 负载

- 简单 benchmark:同时跑 5 个 bash 后台任务,1s 喷 1MB stdout,验证 50ms debounce 后 SSE 帧数 ≈ 20 fps 而非 1000 fps。
- 50 个 session 同时连,验证 eventBus 内存 < 10MB(每个 ring 256 条,sid 切片 256 条)。

---

## 8. 迁移 / 风险

### 8.1 迁移顺序

1. **Phase A — core 桥接层**:zai-agent-core 新增 `stateChangeBus`(Node EventEmitter)+ 4 个 emit 触发点(`CwdStore` setter / `bashTracker` mutator / `taskListStore` append/remove / `DefaultBackgroundRuntime.runOne`)。**不引入 schema 校验**(in-process 不需要)。
2. **Phase B — server schema + topic filter + bridge**:`shared/events.ts` 加 4 个新 discriminatedUnion 成员;`ServerEventBus.subscribeTopics` 新方法 + topic whitelist filter;`stateBridge.ts` 桥接层;`createApp` 启动时调 `initStateBridge()`。此时 SSE 已能推到客户端。
3. **Phase C — client store + reducer**:`useAgentStore` 新增 4 个 map + 4 个 reducer;`useEventStream` dispatch 扩 4 个 case;`eventSource.ts` `NAMED_EVENT_TYPES` 加 4 项。**不删 setInterval,新路径 + 老路径并存**。
4. **Phase D — hook 改造**:删 `useSessionCwd` / `useBashBackgroundTasks` 的 `setInterval`,改读 store;`useBackgroundTasks` 删 `listTasks` 兜底;测试同步重写。
5. **Phase E — benchmark + 文档**:50 session / 5 bash 并发跑测,AGENTS.md 同步。

### 8.2 Feature flag

`ZAI_SSE_STATE_PUSH=on` 控制是否启用:
- on:新路径(订阅 SSE)+ 老路径(setInterval)并存,新路径失败时回退到老路径(防 last-mile 风险)。
- 默认 on 1 个 release,稳定后默认 off 老路径,最后删除老路径。

### 8.3 已知风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| Bash 高 stdout 触发 emit 太频繁 | 中 | 50ms debounce + 快照 payload(不是 diff) |
| Last-Event-ID replay 时 state event 被 topic filter 错过滤 | 低 | replay 时**显式应用 topic filter**,单元测试覆盖 |
| EventSource 自动重连不带 sid(URL 被改) | 低 | 现有 useEventStream 已固定 sid + topic 在 URL,重连保留 |
| 50 session 同时连打爆 server 内存 | 中 | ring 256 + per-sid 切片 256 双 cap,与现有一致 |
| BashTool emit 在 test 环境造成泄漏 | 中 | test setup `resetStateChangeBusForTests()` 清空 listener |
| `agent_task.changed` 与 `job.*` 重复事件 | 低 | 接受重复:`job.*` 给 dock 进度条,`agent_task.changed` 给 TaskDock 详情。两者消费者不同,各自独立 |

### 8.4 文档同步

- AGENTS.md 「SSE 事件通道」段:增加 4 个新 type 描述。
- AGENTS.md 「前端 store 关键设计」段:增加 4 个新 map 字段。
- AGENTS.md 「已知薄弱点」段:`useSessionCwd` 5s 轮询一行删除。

---

## 9. 验收标准

1. `useSessionCwd` / `useBashBackgroundTasks` 文件内不再有 `setInterval`。
2. `bashBackgroundTracker.scheduleEmit` 在测试下能正确 batch。
3. `eventBus.subscribeScoped(sid, ['bash'], cb)` 单元测试覆盖 ≥ 3 个 case。
4. 50 session 并发连 + 5 个 bash 后台任务同时喷输出,服务端内存 < 50MB(`/api/event` + emit + tracker 三者总和)。
5. AGENTS.md 更新且 commit。
6. Feature flag 控制开关,可运行时切换。
