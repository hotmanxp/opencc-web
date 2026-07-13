# opencc-web 客户端-服务端稳定连接 设计规格

> 把 opencode 的 `/event` 全局 SSE 模式移植到 `@zn-ai/zai`，替换当前的 per-request POST+SSE，让所有面板状态走单一长连接。

---

## 1. 总体架构

### 1.1 现状与痛点

zai 当前每次 prompt 走 `POST /api/agent/stream`（fetch + ReadableStream 解析 SSE），事件仅在该次 HTTP 流的生命周期内传递：

- 其他面板（Session 列表侧边栏、后台 job 进度、AskUserQuestion 弹窗、login 状态）**拿不到** 运行时事件
- 流断 → 中间事件全丢，没有重连补发
- 多 Tab 各发各的 prompt，状态互不相通

### 1.2 目标

把 opencode 的全局 SSE 模式（`packages/server/src/handlers/event.ts` 的 `event.subscribe`）移植到 zai：一个常驻 `GET /api/event` 长连接推送全部事件，HTTP POST 只保留 RPC 反向通道。

### 1.3 系统拓扑

```
┌─────────────────────────────────────────────────────────────────────┐
│                       packages/zai/src/server                       │
│                                                                     │
│  ┌──────────────┐    publish()    ┌──────────────────────────────┐  │
│  │ services/    │ ──────────────▶ │ services/eventBus.ts         │  │
│  │  - agentRt   │                 │  - subscribers: Set          │  │
│  │  - askReg    │                 │  - history: ServerEvent[256] │  │
│  │  - login     │                 │  - emit / subscribe / replay  │  │
│  │  - resources │                 └─────────────┬────────────────┘  │
│  └──────────────┘                               │                   │
│                                                ▼                   │
│                                       routes/event.ts               │
│                                       GET /api/event                │
│                                       - text/event-stream           │
│                                       - Last-Event-ID replay       │
│                                       - 15s heartbeat               │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       │  SSE (one per browser tab)
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       packages/zai/src/web/src                      │
│                                                                     │
│  ┌──────────────────────┐    dispatch   ┌────────────────────────┐ │
│  │ lib/eventSource.ts   │ ────────────▶ │ store/                 │ │
│  │  - new EventSource() │  Zod parse    │  - useAgentStore       │ │
│  │  - onmessage         │               │  - useAppStore         │ │
│  │  - lastEventId 重连  │               │  - useEventStream()    │ │
│  └──────────────────────┘               └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       │  HTTP POST (RPC 反向通道)
                                       ▼
                              POST /api/agent/prompt
                              POST /api/agent/answer
                              POST /api/agent/abort
                              GET  /api/agent/sessions
                              ...
```

### 1.4 关键决策

| 维度 | 选择 |
|---|---|
| 推送通道 | 单一全局 SSE（`GET /api/event`） |
| 反向通道 | HTTP POST（RPC：prompt/answer/abort） |
| 鉴权 | 仅 localhost，无（保留现状注释） |
| 事件总线 | Node EventEmitter + Zod wrapper（方案 A） |
| 事件 schema | Zod discriminatedUnion（前后端共用 `shared/events.ts`） |
| Ring buffer | 256 条单进程共享 |
| 心跳 | 15s `": heartbeat\n\n"` 注释帧 |
| 重连 | EventSource 原生 `Last-Event-ID` header 补发 |
| 多 Tab | 每 Tab 独立 EventSource（互不干扰） |
| 运行时流接入 | 全部走 eventBus.emit；删除 `POST /api/agent/stream` |
| 反压 | 客户端慢 → 服务端 ring buffer 满 → 丢最老事件 |
| 持久化 | 不做（接受进程重启丢历史） |

---

## 2. 目录结构与文件改动

### 2.1 新增文件

```
packages/zai/src/
├── shared/
│   ├── events.ts                          # 新增：Zod discriminatedUnion 事件 schema
│   └── events.test.ts                     # 新增：schema 校验测试
├── server/
│   ├── services/
│   │   ├── eventBus.ts                    # 新增：单进程 EventBus + ring buffer
│   │   └── eventBus.test.ts               # 新增
│   └── routes/
│       └── event.ts                       # 新增：GET /api/event
└── web/src/
    ├── lib/
    │   └── eventSource.ts                 # 新增：浏览器 EventSource 封装
    └── store/
        └── useEventStream.ts              # 新增：dispatch hook
```

### 2.2 改动文件

```
packages/zai/src/
├── server/
│   ├── index.ts                           # 改动：挂 eventRouter，注入 eventBus
│   ├── routes/
│   │   ├── agent.ts                       # 改动：POST /agent/stream → /agent/prompt
│   │   └── answer.ts                      # 改动：路径前移（无 prefix bug）
│   ├── services/
│   │   └── agentRuntime.ts                # 改动：emit 替换 stream.send
│   ├── stream.ts                          # 删除（createSseStream 不再需要）
│   └── types.ts                           # 改动：删 SseEvent 类型
└── web/src/
    ├── lib/
    │   ├── sseAgent.ts                    # 删除（被 eventSource.ts + api.ts 取代）
    │   └── api.ts                         # 改动：去除 SSE 相关
    ├── store/
    │   ├── useAgentStore.ts               # 改动：加 applyRuntimeEvent 等 reducer
    │   └── useAppStore.ts                 # 改动：加 applyJobEvent / applySystemEvent
    └── App.tsx                            # 改动：顶层挂 useEventStream
```

---

## 3. 事件 Schema

新增 `packages/zai/src/shared/events.ts`，前后端共用。

### 3.1 基础字段

```ts
import { z } from 'zod'

const Base = z.object({
  eventId: z.string(),         // 服务端分配的递增 ID
  ts: z.number(),              // Date.now()
})
```

### 3.2 事件分类（按四大面板状态）

**运行时流（runtime.*）**：
```ts
const RuntimeEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('runtime.started'),
             sessionId: z.string(), turnIndex: z.number() }),
  z.object({ ...Base.shape, type: z.literal('runtime.delta'),
             sessionId: z.string(), turnIndex: z.number(),
             delta: z.string() }),
  z.object({ ...Base.shape, type: z.literal('runtime.tool_call'),
             sessionId: z.string(), turnIndex: z.number(),
             toolName: z.string(), input: z.unknown() }),
  z.object({ ...Base.shape, type: z.literal('runtime.tool_result'),
             sessionId: z.string(), turnIndex: z.number(),
             toolUseId: z.string(), output: z.unknown() }),
  z.object({ ...Base.shape, type: z.literal('runtime.done'),
             sessionId: z.string(), turnIndex: z.number(),
             usage: z.object({ input: z.number(), output: z.number() }).optional() }),
  z.object({ ...Base.shape, type: z.literal('runtime.aborted'),
             sessionId: z.string(), turnIndex: z.number(),
             reason: z.string() }),
  z.object({ ...Base.shape, type: z.literal('runtime.error'),
             sessionId: z.string(), turnIndex: z.number(),
             error: z.object({ category: z.string(), message: z.string(),
                               recoverable: z.boolean() }) }),
])
```

**Session 列表（session.*）**：
```ts
const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('session.created'),
             sessionId: z.string(), title: z.string(), cwd: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.deleted'),
             sessionId: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.renamed'),
             sessionId: z.string(), title: z.string() }),
])
```

**后台任务（job.*）**：
```ts
const JobEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('job.started'),
             jobId: z.string(), kind: z.enum(['resource_refresh','login','install']) }),
  z.object({ ...Base.shape, type: z.literal('job.progress'),
             jobId: z.string(), message: z.string(), percent: z.number().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.done'),
             jobId: z.string(), result: z.unknown().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.failed'),
             jobId: z.string(), error: z.string() }),
])
```

**权限/错误/系统（prompt.* / server.* / toast）**：
```ts
const PromptEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('prompt.ask'),
             sessionId: z.string(), toolUseId: z.string(),
             questions: z.array(z.object({
               question: z.string(), header: z.string(),
               options: z.array(z.object({
                 label: z.string(), description: z.string().optional(),
               })),
             })) }),
])

const SystemEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('server.connected'),
             sessionId: z.string().nullable() }),
  z.object({ ...Base.shape, type: z.literal('server.error'),
             message: z.string() }),
  z.object({ ...Base.shape, type: z.literal('toast'),
             level: z.enum(['info','warn','error']), message: z.string() }),
])

export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
])
export type ServerEvent = z.infer<typeof ServerEvent>
```

---

## 4. 服务端：EventBus

`packages/zai/src/server/services/eventBus.ts`：

```ts
import { ServerEvent } from '../../shared/events.js'

type Subscriber = (event: ServerEvent) => void

const CAPACITY = 256
let counter = 0
const nextId = () => `evt_${Date.now().toString(36)}_${(++counter).toString(36)}`

class ServerEventBus {
  private subs = new Set<Subscriber>()
  private history: ServerEvent[] = []

  emit(event: Omit<ServerEvent, 'eventId' | 'ts'> & { eventId?: string; ts?: number }) {
    const full = { ...event, eventId: event.eventId ?? nextId(), ts: event.ts ?? Date.now() } as ServerEvent
    this.history.push(full)
    if (this.history.length > CAPACITY) this.history.shift()
    for (const sub of this.subs) {
      try { sub(full) } catch (err) {
        console.error('[eventBus] subscriber threw', err)
      }
    }
  }

  /** 给 SSE 路由用：拿到 lastEventId 之后的 replay 切片 */
  getHistoryAfter(lastEventId?: string): ServerEvent[] {
    if (lastEventId === undefined) return []
    const idx = this.history.findIndex(e => e.eventId === lastEventId)
    if (idx < 0) return [...this.history]
    return this.history.slice(idx + 1)
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub)
    return () => { this.subs.delete(sub) }
  }
}

export const eventBus = new ServerEventBus()
```

**特性**：
- 同步派发；subscriber 抛错只 log，不影响其他订阅者
- 单进程一份 ring buffer；每个 SSE 连接独立 `subscribe`，补发时各自切片（零拷贝）
- `eventId` 单调递增（同进程内）；服务端分配保证唯一

---

## 5. 服务端：SSE 路由

`packages/zai/src/server/routes/event.ts`：

```ts
import { Router, type IRouter, type Request, type Response } from 'express'
import { ServerEvent } from '../../shared/events.js'
import { eventBus } from '../services/eventBus.js'

const router: IRouter = Router()
const HEARTBEAT_MS = 15_000

router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // 1. 立即发 server.connected（让客户端知道订阅已生效）
  eventBus.emit({ type: 'server.connected', sessionId: null })

  // 2. 重连补发
  for (const ev of eventBus.getHistoryAfter(lastEventId)) writeSse(res, ev)

  // 3. 注册为新 subscriber
  const unsubscribe = eventBus.subscribe((event) => writeSse(res, event))

  // 4. 心跳
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  })
})

function writeSse(res: Response, event: ServerEvent) {
  res.write(`id: ${event.eventId}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export default router
```

`packages/zai/src/server/index.ts` 挂载（**最前面**，让浏览器尽早拿到订阅）：

```ts
app.use('/api', eventRouter)
app.use('/api', healthRouter)
app.use('/api', systemRouter)
// ...
```

---

## 6. 服务端：runtime 接入

`packages/zai/src/server/routes/agent.ts` 的 `POST /agent/stream` 改名为 `POST /agent/prompt`，立即返回 sessionId，事件走 eventBus：

```ts
router.post('/agent/prompt', async (req, res) => {
  const parsed = PromptRequest.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' })

  const { prompt, cwd = process.cwd(), sessionId: existing } = parsed.data
  const sessionId = existing ?? newSessionId()
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort('timeout'), HARD_TIMEOUT_MS)

  req.on('close', () => {
    if (!abortController.signal.aborted) abortController.abort('client_disconnect')
    getAskRegistry().abortAll('client_disconnect')
  })

  // 异步 fire-and-forget；事件走 eventBus → /api/event SSE
  void (async () => {
    try {
      eventBus.emit({ type: 'session.created', sessionId, title: deriveTitle(prompt), cwd })
      for await (const event of runtime.run({
        prompt, cwd, abortSignal: abortController.signal,
      })) {
        eventBus.emit({ ...event, sessionId })
        if (event.type === 'runtime.done' || event.type === 'runtime.aborted') break
      }
    } catch (err) {
      eventBus.emit({
        type: 'runtime.error', sessionId, turnIndex: 0,
        error: { category: 'internal', message: String(err), recoverable: false },
      })
    } finally {
      clearTimeout(timer)
    }
  })()

  res.json({ sessionId })
})
```

`AskRegistry` 内部不变（仍是后端等 Promise）；触发侧同时 `eventBus.emit({ type: 'prompt.ask', ... })`，客户端从 SSE 收到后弹 AskDialog，POST `/api/agent/answer` 触发 resolve。

---

## 7. 前端：EventSource 订阅

`packages/zai/src/web/src/lib/eventSource.ts`：

```ts
import { ServerEvent } from '../../../shared/events.js'

const API_BASE = '/api'

export interface StreamHandle { close: () => void }

export function subscribeServerEvents(
  onEvent: (event: ServerEvent) => void,
  onError?: (err: Event) => void,
): StreamHandle {
  const es = new EventSource(`${API_BASE}/event`)

  es.onmessage = (e) => {
    try {
      const parsed = ServerEvent.parse(JSON.parse(e.data))
      onEvent(parsed)
    } catch (err) {
      console.error('[eventSource] parse failed', err, e.data)
    }
  }

  es.onerror = (e) => { onError?.(e) }
  return { close: () => es.close() }
}
```

`packages/zai/src/web/src/store/useEventStream.ts`：

```ts
import { useEffect } from 'react'
import { subscribeServerEvents } from '../lib/eventSource.js'
import { useAgentStore } from './useAgentStore.js'
import { useAppStore } from './useAppStore.js'
import type { ServerEvent } from '../../../shared/events.js'

export function useEventStream(): void {
  useEffect(() => {
    const handle = subscribeServerEvents(dispatch)
    return () => handle.close()
  }, [])
}

function dispatch(event: ServerEvent) {
  switch (event.type) {
    case 'runtime.started':
    case 'runtime.delta':
    case 'runtime.tool_call':
    case 'runtime.tool_result':
    case 'runtime.done':
    case 'runtime.aborted':
    case 'runtime.error':
      useAgentStore.getState().applyRuntimeEvent(event); break
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
      useAgentStore.getState().applySessionEvent(event); break
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
      useAppStore.getState().applyJobEvent(event); break
    case 'prompt.ask':
      useAgentStore.getState().applyPromptAsk(event); break
    case 'server.connected':
      useAppStore.getState().setConnected(true); break
    case 'server.error':
    case 'toast':
      useAppStore.getState().applySystemEvent(event); break
  }
}
```

`App.tsx` 顶层挂载：

```tsx
import { useEventStream } from './store/useEventStream'

export default function App() {
  useEventStream()   // ★ 整 app 只一个 EventSource
  return <Routes>...</Routes>
}
```

删除 `web/src/lib/sseAgent.ts` 整文件。

新 prompt 调用：

```ts
async function sendPrompt(prompt: string) {
  const { sessionId } = await api.post<{ sessionId: string }>('/agent/prompt', { prompt, cwd })
  useAgentStore.getState().setActiveSession(sessionId)
}
```

---

## 8. 数据流示例

**单条 prompt 全流程**：

```
browser                          HTTP POST           EventBus → SSE
  │  POST /agent/prompt ─────────────────────────▶│
  │  { prompt, cwd }                              │
  │                                                │
  │  ◀──── { sessionId: "s_42" } ────────────────│
  │                                                │
  │  setActiveSession("s_42")                      │
  │                                                ▼
  │                                       eventBus.emit({
  │                                         type:'session.created',
  │                                         sessionId:"s_42" })
  │                                                │
  │                                       runtime.run() ...
  │                                                │
  │                                       for await (event) {
  │  ◀──── SSE: runtime.started ──────────────────│
  │  ◀──── SSE: runtime.delta ────────────────────│  eventBus.emit(...)
  │  ◀──── SSE: runtime.tool_call ───────────────│
  │  ◀──── SSE: runtime.tool_result ──────────────│
  │  ◀──── SSE: runtime.done ────────────────────│
  │                                       }
```

**断线重连**：

```
browser                        EventSource auto-reconnect
  │  ← SSE: ...server.connected (lastEventId=evt_xxx)
  │
  │   拔网线
  │
  │   恢复后 EventSource 自动重连
  │  ─────── GET /api/event ───▶  Last-Event-ID: evt_xxx
  │  ◀────── 200 text/event-stream
  │  ◀────── id: evt_xxx+1, data: ...   ← 历史补发
  │  ◀────── id: evt_xxx+2, data: ...
  │  ◀────── : heartbeat
  │  ◀────── id: <new>, data: ...      ← live 续上
```

---

## 9. 错误处理与边界

### 9.1 网络抖动 / 客户端断网
- EventSource 原生自动重连；浏览器自动带 `Last-Event-ID` 头
- 服务端 `getHistoryAfter` 找到 → 补发之后；找不到（已被淘汰）→ 补全部
- 客户端 onerror 只 console.error，不影响 store 状态

### 9.2 服务端进程重启
- 所有 SSE 连接断
- ring buffer 在内存中，重启清空
- 客户端重连 → `Last-Event-ID` 找不到 → 服务端补全部空（只剩新事件）
- **MVP 接受** 中间事件丢失；UI 通过 `GET /api/agent/sessions/:id` 拉快照重建

### 9.3 HARD_TIMEOUT（5 分钟）
- `POST /agent/prompt` 内 `setTimeout` 触发 `abortController.abort('timeout')`
- runtime 收到 abort → `eventBus.emit({ type: 'runtime.aborted', reason: 'timeout' })`
- 客户端 reducer 收到 → `turnStatus[sessionId] = 'idle'`

### 9.4 Client disconnect 中途 Tab 关闭
- `req.on('close')` 在 `/api/agent/prompt` 内触发 → abort + AskRegistry.abortAll
- **服务端继续运行 prompt**（不会因客户端关闭而停）
- Tab 重开 → 重新 EventSource 订阅 → 续上 live

### 9.5 EventBus subscriber 抛错
- eventBus 内 `try/catch` 兜住；不影响其他订阅者和后续 emit
- 前端 reducer 抛错 → console.error → SSE 仍继续

### 9.6 多 Tab 状态不同步
- 每 Tab 独立 EventSource、独立 `lastEventId`
- 两 Tab 同时订阅同 session：各自拿自己的事件副本
- Tab A 发 prompt → 两 Tab 都收到（合理：都能看到）
- MVP 不做跨 Tab activeSessionId 同步（如以后需要 → BroadcastChannel）

---

## 10. 测试

### 10.1 单元测试

**`eventBus.test.ts`**：
- emit 后 history 增长
- 超过 256 自动 shift
- subscribe 立即收到后续 emit
- `getHistoryAfter` 找到 → 切片；找不到 → 全部
- subscriber 抛错不影响其他
- unsubscribe 后不再收到

**`event.test.ts`（路由）**：
- GET /api/event 返回 `text/event-stream`
- 首次连接收到 server.connected 帧
- emit 后订阅者收到 `id` + `data`
- 带 `Last-Event-ID` 重连 → 补发历史
- req.close 触发后清除 subscriber + 停止心跳
- 15s 心跳帧（fake timer）

**`agent.test.ts`（改造）**：
- POST /agent/prompt 立即返回 `{ sessionId }`
- 不再返回 SSE 流；事件通过 eventBus.emit 投递
- HARD_TIMEOUT 触发 abort → emit `runtime.aborted`
- client disconnect → abort
- askRegistry.abortAll 在 disconnect 时触发

**`events.test.ts`**：
- ServerEvent.parse 接受所有合法 type
- 拒绝未知 type
- 缺 Base 字段 → parse 失败
- 端到端：emit → SSE 序列化 → JSON.parse → parse 合法

### 10.2 集成测试（手工）

- `pnpm dev` → 浏览器开两个 Tab A、B
- Tab A 发 prompt → Tab A 和 Tab B 都看到 runtime 流
- 杀掉 zai server → 浏览器 EventSource 自动重连 → 新进程补发
- 拔网线 5 秒后恢复 → 事件不丢

---

## 11. 验收标准

1. **全局可见**：四个面板类别（运行时流 / Session 列表 / 后台任务 / 权限错误）的事件都能从单一 `/api/event` 流拿到
2. **重连补发**：服务端重启后客户端能拿到 `Last-Event-ID` 之后的事件；找不到则从最早补全
3. **心跳存活**：超过 15s 无事件时客户端能收到注释帧；不会因代理超时被踢
4. **多 Tab 隔离**：每个 Tab 独立订阅；关闭一个不影响另一个
5. **可回滚**：旧的 `POST /agent/stream` 不保留（按用户决策完整替换）
6. **覆盖测试**：eventBus、SSE 路由、event schema 三个核心模块单测覆盖 ≥ 80%
7. **类型化**：前后端共享 `ServerEvent` 类型，新增事件类型须 Zod 编译通过
8. **本地运行**：zai server 启动后浏览器开任意 Tab 都自动连上 `/api/event`，无需手动重连

---

## 12. 风险与限制

| 风险 | 影响 | 缓解 |
|---|---|---|
| 进程重启丢历史 | UI 中间状态丢失 | MVP 接受；UI 通过 `GET /sessions/:id` 拉快照重建 |
| 客户端慢 → buffer 满 | 当前未实现 backpressure；可能 OOM | MVP 不做；本地工具事件量低 |
| 多 Tab activeSession 不同步 | 用户切 Tab 看不到另 Tab 的当前会话 | MVP 接受；以后 BroadcastChannel |
| 256 ring buffer 不够 | 长时间高密度 prompt 后旧事件被淘汰 | MVP 接受；如需持久化再扩展 disk ring buffer |
| AskRegistry 仍是 in-memory | server restart 后等待中的 prompt.ask 全失败 → runtime 抛错 | 与现状一致；MVP 不改 |