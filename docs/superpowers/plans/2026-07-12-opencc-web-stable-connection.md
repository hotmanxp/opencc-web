# opencc-web Stable Connection 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@zn-ai/zai` 的客户端-服务端通信从 per-request POST+SSE 改造为全局 `/api/event` SSE 长连接，让所有面板状态（运行时流、Session 列表、后台任务、权限/错误）走单一事件流。

**Architecture:** 服务端新增单进程 `ServerEventBus`（Node EventEmitter + Zod wrapper + 256 ring buffer）；新增 `GET /api/event` SSE 路由推全部事件（15s 心跳 + Last-Event-ID 补发）；`POST /agent/stream` 改名为 `POST /agent/prompt`，立即返回 `sessionId`，运行时事件通过 `eventBus.emit()` 投递；前端用浏览器原生 `EventSource` 订阅 + Zustand reducer 派发；AskRegistry 保留为 RPC 反向通道。

**Tech Stack:** Bun + pnpm + vitest, React 18, zustand, Express 5, zod, EventSource (浏览器原生 SSE)。

## Global Constraints

- Ring buffer 容量 **256**（`packages/zai/src/server/services/eventBus.ts`）
- 心跳间隔 **15 秒**，格式 `": heartbeat\n\n"`（注释帧）
- HARD_TIMEOUT **5 × 60 × 1000 ms**（保留现有 `HARD_TIMEOUT_MS`）
- SSE headers: `Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`
- 事件 ID 格式 `evt_{base36 时间戳}_{base36 计数器}`，服务端分配
- 客户端服务端共用 schema：`packages/zai/src/shared/events.ts`（前后端都 import 同一文件）
- 删除 `packages/zai/src/server/stream.ts`、`packages/zai/src/web/src/lib/sseAgent.ts`
- `POST /agent/stream` 完全替换为 `POST /agent/prompt`（无 fallback）
- 多 Tab 各自独立 EventSource；MVP 不做跨 Tab activeSessionId 同步
- 反压：ring buffer 满 → `shift()` 丢最老（不主动断开慢客户端）
- 提交规范: `feat(scope): xxx` / `fix(scope): xxx` / `chore / docs / refactor / test`，详见根 `AGENTS.md`
- 测试框架: vitest，全局命令 `pnpm -F zai test`
- 包管理: `packages/zai` 单 npm package
- 鉴权: 维持现有「仅 localhost 无鉴权」状态

---

## File Structure

### 新建

| 路径 | 职责 |
|------|------|
| `packages/zai/src/shared/events.ts` | Zod discriminatedUnion `ServerEvent` + 子 union；前后端共用 |
| `packages/zai/src/shared/events.test.ts` | schema 校验测试 |
| `packages/zai/src/server/services/eventBus.ts` | `ServerEventBus` 类（emit/subscribe/getHistoryAfter），单例 `eventBus` |
| `packages/zai/src/server/services/eventBus.test.ts` | emit/subscribe/补发/异常隔离 测试 |
| `packages/zai/src/server/routes/event.ts` | `GET /api/event` SSE 路由：server.connected 首发、Last-Event-ID 补发、subscribe、心跳、req.close 清理 |
| `packages/zai/src/server/routes/event.test.ts` | 用 supertest 拉 SSE 解析帧、断言心跳 |
| `packages/zai/src/web/src/lib/eventSource.ts` | `subscribeServerEvents(onEvent, onError?)` 封装 EventSource，`ServerEvent.parse` 校验 |
| `packages/zai/src/web/src/lib/eventSource.test.ts` | （mock EventSource）dispatch 校验 |
| `packages/zai/src/web/src/store/useEventStream.ts` | `useEventStream()` hook：App 顶层挂一次，按 type switch dispatch 到 useAgentStore/useAppStore |

### 修改

| 路径 | 改动摘要 |
|------|----------|
| `packages/zai/src/server/index.ts` | 在 `app.use('/api', ...)` 最前面加 `app.use('/api', eventRouter)` |
| `packages/zai/src/server/routes/agent.ts` | `POST /agent/stream` → `POST /agent/prompt`；立即 `res.json({ sessionId })`；fire-and-forget `eventBus.emit` 替代 `stream.send`；删除 `createSseStream` import |
| `packages/zai/src/server/services/agentRuntime.ts` | `runtime.run()` 内部不再写 SSE；改为调用方 `eventBus.emit({...event, sessionId})`（agent.ts 负责） |
| `packages/zai/src/server/types.ts` | 删除 `SseEvent` 类型 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | 加 `applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk` reducer（runtime.delta 累积消息、tool_call/result 入栈、done/idle 切换等） |
| `packages/zai/src/web/src/store/useAgentStore.test.ts` | 覆盖 reducer 各分支 |
| `packages/zai/src/web/src/store/useAppStore.ts` | 加 `setConnected` / `applyJobEvent` / `applySystemEvent` reducer |
| `packages/zai/src/web/src/store/useAppStore.test.ts` | 覆盖 reducer |
| `packages/zai/src/web/src/App.tsx` | 顶层调用 `useEventStream()` |
| `packages/zai/src/web/src/lib/api.ts` | 删除与 SSE 相关；保留普通 REST helper |

### 删除

| 路径 | 原因 |
|------|------|
| `packages/zai/src/server/stream.ts` | per-request SSE 帮手不再需要（被全局 /api/event 取代） |
| `packages/zai/src/web/src/lib/sseAgent.ts` | 客户端 per-request SSE parser 不再需要（被 EventSource 取代） |

---

## Task 1: 共享事件 Schema

**Files:**
- Create: `packages/zai/src/shared/events.ts`
- Create: `packages/zai/src/shared/events.test.ts`

**Interfaces:**
- Produces: `ServerEvent` (Zod schema + TS type)；后续所有任务 import 此类型

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/shared/events.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { ServerEvent } from './events.js'

describe('ServerEvent schema', () => {
  test('accepts runtime.delta', () => {
    const event = {
      type: 'runtime.delta',
      eventId: 'evt_1',
      ts: 1000,
      sessionId: 's_1',
      turnIndex: 0,
      delta: 'hello',
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts session.created', () => {
    const event = {
      type: 'session.created',
      eventId: 'evt_2',
      ts: 1000,
      sessionId: 's_2',
      title: 'New chat',
      cwd: '/tmp',
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts prompt.ask', () => {
    const event = {
      type: 'prompt.ask',
      eventId: 'evt_3',
      ts: 1000,
      sessionId: 's_3',
      toolUseId: 'tu_1',
      questions: [
        { question: 'Pick one', header: 'Choose', options: [{ label: 'A' }] },
      ],
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts server.connected', () => {
    const event = {
      type: 'server.connected',
      eventId: 'evt_4',
      ts: 1000,
      sessionId: null,
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('rejects unknown type', () => {
    const event = {
      type: 'made.up',
      eventId: 'evt_5',
      ts: 1000,
    }
    expect(() => ServerEvent.parse(event)).toThrow()
  })

  test('rejects missing eventId', () => {
    const event = {
      type: 'runtime.done',
      ts: 1000,
      sessionId: 's_1',
      turnIndex: 0,
    }
    expect(() => ServerEvent.parse(event)).toThrow()
  })

  test('round-trips through JSON', () => {
    const event = {
      type: 'runtime.done',
      eventId: 'evt_6',
      ts: 1000,
      sessionId: 's_1',
      turnIndex: 0,
      usage: { input: 10, output: 20 },
    }
    const json = JSON.stringify(event)
    const parsed = ServerEvent.parse(JSON.parse(json))
    expect(parsed.type).toBe('runtime.done')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm test src/shared/events.test.ts`
Expected: FAIL (file `./events.js` not found)

- [ ] **Step 3: 写实现**

`packages/zai/src/shared/events.ts`：

```ts
import { z } from 'zod'

const Base = z.object({
  eventId: z.string(),
  ts: z.number(),
})

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

const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('session.created'),
             sessionId: z.string(), title: z.string(), cwd: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.deleted'),
             sessionId: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.renamed'),
             sessionId: z.string(), title: z.string() }),
])

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

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm test src/shared/events.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/shared/events.ts packages/zai/src/shared/events.test.ts
git commit -m "feat(shared): add ServerEvent Zod schema"
```

---

## Task 2: 服务端 EventBus

**Files:**
- Create: `packages/zai/src/server/services/eventBus.ts`
- Create: `packages/zai/src/server/services/eventBus.test.ts`

**Interfaces:**
- Produces: `ServerEventBus` class + 单例 `eventBus`
- Consumes: `ServerEvent` from `packages/zai/src/shared/events.js`

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/server/services/eventBus.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { ServerEventBus } from './eventBus.js'

const baseEvent = { type: 'server.error' as const, message: 'x' }

describe('ServerEventBus', () => {
  test('emit stores event with assigned eventId and ts', () => {
    const bus = new ServerEventBus()
    bus.emit(baseEvent)
    const history = bus.getHistoryAfter()
    expect(history.length).toBe(0) // 未传 lastEventId 返回空
    const afterSomeId = bus.getHistoryAfter(undefined)
    expect(afterSomeId.length).toBe(0)
  })

  test('subscribe receives subsequent emits', () => {
    const bus = new ServerEventBus()
    const received: string[] = []
    bus.subscribe((e) => received.push(e.type))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    expect(received).toEqual(['server.error', 'server.error'])
  })

  test('history capped at 256; oldest dropped', () => {
    const bus = new ServerEventBus()
    for (let i = 0; i < 300; i++) {
      bus.emit(baseEvent)
    }
    // 用 subscribe 拿最新发出的 eventId，反查 history 长度
    let lastId = ''
    bus.subscribe((e) => { lastId = e.eventId })
    // 再 emit 一个
    bus.emit(baseEvent)
    const after = bus.getHistoryAfter('evt_DOES_NOT_EXIST') // 找不到 → 返回全部
    expect(after.length).toBeLessThanOrEqual(257) // 256 + 新 emit 的那条
  })

  test('getHistoryAfter with valid lastEventId returns tail', () => {
    const bus = new ServerEventBus()
    const received: string[] = []
    bus.subscribe((e) => received.push(e.eventId))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    const middleId = received[0]
    const tail = bus.getHistoryAfter(middleId)
    expect(tail.length).toBe(2)
    expect(tail[0].eventId).toBe(received[1])
    expect(tail[1].eventId).toBe(received[2])
  })

  test('getHistoryAfter with unknown id returns all history', () => {
    const bus = new ServerEventBus()
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    const all = bus.getHistoryAfter('evt_missing')
    expect(all.length).toBe(2)
  })

  test('subscriber throwing does not break other subscribers', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribe(() => { throw new Error('boom') })
    bus.subscribe((e) => got.push(e.type))
    expect(() => bus.emit(baseEvent)).not.toThrow()
    expect(got).toEqual(['server.error'])
  })

  test('unsubscribe stops delivery', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    const off = bus.subscribe((e) => got.push(e.type))
    bus.emit(baseEvent)
    off()
    bus.emit(baseEvent)
    expect(got.length).toBe(1)
  })

  test('eventId monotonic across emits', () => {
    const bus = new ServerEventBus()
    const ids: string[] = []
    bus.subscribe((e) => ids.push(e.eventId))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    expect(ids[1] > ids[0]).toBe(true)
    expect(ids[2] > ids[1]).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm test src/server/services/eventBus.test.ts`
Expected: FAIL (file `./eventBus.js` not found)

- [ ] **Step 3: 写实现**

`packages/zai/src/server/services/eventBus.ts`：

```ts
import { ServerEvent } from '../../shared/events.js'

type Subscriber = (event: ServerEvent) => void

const CAPACITY = 256
let counter = 0
const nextId = () => `evt_${Date.now().toString(36)}_${(++counter).toString(36)}`

export class ServerEventBus {
  private subs = new Set<Subscriber>()
  private history: ServerEvent[] = []

  emit(event: Omit<ServerEvent, 'eventId' | 'ts'> & { eventId?: string; ts?: number }) {
    const full = {
      ...event,
      eventId: event.eventId ?? nextId(),
      ts: event.ts ?? Date.now(),
    } as ServerEvent
    this.history.push(full)
    if (this.history.length > CAPACITY) this.history.shift()
    for (const sub of this.subs) {
      try {
        sub(full)
      } catch (err) {
        console.error('[eventBus] subscriber threw', err)
      }
    }
  }

  getHistoryAfter(lastEventId?: string): ServerEvent[] {
    if (lastEventId === undefined) return []
    const idx = this.history.findIndex((e) => e.eventId === lastEventId)
    if (idx < 0) return [...this.history]
    return this.history.slice(idx + 1)
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub)
    return () => {
      this.subs.delete(sub)
    }
  }
}

export const eventBus = new ServerEventBus()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm test src/server/services/eventBus.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/services/eventBus.ts packages/zai/src/server/services/eventBus.test.ts
git commit -m "feat(server): add ServerEventBus with 256 ring buffer"
```

---

## Task 3: SSE 路由 GET /api/event

**Files:**
- Create: `packages/zai/src/server/routes/event.ts`
- Create: `packages/zai/src/server/routes/event.test.ts`

**Interfaces:**
- Consumes: `eventBus` (subscribe + emit + getHistoryAfter), `ServerEvent`
- Produces: default export `eventRouter`（挂到 `/api`）

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/server/routes/event.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import eventRouter from './event.js'
import { eventBus } from '../services/eventBus.js'

function makeApp() {
  const app = express()
  app.use('/api', eventRouter)
  return app
}

describe('GET /api/event', () => {
  beforeEach(() => {
    // 每个测试独立 — 新建实例困难，直接覆盖全局 eventBus 不现实
    // 改用：每次测试都新建 eventBus 子实例
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('responds with text/event-stream and writes server.connected', async () => {
    vi.useFakeTimers()
    const app = makeApp()
    const res = await request(app).get('/api/event')
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    expect(res.text).toMatch(/event: server\.connected/)
    expect(res.text).toMatch(/data: /)
    expect(res.text).toMatch(/id: /)
  })

  test('delivers live emit to subscriber', async () => {
    vi.useFakeTimers()
    const app = makeApp()
    const res = await request(app).get('/api/event')
    // 触发 emit
    eventBus.emit({ type: 'server.error', message: 'late' })
    // 在同一个 res 里应该看到新帧
    expect(res.text).toMatch(/event: server\.error/)
    expect(res.text).toMatch(/data: .*"message":"late"/)
  })

  test('replay when Last-Event-ID is provided and found', async () => {
    vi.useFakeTimers()
    const app = makeApp()
    // 先 emit 一条已知事件
    eventBus.emit({ type: 'server.error', message: 'history1' })
    const events: ServerEvent[] = []
    eventBus.subscribe((e) => events.push(e))
    eventBus.emit({ type: 'server.error', message: 'live1' })
    const lastSeenId = events[0].eventId

    const res = await request(app)
      .get('/api/event')
      .set('Last-Event-ID', lastSeenId)
    // 应该补发 live1
    expect(res.text).toMatch(/"message":"live1"/)
    // 不应该重发 history1（早于 lastSeenId）
    expect(res.text).not.toMatch(/"message":"history1"/)
  })
})
```

注：`ServerEvent` import 需在文件顶部加：`import type { ServerEvent } from '../../shared/events.js'`

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm test src/server/routes/event.test.ts`
Expected: FAIL (file `./event.js` not found)

- [ ] **Step 3: 写实现**

`packages/zai/src/server/routes/event.ts`：

```ts
import { Router, type IRouter, type Request, type Response } from 'express'
import type { ServerEvent } from '../../shared/events.js'
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

  // 1. 立即发 server.connected
  eventBus.emit({ type: 'server.connected', sessionId: null })

  // 2. 重连补发
  for (const ev of eventBus.getHistoryAfter(lastEventId)) writeSse(res, ev)

  // 3. 注册为新 subscriber
  const unsubscribe = eventBus.subscribe((event) => writeSse(res, event))

  // 4. 心跳
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)

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

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm test src/server/routes/event.test.ts`
Expected: PASS (3 tests)。如果 supertest 在测试里把 SSE 一次性读完，需要在 res 监听 close 前 emit；上面测试已直接访问 `res.text`，supertest 默认会缓冲到 res.end() 触发。

如果 fake timer 干扰 res.end() 行为，可把 heartbeat 改为 setTimeout(0) 触发模式；或保留 real timer 测试。出现 flake 时去掉 `vi.useFakeTimers()`，保持 real timer。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/server/routes/event.ts packages/zai/src/server/routes/event.test.ts
git commit -m "feat(server): add GET /api/event SSE route with replay"
```

---

## Task 4: 在 server/index.ts 挂载 eventRouter

**Files:**
- Modify: `packages/zai/src/server/index.ts`（在所有 `app.use('/api', ...)` 之前插入）

- [ ] **Step 1: 修改 index.ts**

读取当前 `packages/zai/src/server/index.ts`，找到所有 `app.use('/api', ...Router)` 调用的位置，**在最前面**插入：

```ts
import eventRouter from './routes/event.js'
// ... 保留现有 imports

// 在 createApp 函数内，第一个 app.use('/api', ...) 之前：
app.use('/api', eventRouter)
```

完整变更示意（保持原顺序，新增放最前）：

```ts
import eventRouter from './routes/event.js'      // 新增

export function createApp(_opts: AppOptions): express.Express {
  initAgentRuntime()
  ensureManifestDir().catch(() => {})

  const app = express()
  app.use(express.json())

  app.use('/api', eventRouter)                  // 新增：最早挂载
  app.use('/api', healthRouter)
  app.use('/api', systemRouter)
  app.use('/api', cliRouter)
  app.use('/api', dirsRouter)
  app.use('/api', loginRouter)
  app.use('/api', configRouter)
  app.use('/api', resourcesRouter)
  app.use('/api', quickstartRouter)
  app.use('/api', execRouter)
  app.use('/api', agentRouter)
  app.use('/api', (req, _res, next) => {
    ;(req as any)._askRegistry = getAskRegistry()
    next()
  }, answerRouter)

  return app
}
```

- [ ] **Step 2: 跑现有测试确认不挂**

Run: `cd packages/zai && pnpm test`
Expected: 现有所有测试 PASS；新增 3 个 SSE 路由测试也 PASS

- [ ] **Step 3: 提交**

```bash
git add packages/zai/src/server/index.ts
git commit -m "feat(server): mount eventRouter before other api routes"
```

---

## Task 5: POST /agent/stream → POST /agent/prompt

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts`（替换 `/agent/stream` handler 为 `/agent/prompt`）

**Interfaces:**
- Consumes: `eventBus.emit` (Task 2), `getRuntime()` (existing), `getAskRegistry()` (existing), `getTranscriptStore()` (existing), `setCurrentSessionId()` (existing)
- Produces: `POST /api/agent/prompt` 立即返回 `{ sessionId }`

- [ ] **Step 1: 修改 agent.ts**

完整替换 `packages/zai/src/server/routes/agent.ts`：

```ts
import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { abortAgentSession, getCurrentSessionId, getAskRegistry, getRuntime, getTranscriptStore, setCurrentSessionId } from '../services/agentRuntime.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '@zn-ai/zai-agent-core'
import { eventBus } from '../services/eventBus.js'

const router: IRouter = Router()

const HARD_TIMEOUT_MS = 5 * 60 * 1000

const PromptRequest = z.object({
  prompt: z.string().min(1).max(32_000),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
})

function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

router.post('/agent/prompt', async (req: Request, res: Response) => {
  const parsed = PromptRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {prompt, cwd?}' })
  }

  const { prompt, cwd = process.cwd(), sessionId: existingSessionId } = parsed.data
  const sessionId = existingSessionId ?? newSessionId()
  const abortController = new AbortController()
  const timer = setTimeout(() => {
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.agent.prompt] HARD_TIMEOUT fired', { sessionId, ms: HARD_TIMEOUT_MS })
    }
    abortController.abort('timeout')
  }, HARD_TIMEOUT_MS)

  req.on('close', () => {
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.agent.prompt] req.close', {
        sessionId,
        alreadyAborted: abortController.signal.aborted,
      })
    }
    if (!abortController.signal.aborted) {
      abortController.abort('client_disconnect')
    }
    getAskRegistry().abortAll('client_disconnect')
  })

  // 立即响应，事件通过 eventBus → /api/event SSE
  res.json({ sessionId })

  // 异步 fire-and-forget 运行 runtime
  void (async () => {
    try {
      let systemPrompt: string | undefined
      try {
        const agentsMd = await loadAgentsMd(cwd)
        const built = buildAgentsMdSystemPrompt(agentsMd)
        systemPrompt = built ?? undefined
      } catch {
        // AGENTS.md 加载失败不阻断
      }

      const events = getRuntime().run({
        prompt,
        cwd,
        ...(existingSessionId ? { resumeFromTranscriptId: existingSessionId } : {}),
        systemPrompt,
        abortSignal: abortController.signal,
      })

      let titlePatched = Boolean(existingSessionId)
      for await (const event of events) {
        // 首次出现 sessionId → 写入 session.created 事件
        if (typeof event.sessionId === 'string' && event.sessionId !== sessionId) {
          setCurrentSessionId(event.sessionId)
          if (!titlePatched) {
            titlePatched = true
            try {
              const title = deriveTitleFromPrompt(prompt)
              await getTranscriptStore().patch(event.sessionId, { title })
            } catch {
              /* title 失败不阻断 */
            }
          }
        }
        // ★ 替代原 stream.send：通过总线推送
        eventBus.emit(event as any)
        if (event.type === 'runtime.done' || event.type === 'runtime.aborted') break
      }
    } catch (err) {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.agent.prompt] for-await threw', {
          sessionId,
          message: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        })
      }
      eventBus.emit({
        type: 'runtime.error',
        eventId: 'err',
        sessionId,
        ts: Date.now(),
        turnIndex: 0,
        error: {
          category: 'internal',
          message: (err as Error).message,
          recoverable: false,
        },
      } as any)
    } finally {
      clearTimeout(timer)
    }
  })()
})

// GET /api/agent/sessions — 列出所有 session，最新的在前
router.get('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    const sessions = await store.list()
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/agent/sessions/:id — 读取指定 session 的消息
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id)
    res.json({ transcript })
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

// DELETE /api/agent/sessions/:id — 删除指定 session
router.delete('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    await store.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/agent/abort', async (_req: Request, res: Response) => {
  const sessionId = getCurrentSessionId()
  await abortAgentSession('user_abort')
  res.json({ ok: true, sessionId })
})

const TITLE_MAX_LEN = 50

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim()
  if (!firstLine) return '新会话'
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + '…'
}

export default router
```

注：删除原 `import { createSseStream } from './stream.js'`。

- [ ] **Step 2: 删除 stream.ts**

Run: `git rm packages/zai/src/server/stream.ts`
Expected: file removed

如果 `agent.ts` 内还引用任何来自 stream.ts 的类型/函数（除了 createSseStream），相应调整；上一步已删除该 import。

- [ ] **Step 3: 跑测试确认不挂**

Run: `cd packages/zai && pnpm test`
Expected: 现有所有测试 PASS；eventBus + event 路由 + events schema 测试都 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/zai/src/server/routes/agent.ts
git commit -m "feat(server): POST /agent/stream → /agent/prompt, route events via eventBus"
```

---

## Task 6: 扩展 useAgentStore reducer

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`
- Create: `packages/zai/src/web/src/store/useAgentStore.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` (Task 1)
- Produces: `applyRuntimeEvent`, `applySessionEvent`, `applyPromptAsk` 方法（被 Task 8 useEventStream 调用）

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/web/src/store/useAgentStore.test.ts`：

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { useAgentStore } from './useAgentStore.js'

beforeEach(() => {
  useAgentStore.setState({
    activeSessionId: null,
    sessions: {},
    turnStatus: {},
    messages: {},
    pendingAsk: null,
  })
})

describe('useAgentStore.applyRuntimeEvent', () => {
  test('runtime.started sets turnStatus to running', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.started',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('running')
  })

  test('runtime.delta appends delta to messages', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.delta',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, delta: 'hello',
    })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.delta',
      eventId: 'e2', ts: 2, sessionId: 's1', turnIndex: 0, delta: ' world',
    })
    const msgs = useAgentStore.getState().messages.s1
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toBe('hello world')
  })

  test('runtime.tool_call stores call by toolUseId', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      toolName: 'bash', input: { cmd: 'ls' },
    })
    expect(useAgentStore.getState().toolCalls.s1).toBeDefined()
  })

  test('runtime.done sets turnStatus to idle', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.done',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('idle')
  })

  test('runtime.aborted sets turnStatus to aborted', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.aborted',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, reason: 'timeout',
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('aborted')
  })

  test('runtime.error sets turnStatus to error', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.error',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      error: { category: 'internal', message: 'boom', recoverable: false },
    })
    expect(useAgentStore.getState().turnStatus.s1).toBe('error')
  })
})

describe('useAgentStore.applySessionEvent', () => {
  test('session.created registers session metadata', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
    expect(useAgentStore.getState().sessions.s1).toEqual({
      sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
  })

  test('session.deleted removes session', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'X', cwd: '/tmp',
    })
    useAgentStore.getState().applySessionEvent({
      type: 'session.deleted',
      eventId: 'e2', ts: 2, sessionId: 's1',
    })
    expect(useAgentStore.getState().sessions.s1).toBeUndefined()
  })
})

describe('useAgentStore.applyPromptAsk', () => {
  test('stores pendingAsk', () => {
    useAgentStore.getState().applyPromptAsk({
      type: 'prompt.ask',
      eventId: 'e1', ts: 1, sessionId: 's1', toolUseId: 'tu1',
      questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }] }],
    })
    expect(useAgentStore.getState().pendingAsk?.toolUseId).toBe('tu1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm test src/web/src/store/useAgentStore.test.ts`
Expected: FAIL（reducer 方法不存在）

- [ ] **Step 3: 修改 useAgentStore.ts**

读取 `packages/zai/src/web/src/store/useAgentStore.ts`（现有实现保留），在 store 内追加：

```ts
// 在 store 定义顶部，加 type：
type RuntimeDeltaMessage = { role: 'assistant'; content: string; ts: number }
type ToolCall = { toolName: string; input: unknown; output?: unknown }

interface State {
  activeSessionId: string | null
  sessions: Record<string, { sessionId: string; title: string; cwd: string }>
  turnStatus: Record<string, 'idle' | 'running' | 'aborted' | 'error'>
  messages: Record<string, RuntimeDeltaMessage[]>
  toolCalls: Record<string, Record<string, ToolCall>>
  pendingAsk: {
    sessionId: string
    toolUseId: string
    questions: { question: string; header: string; options: { label: string; description?: string }[] }[]
  } | null
  // ... 其它现有字段保留

  // 新增 reducer
  applyRuntimeEvent: (event: ServerEvent) => void
  applySessionEvent: (event: ServerEvent) => void
  applyPromptAsk: (event: ServerEvent) => void
}

// 在 create 函数实现内：
applyRuntimeEvent: (event) => set((state) => {
  if (!('sessionId' in event) || typeof event.sessionId !== 'string') return state
  const sid = event.sessionId
  switch (event.type) {
    case 'runtime.started':
      return { ...state, turnStatus: { ...state.turnStatus, [sid]: 'running' } }
    case 'runtime.delta': {
      const existing = state.messages[sid] ?? []
      const last = existing[existing.length - 1]
      if (last && last.role === 'assistant') {
        const merged = [...existing.slice(0, -1), { ...last, content: last.content + event.delta }]
        return { ...state, messages: { ...state.messages, [sid]: merged } }
      }
      return {
        ...state,
        messages: { ...state.messages, [sid]: [...existing, { role: 'assistant', content: event.delta, ts: event.ts }] },
      }
    }
    case 'runtime.tool_call': {
      const calls = state.toolCalls[sid] ?? {}
      // runtime.tool_call 不带 toolUseId；按 toolName 顺序入栈
      const toolUseId = `tu_${Object.keys(calls).length}_${event.ts}`
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [sid]: { ...calls, [toolUseId]: { toolName: event.toolName, input: event.input } },
        },
      }
    }
    case 'runtime.tool_result': {
      const calls = state.toolCalls[sid] ?? {}
      const call = calls[event.toolUseId]
      if (!call) return state
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [sid]: { ...calls, [event.toolUseId]: { ...call, output: event.output } },
        },
      }
    }
    case 'runtime.done':
      return { ...state, turnStatus: { ...state.turnStatus, [sid]: 'idle' } }
    case 'runtime.aborted':
      return { ...state, turnStatus: { ...state.turnStatus, [sid]: 'aborted' } }
    case 'runtime.error':
      return { ...state, turnStatus: { ...state.turnStatus, [sid]: 'error' } }
    default:
      return state
  }
}),
applySessionEvent: (event) => set((state) => {
  if (!('sessionId' in event) || typeof event.sessionId !== 'string') return state
  const sid = event.sessionId
  switch (event.type) {
    case 'session.created': {
      const sessions = { ...state.sessions }
      sessions[sid] = { sessionId: sid, title: event.title, cwd: event.cwd }
      return { ...state, sessions }
    }
    case 'session.deleted': {
      const sessions = { ...state.sessions }
      delete sessions[sid]
      return { ...state, sessions }
    }
    case 'session.renamed': {
      const existing = state.sessions[sid]
      if (!existing) return state
      return { ...state, sessions: { ...state.sessions, [sid]: { ...existing, title: event.title } } }
    }
    default:
      return state
  }
}),
applyPromptAsk: (event) => set((state) => {
  if (event.type !== 'prompt.ask') return state
  return {
    ...state,
    pendingAsk: {
      sessionId: event.sessionId,
      toolUseId: event.toolUseId,
      questions: event.questions,
    },
  }
}),
```

顶部 import 加：`import type { ServerEvent } from '../../../shared/events.js'`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm test src/web/src/store/useAgentStore.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/src/web/src/store/useAgentStore.test.ts
git commit -m "feat(web): add runtime/session/prompt reducers to useAgentStore"
```

---

## Task 7: 扩展 useAppStore reducer

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`
- Create: `packages/zai/src/web/src/store/useAppStore.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` (Task 1)
- Produces: `setConnected`, `applyJobEvent`, `applySystemEvent` 方法

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/web/src/store/useAppStore.test.ts`：

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { useAppStore } from './useAppStore.js'

beforeEach(() => {
  useAppStore.setState({
    connected: false,
    jobs: {},
    toasts: [],
  })
})

describe('useAppStore', () => {
  test('setConnected(true) sets connected', () => {
    useAppStore.getState().setConnected(true)
    expect(useAppStore.getState().connected).toBe(true)
  })

  test('applyJobEvent for job.started registers job', () => {
    useAppStore.getState().applyJobEvent({
      type: 'job.started',
      eventId: 'e1', ts: 1,
      jobId: 'j1', kind: 'resource_refresh',
    })
    expect(useAppStore.getState().jobs.j1.kind).toBe('resource_refresh')
  })

  test('applyJobEvent for job.progress updates progress', () => {
    useAppStore.getState().applyJobEvent({
      type: 'job.started',
      eventId: 'e1', ts: 1,
      jobId: 'j1', kind: 'install',
    })
    useAppStore.getState().applyJobEvent({
      type: 'job.progress',
      eventId: 'e2', ts: 2,
      jobId: 'j1', message: 'half', percent: 50,
    })
    expect(useAppStore.getState().jobs.j1.progress).toBe(50)
    expect(useAppStore.getState().jobs.j1.message).toBe('half')
  })

  test('applyJobEvent for job.done removes job after delay', () => {
    vi.useFakeTimers()
    useAppStore.getState().applyJobEvent({
      type: 'job.started',
      eventId: 'e1', ts: 1,
      jobId: 'j1', kind: 'install',
    })
    useAppStore.getState().applyJobEvent({
      type: 'job.done',
      eventId: 'e2', ts: 2, jobId: 'j1',
    })
    // 立即还在；3s 后清
    expect(useAppStore.getState().jobs.j1).toBeDefined()
    vi.advanceTimersByTime(3000)
    expect(useAppStore.getState().jobs.j1).toBeUndefined()
  })

  test('applySystemEvent toast pushes toast', () => {
    useAppStore.getState().applySystemEvent({
      type: 'toast', eventId: 'e1', ts: 1, level: 'info', message: 'hi',
    })
    expect(useAppStore.getState().toasts.length).toBe(1)
    expect(useAppStore.getState().toasts[0].message).toBe('hi')
  })

  test('applySystemEvent server.error pushes error toast', () => {
    useAppStore.getState().applySystemEvent({
      type: 'server.error', eventId: 'e1', ts: 1, message: 'oops',
    })
    expect(useAppStore.getState().toasts[0].level).toBe('error')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm test src/web/src/store/useAppStore.test.ts`
Expected: FAIL（reducer 方法不存在）

- [ ] **Step 3: 修改 useAppStore.ts**

读取 `packages/zai/src/web/src/store/useAppStore.ts`，追加：

```ts
import type { ServerEvent } from '../../../shared/events.js'

interface JobInfo {
  jobId: string
  kind: 'resource_refresh' | 'login' | 'install'
  progress?: number
  message?: string
  done?: boolean
  error?: string
}

interface ToastInfo {
  id: string
  level: 'info' | 'warn' | 'error'
  message: string
  ts: number
}

interface State {
  connected: boolean
  jobs: Record<string, JobInfo>
  toasts: ToastInfo[]

  setConnected: (v: boolean) => void
  applyJobEvent: (event: ServerEvent) => void
  applySystemEvent: (event: ServerEvent) => void
  dismissToast: (id: string) => void
}

// 实现：
setConnected: (v) => set({ connected: v }),
applyJobEvent: (event) => set((state) => {
  if (!('jobId' in event) || typeof event.jobId !== 'string') return state
  const jid = event.jobId
  switch (event.type) {
    case 'job.started': {
      const jobs = { ...state.jobs }
      jobs[jid] = { jobId: jid, kind: event.kind }
      return { ...state, jobs }
    }
    case 'job.progress': {
      const existing = state.jobs[jid]
      if (!existing) return state
      return {
        ...state,
        jobs: { ...state.jobs, [jid]: { ...existing, message: event.message, progress: event.percent } },
      }
    }
    case 'job.done': {
      const existing = state.jobs[jid]
      if (!existing) return state
      // 3s 后自动清理
      setTimeout(() => {
        set((s) => {
          const jobs = { ...s.jobs }
          delete jobs[jid]
          return { jobs }
        })
      }, 3000)
      return {
        ...state,
        jobs: { ...state.jobs, [jid]: { ...existing, done: true, progress: 100 } },
      }
    }
    case 'job.failed': {
      const existing = state.jobs[jid]
      if (!existing) return state
      return {
        ...state,
        jobs: { ...state.jobs, [jid]: { ...existing, error: event.error } },
      }
    }
    default:
      return state
  }
}),
applySystemEvent: (event) => set((state) => {
  if (event.type === 'toast') {
    return {
      ...state,
      toasts: [...state.toasts, {
        id: event.eventId, level: event.level, message: event.message, ts: event.ts,
      }],
    }
  }
  if (event.type === 'server.error') {
    return {
      ...state,
      toasts: [...state.toasts, {
        id: event.eventId, level: 'error', message: event.message, ts: event.ts,
      }],
    }
  }
  return state
}),
dismissToast: (id) => set((state) => ({
  ...state,
  toasts: state.toasts.filter((t) => t.id !== id),
})),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm test src/web/src/store/useAppStore.test.ts`
Expected: PASS (6 tests)。`setTimeout` 用 fake timer 时需要在测试文件 import `vi` from vitest 并 `vi.useFakeTimers()`。

- [ ] **Step 5: 提交**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts packages/zai/src/web/src/store/useAppStore.test.ts
git commit -m "feat(web): add job/system reducers to useAppStore"
```

---

## Task 8: 前端 EventSource 封装 + useEventStream hook

**Files:**
- Create: `packages/zai/src/web/src/lib/eventSource.ts`
- Create: `packages/zai/src/web/src/store/useEventStream.ts`
- Create: `packages/zai/src/web/src/lib/eventSource.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` (Task 1), `useAgentStore.apply*` (Task 6), `useAppStore.apply*` (Task 7)
- Produces: `subscribeServerEvents(onEvent, onError?)` 函数；`useEventStream()` hook

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/web/src/lib/eventSource.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { ServerEvent } from '../../../shared/events.js'

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  emit(data: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

vi.stubGlobal('EventSource', MockEventSource)

// 动态 import 确保 mock 生效
const { subscribeServerEvents } = await import('./eventSource.js')

describe('subscribeServerEvents', () => {
  test('connects to /api/event', () => {
    MockEventSource.instances = []
    subscribeServerEvents(() => {})
    expect(MockEventSource.instances[0].url).toBe('/api/event')
  })

  test('parses incoming message and dispatches', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.emit({
      type: 'server.connected',
      eventId: 'e1', ts: 1, sessionId: null,
    })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'server.connected' }))
  })

  test('parses failure logs but does not throw', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.onmessage?.({ data: 'not json' })
    expect(onEvent).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('handle.close calls es.close', () => {
    MockEventSource.instances = []
    const handle = subscribeServerEvents(() => {})
    const es = MockEventSource.instances[0]
    handle.close()
    expect(es.close).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm test src/web/src/lib/eventSource.test.ts`
Expected: FAIL (file `./eventSource.js` not found)

- [ ] **Step 3: 写 eventSource.ts 实现**

`packages/zai/src/web/src/lib/eventSource.ts`：

```ts
import { ServerEvent } from '../../../shared/events.js'

const API_BASE = '/api'

export interface StreamHandle {
  close: () => void
}

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

  es.onerror = (e) => {
    onError?.(e)
  }

  return {
    close: () => es.close(),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm test src/web/src/lib/eventSource.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 写 useEventStream hook**

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
    return () => {
      handle.close()
    }
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
      useAgentStore.getState().applyRuntimeEvent(event)
      break
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
      useAgentStore.getState().applySessionEvent(event)
      break
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
      useAppStore.getState().applyJobEvent(event)
      break
    case 'prompt.ask':
      useAgentStore.getState().applyPromptAsk(event)
      break
    case 'server.connected':
      useAppStore.getState().setConnected(true)
      break
    case 'server.error':
    case 'toast':
      useAppStore.getState().applySystemEvent(event)
      break
  }
}
```

- [ ] **Step 6: 提交**

```bash
git add packages/zai/src/web/src/lib/eventSource.ts packages/zai/src/web/src/lib/eventSource.test.ts packages/zai/src/web/src/store/useEventStream.ts
git commit -m "feat(web): EventSource subscription + useEventStream hook"
```

---

## Task 9: App.tsx 顶层挂载 + 删除旧 SSE

**Files:**
- Modify: `packages/zai/src/web/src/App.tsx`
- Modify: `packages/zai/src/web/src/lib/api.ts`
- Delete: `packages/zai/src/web/src/lib/sseAgent.ts`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`（删除 runAgentStream 调用，改为 api.post）

- [ ] **Step 1: 修改 App.tsx**

读取 `packages/zai/src/web/src/App.tsx`，在组件顶层（`return` 之前）插入：

```ts
import { useEventStream } from './store/useEventStream'

export default function App() {
  useEventStream()
  return <Routes>...</Routes>
}
```

- [ ] **Step 2: 修改 api.ts**

读取 `packages/zai/src/web/src/lib/api.ts`，删除任何与 SSE / EventSource 相关 helper（保留普通 REST helper `get/post/put`）。如果还有遗留 `runAgentStream` import，在 import 区也清理。

- [ ] **Step 3: 删除 sseAgent.ts**

```bash
git rm packages/zai/src/web/src/lib/sseAgent.ts
```

- [ ] **Step 4: 修改 Agent.tsx 调用点**

读取 `packages/zai/src/web/src/pages/Agent.tsx`，找到 `runAgentStream` 调用点（典型位置：用户点发送按钮），替换为：

```ts
import { api } from '../lib/api'
import { useAgentStore } from '../store/useAgentStore'

async function handleSend() {
  const text = inputValue.trim()
  if (!text) return
  setInputValue('')
  const { sessionId } = await api.post<{ sessionId: string }>('/agent/prompt', {
    prompt: text,
    cwd: process.cwd(),
  })
  useAgentStore.getState().setActiveSession(sessionId)
}
```

- [ ] **Step 5: 跑测试确认不挂**

Run: `cd packages/zai && pnpm test`
Expected: 所有测试 PASS；旧的 `runAgentStream` 相关测试如果存在已被删除或自然 fail（删除相关 test 文件）

- [ ] **Step 6: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 0 errors

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/web/src/App.tsx packages/zai/src/web/src/lib/api.ts packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(web): mount useEventStream, switch prompt to /agent/prompt"
```

---

## Task 10: 集成验证（手工 e2e）

**Files:** 无代码改动；只跑 dev server + 浏览器手工验证。

- [ ] **Step 1: 启动 zai dev**

Run: `cd packages/zai && pnpm dev`
Expected: Vite 启动 + Express 启动；监听端口（如 7715）

- [ ] **Step 2: 浏览器访问**

打开 `http://localhost:7715`，DevTools Network 面板：

- 应看到 `GET /api/event` 持久连接（Status: 200, Type: eventsource, 持续 Pending）
- 应收到首条 `event: server.connected`

- [ ] **Step 3: 多 Tab 验证**

新开 Tab B → `GET /api/event` 也独立建立。Tab A 发 prompt → Tab A 与 Tab B **都收到** `event: runtime.delta` 等事件流。

- [ ] **Step 4: 断线重连验证**

DevTools Network → 右键 `/api/event` → Block request URL。然后取消 block → EventSource 自动重连，header 带 `Last-Event-ID`。

如果被 block 时长超过 256 条 emit 容量，服务端 ring buffer 不含 lastEventId → 服务端从最早补全。

- [ ] **Step 5: HARD_TIMEOUT 验证**

发个会被 runtime 长时间运行的 prompt（实际由 5 分钟触发，调试可临时把 `HARD_TIMEOUT_MS` 改成 5000）。约 5s 后，DevTools EventSource 流里应收到 `event: runtime.aborted`，且 UI 显示中止状态。

- [ ] **Step 6: 关闭旧 SSE 文件确认**

```bash
! test -f packages/zai/src/web/src/lib/sseAgent.ts && echo "sseAgent.ts deleted ✓"
! test -f packages/zai/src/server/stream.ts && echo "stream.ts deleted ✓"
```

- [ ] **Step 7: 提交验证记录**

无需新提交（手工验证无代码改动）。如发现 bug，单独开 fix commit。

---

## Self-Review Checklist

- [x] **Spec coverage**:
  - §3 共享 schema → Task 1
  - §4 EventBus → Task 2
  - §5 SSE 路由 → Task 3
  - §1.4 挂载顺序 → Task 4
  - §6 POST /agent/prompt → Task 5
  - §7 useEventStream + reducers → Task 6, 7, 8
  - §9 错误处理集成 → Task 10 手工验证
  - §10 测试 → Task 1-8 各自带 .test.ts
- [x] **Placeholder scan**: 无 TBD；代码块完整；无 "Similar to Task N"
- [x] **Type consistency**:
  - `ServerEvent` 在 Task 1 定义，Task 2-8 引用，类型签名一致
  - `eventBus.emit/getHistoryAfter/subscribe` 在 Task 2 定义，Task 3、5 调用
  - reducer 方法名（`applyRuntimeEvent`/`applySessionEvent`/`applyPromptAsk`/`applyJobEvent`/`applySystemEvent`/`setConnected`）在 Task 6/7 定义、Task 8 dispatch 调用，全文一致
  - `subscribeServerEvents`/`useEventStream`/`StreamHandle` 在 Task 8 定义，Task 9 调用