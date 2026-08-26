# 借鉴 dsh 的 SSE 事件序列化与投影状态推送 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 opencc-web 的 SSE 通道引入 dsh 架构的三个核心机制：**单调递增 `seq`**（消息合并/重连补发的顺序基准）、**连接状态机**（`connecting/connected/reconnecting/error` + UI 指示）、**`session/projection` 投影帧**（host 算完的派生值按 key 整体推送，`higher-seq-wins` 合并）；配套 microtask 批量 dispatch 与结构化 `stream/error` 帧。

**Architecture:** server 侧 `ServerEventBus.emit` 分配全局单调 `seq`（`shared/events.ts` Base 加字段）；`eventBus` 新增 `session/projection` / `stream/error` 两种帧；client 侧 `useEventStream` 暴露连接状态机 + microtask 批量 dispatch，`useAgentStore` 加 `lastSeqBySession` seq 守卫与 `projectionsBySession` 投影存储，新增 `useProjection` hook；试点迁移 title / context.tokens 两个投影 key。

**Tech Stack:** TypeScript (strict)、vitest、pnpm workspace（包 `@zn-ai/zai`）。

**Spec 参考:** `docs/superpowers/specs/2026-08-15-dsh-event-seq-projection-design.md`

## Global Constraints

- 遵循 AGENTS.md：import 路径带 `.js` 后缀；tsconfig strict；测试 `*.test.ts(x)`。
- **真实浏览器验收是强制项**：完成各 Task 后必须用 `/ego-browser` 启动真实 zai 实例走用户路径；禁止用 Playwright/curl 替代。
- **纯前端/纯 server 改动不需要 build:core**；若动到 `packages/zn-agent-core/` 必须先 `pnpm run build:core`（本计划不涉及 core，除非投影引擎下沉到 core——第一版在 zai server 内实现，不碰 core）。
- **端口规则**：启动 zai 前先 `lsof -i :<port>` 确认空闲；显式 `--port` 被占用必须报错退出，禁止静默换端口。ego-browser 验证时不要 kill 920x 端口服务，用独立端口（如 8101）访问。
- **测试粒度**：只跑受影响测试文件，不跑 `pnpm -r test` 全量。
- **seq 语义边界**：seq 只保证**单进程内**单调；跨重启由 `eventId` + history replay 兜底。不得把 seq 当持久化 ID 用。
- **渐进式**：第一版 seq 守卫只加不删——手工 key 拼接（`sendSeq/textSegmentRev`）继续负责 React 渲染分组，防御代码后续清理。
- 非目标守住：不引入 WebSocket / RpcId / cordis / ConversationNodeAssembler。

---

### Task 1: `shared/events.ts` — Base 加 `seq` + 新增两种帧

**Files:**
- Modify: `packages/zai/src/shared/events.ts:3-6`（Base）、`:255-264`（ServerEvent union）

**Interfaces:**
- Consumes: 无
- Produces: `Base` 增加 `seq: z.number()`；`StreamErrorEvent` / `ProjectionEvent` 类型；`ServerEvent` union 追加两种帧。Task 2-6 依赖 `seq` 字段存在。

- [ ] **Step 1: 写失败测试** — 新建 `packages/zai/test/shared/events.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { ServerEvent } from '../../shared/events.js'

describe('ServerEvent schema', () => {
  it('accepts Base fields incl. seq', () => {
    const ok = ServerEvent.safeParse({
      type: 'runtime.delta', sessionId: 's1', turnIndex: 0,
      delta: 'hi', eventId: 'e1', ts: 1, seq: 42,
    })
    expect(ok.success).toBe(true)
  })

  it('rejects missing seq', () => {
    const bad = ServerEvent.safeParse({
      type: 'runtime.delta', sessionId: 's1', turnIndex: 0,
      delta: 'hi', eventId: 'e1', ts: 1,
    })
    expect(bad.success).toBe(false)
  })

  it('accepts stream/error frame', () => {
    const ok = ServerEvent.safeParse({
      type: 'stream/error', eventId: 'e2', ts: 2, seq: 43,
      error: { code: 'internal', message: 'boom', details: {} },
    })
    expect(ok.success).toBe(true)
  })

  it('rejects unknown error code', () => {
    const bad = ServerEvent.safeParse({
      type: 'stream/error', eventId: 'e3', ts: 3, seq: 44,
      error: { code: 'nope', message: 'x' },
    })
    expect(bad.success).toBe(false)
  })

  it('accepts session/projection frame', () => {
    const ok = ServerEvent.safeParse({
      type: 'session/projection', sessionId: 's1', key: 'title',
      value: 'My Session', seq: 45, eventId: 'e4', ts: 4,
    })
    expect(ok.success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/shared/events.test.ts`
Expected: FAIL — `seq` 不存在 / 两种帧不在 union 内。

- [ ] **Step 3: 实现 schema**

在 `shared/events.ts:3-6` 的 Base 加 `seq: z.number()`（带注释：服务端全局单调、emit 时分配、跨重启不保证单调）。

在文件末尾 ServerEvent union 前新增：

```ts
const RpcErrorCode = z.enum([
  'internal', 'bad-request', 'session-not-found', 'session-conflict',
  'model-unavailable', 'timeout', 'cancelled', 'agent-busy',
  'stream-write-failed', 'invalid-response',
])

const StreamErrorEvent = z.object({
  ...Base.shape,
  type: z.literal('stream/error'),
  error: z.object({
    code: RpcErrorCode,
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
})

const ProjectionEvent = z.object({
  ...Base.shape,
  type: z.literal('session/projection'),
  sessionId: z.string(),
  key: z.string().min(1),
  value: z.unknown(),
  seq: z.number().int().nonnegative(),
})
```

把两者加入 `ServerEvent` discriminatedUnion。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/shared/events.test.ts`
Expected: 5 个用例全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/shared/events.ts packages/zai/test/shared/events.test.ts
git commit -m "feat(zai): add monotonic seq and stream/error + session/projection frames to ServerEvent"
```

---

### Task 2: `eventBus.ts` — emit 分配 seq + 溢出告警

**Files:**
- Modify: `packages/zai/src/server/services/eventBus.ts:82-113`（emit）、`:5`（CAPACITY 注释）

**Interfaces:**
- Consumes: `ServerEvent`（含 `seq`）
- Produces: `emit()` 自动分配 seq；history 溢出 console.warn。

- [ ] **Step 1: 写失败测试** — 新建 `packages/zai/test/server/services/eventBus.test.ts`

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ServerEventBus } from '../../../../src/server/services/eventBus.js'

describe('ServerEventBus seq assignment', () => {
  let bus: ServerEventBus
  beforeEach(() => { bus = new ServerEventBus() })

  it('assigns monotonically increasing seq', () => {
    const seqs: number[] = []
    bus.subscribe((e) => seqs.push(e.seq))
    bus.emit({ type: 'toast', message: 'a' } as any)
    bus.emit({ type: 'toast', message: 'b' } as any)
    bus.emit({ type: 'toast', message: 'c' } as any)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('preserves caller-provided seq', () => {
    let got: number | undefined
    bus.subscribe((e) => { got = e.seq })
    bus.emit({ type: 'toast', message: 'x', seq: 99 } as any)
    expect(got).toBe(99)
  })
})
```

（溢出告警：把 CAPACITY 临时调到 2 或用 spy 检查 console.warn——在 Step 3 里实现后再补一个断言。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test test/server/services/eventBus.test.ts`
Expected: FAIL — 无 seq 或 seq 恒为 undefined。

- [ ] **Step 3: 实现**

在 `ServerEventBus` 类内加 `private seqCounter = 0`；`emit` 内：

```ts
const full: ServerEvent = {
  ...event,
  eventId: event.eventId ?? nextId(),
  ts: event.ts ?? Date.now(),
  seq: event.seq ?? ++this.seqCounter,
} as ServerEvent
```

`history.length > CAPACITY` 与 `arr.length > CAPACITY` 两个 `shift()` 前加：

```ts
console.warn(`[eventBus] history overflow: 缓冲已达 ${CAPACITY} 条, 最旧事件将被丢弃`)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test test/server/services/eventBus.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/eventBus.ts packages/zai/test/server/services/eventBus.test.ts
git commit -m "feat(zai): assign monotonic seq in eventBus.emit and warn on history overflow"
```

---

### Task 3: `eventSource.ts` — onState 回调 + 连接状态机

**Files:**
- Modify: `packages/zai/src/web/src/lib/eventSource.ts:68-100`（subscribeServerEvents）

**Interfaces:**
- Consumes: 无
- Produces: `StreamState` 类型 + `subscribeServerEvents` 第三参数 `onState?`。Task 4 依赖。

- [ ] **Step 1: 写失败测试** — 新建 `packages/zai/src/web/src/lib/eventSource.test.ts`

用 mock EventSource（`globalThis.EventSource = class { onopen/onerror/onmessage/close }`）驱动：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { subscribeServerEvents, type StreamState } from './eventSource.js'

class FakeES {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: any) => void) | null = null
  close = vi.fn()
  emitOpen() { this.onopen?.() }
  emitError() { this.onerror?.() }
  emitMessage(type: string, data: unknown) {
    this.onmessage?.({ type, data: JSON.stringify(data) })
  }
}
let fake: FakeES

beforeEach(() => {
  fake = new FakeES()
  globalThis.EventSource = vi.fn(() => fake) as any
})

describe('subscribeServerEvents state machine', () => {
  it('emits connecting then connected on open', () => {
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    expect(states).toContain('connecting')
    fake.emitOpen()
    expect(states.at(-1)).toBe('connected')
  })

  it('emits reconnecting on first error then connected on reopen', () => {
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    fake.emitOpen()
    fake.emitError()
    expect(states.at(-1)).toBe('reconnecting')
    fake.emitOpen()
    expect(states.at(-1)).toBe('connected')
  })

  it('emits error after 3 consecutive failures', () => {
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    fake.emitOpen()
    fake.emitError(); fake.emitError(); fake.emitError()
    expect(states.at(-1)).toBe('error')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/lib/eventSource.test.ts`
Expected: FAIL — `StreamState` 未导出 / 无 onState 行为。

- [ ] **Step 3: 实现**

`eventSource.ts` 顶部加：

```ts
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'error'
```

`subscribeServerEvents` 签名加 `onState?: (state: StreamState, attempt: number) => void`，内部：

```ts
let attempt = 0
onState?.('connecting', attempt)
es.onopen = () => { attempt = 0; onState?.('connected', attempt) }
es.onerror = () => {
  attempt += 1
  onState?.(attempt <= 3 ? 'reconnecting' : 'error', attempt)
}
```

保留现有 `onmessage` 逻辑与 `StreamHandle` 返回。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/lib/eventSource.test.ts`
Expected: 3 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/lib/eventSource.ts packages/zai/src/web/src/lib/eventSource.test.ts
git commit -m "feat(zai): expose connection state machine via subscribeServerEvents onState callback"
```

---

### Task 4: `useEventStream.ts` — 状态机接线 + microtask 批量 dispatch

**Files:**
- Modify: `packages/zai/src/web/src/store/useEventStream.ts:22-31`（useEventStream）、`:33-109`（dispatch）
- Modify: `packages/zai/src/web/src/store/useAppStore.ts`（`streamState` / `streamAttempt` / `setStreamState`）

**Interfaces:**
- Consumes: `subscribeServerEvents` onState（Task 3）、`ServerEvent.seq`（Task 1）
- Produces: `useAppStore.streamState`；`useEventStream` 批量 dispatch 到 store。

- [ ] **Step 1: 写失败测试** — 新建 `packages/zai/src/web/src/store/useEventStream.test.ts`

mock `useAgentStore.getState().applyRuntimeEvents` 等，验证批量合并：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const applyBatch = async (events: any[]) => {
  // 该逻辑从 useEventStream 抽出为纯函数供测试（applyBatch 导出）
  // 见 Step 3 实现说明
}

describe('useEventStream batch dispatch', () => {
  it('coalesces same-tick events into one apply call', async () => {
    const calls: any[][] = []
    const applyRuntimeEvents = vi.fn((evs: any[]) => { calls.push(evs) })
    // ... 构造最小 dispatch 环境，验证一次 flush 后 applyRuntimeEvents 只被调用一次，
    // 且入参为 [delta#42, delta#43]（按 seq 排序）
  })
})
```

（测试细节以实际抽出的纯函数签名为准；核心断言：**同 tick N 个事件 → 1 次 apply 调用**。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/store/useEventStream.test.ts`
Expected: FAIL — 无批量逻辑。

- [ ] **Step 3: 实现**

1. **抽出纯函数** `applyBatch`（模块内导出供测试）：把 `dispatch` 的 switch 逻辑改为接收事件数组。每个 store reducer 变体改为批量版本：
   - `applyRuntimeEvents(events)`（原 `applyRuntimeEvent` 的批量版，内部先按 sessionId 分组 + 按 seq 排序）
   - `applySessionEvents` / `applyJobEvents` / `applyPromptAsk`（单事件即可，无增量语义）等
   - `server.connected` 特殊处理：批量里若有，仍然同步置 connected + 触发 hydrate（保持现有逻辑）。
2. **microtask 批量**：

```ts
let pending: ServerEvent[] = []
let scheduled = false
function enqueue(event: ServerEvent): void {
  pending.push(event)
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const batch = pending
    pending = []
    applyBatch(batch)
  })
}
```

`subscribeServerEvents(sessionId, enqueue, onState)`；`onState` 写 `useAppStore.setStreamState`。

3. **useAppStore** 增加 `streamState: 'connecting' | 'connected' | 'reconnecting' | 'error'`、`streamAttempt: number`、`setStreamState(state, attempt)`。`server.connected` 仍置 `connected`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/store/useEventStream.test.ts`
Expected: PASS。同时回归 `pnpm --filter @zn-ai/zai test src/web/src/store/useAppStore.test.ts`（若有）。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useEventStream.ts packages/zai/src/web/src/store/useAppStore.ts packages/zai/src/web/src/store/useEventStream.test.ts
git commit -m "feat(zai): microtask-batch SSE dispatch and expose streamState machine"
```

---

### Task 5: `useAgentStore.ts` — seq 守卫 + 投影存储 + `useProjection`

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`（`AgentState` 加 `lastSeqBySession` / `projectionsBySession`；`upsertStreamBlock` / `upsertToolCall` 加 seq 守卫；`applyProjection`）
- Add: `packages/zai/src/web/src/store/useProjection.ts`（新文件）

**Interfaces:**
- Consumes: `ServerEvent.seq`、`session/projection` 帧（Task 1）
- Produces: `lastSeqBySession`、`projectionsBySession`、`applyProjection`、`useProjection(sid, key, selector?, equal?)`。Task 6（投影试点消费）依赖。

- [ ] **Step 1: 写失败测试** — 新建 `packages/zai/src/web/src/store/useProjection.test.ts` + 扩展 `useAgentStore` 相关测试

```ts
import { describe, expect, it } from 'vitest'
import { useAgentStore } from './useAgentStore.js'

describe('projection store higher-seq-wins', () => {
  beforeEach(() => { useAgentStore.setState({ projectionsBySession: {} }) })

  it('first write lands', () => {
    useAgentStore.getState().applyProjection({
      type: 'session/projection', sessionId: 's1', key: 'title',
      value: 'A', seq: 10,
    } as any)
    expect(useAgentStore.getState().projectionsBySession.s1.title.value).toBe('A')
  })

  it('lower seq is dropped', () => {
    useAgentStore.getState().applyProjection({ type: 'session/projection', sessionId: 's1', key: 'title', value: 'A', seq: 10 } as any)
    useAgentStore.getState().applyProjection({ type: 'session/projection', sessionId: 's1', key: 'title', value: 'B', seq: 9 } as any)
    expect(useAgentStore.getState().projectionsBySession.s1.title.value).toBe('A')
  })

  it('higher seq wins', () => {
    useAgentStore.getState().applyProjection({ type: 'session/projection', sessionId: 's1', key: 'title', value: 'A', seq: 10 } as any)
    useAgentStore.getState().applyProjection({ type: 'session/projection', sessionId: 's1', key: 'title', value: 'B', seq: 11 } as any)
    expect(useAgentStore.getState().projectionsBySession.s1.title.value).toBe('B')
  })
})

describe('upsertStreamBlock seq guard', () => {
  beforeEach(() => { useAgentStore.setState({ lastSeqBySession: {}, messages: [], sendSeq: 0, textSegmentRev: 0 }) })

  it('replays lower/equal seq delta are dropped', () => {
    // 先应用 seq=5 的 delta，再模拟重放 seq=4 → 消息不重复追加
  })

  it('increasing seq appends normally', () => {
    // seq=5, seq=6 两次 delta 合并进同一 block
  })
})
```

（upsertStreamBlock 现有签名是 `(kind, base, delta)`；本 Task 改签名加第 4 参 `seq`，Task 4 的 `applyRuntimeEvents` 需同步传入。若破坏太多调用点，改为读 `base.seq` 而不加参数——**以读 `base.seq` 为准，不改变函数签名**，降低改动面。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/store/useProjection.test.ts`
Expected: FAIL — `applyProjection` / `projectionsBySession` 不存在；`lastSeqBySession` 不存在。

- [ ] **Step 3: 实现**

1. `AgentState` 加：

```ts
/** 每 session 已应用的最大事件 seq（只升不降，重放守卫）。 */
lastSeqBySession: Record<string, number>
/** 投影值存储：key → { value, seq }，higher-seq-wins。 */
projectionsBySession: Record<string, Record<string, { value: unknown; seq: number }>>
```

2. `upsertStreamBlock(kind, base, delta)` 入口：

```ts
set((s) => {
  const sid = base.sessionId as string | undefined
  if (sid) {
    const seq = (base as { seq?: number }).seq
    if (typeof seq === 'number' && seq < (s.lastSeqBySession[sid] ?? 0)) {
      return {}   // 重放/乱序 → 丢弃
    }
    if (typeof seq === 'number') {
      s.lastSeqBySession[sid] = seq
    }
  }
  // ... 现有 findIndex/append 逻辑不变
})
```

3. `upsertToolCall(msg)` 入口同理（读 `msg.seq` 守卫；保留 toolUseId 主索引不变）。

4. `applyProjection(event)`：

```ts
applyProjection: (event) => set((s) => {
  const sid = event.sessionId
  const cur = s.projectionsBySession[sid]?.[event.key]
  if (cur !== undefined && event.seq < cur.seq) return {}
  return {
    projectionsBySession: {
      ...s.projectionsBySession,
      [sid]: {
        ...(s.projectionsBySession[sid] ?? {}),
        [event.key]: { value: event.value, seq: event.seq },
      },
    },
  }
})
```

5. 新建 `src/web/src/store/useProjection.ts`（见 spec §5.5），导出自定义 selector + `Object.is` 默认相等比较。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/store/useProjection.test.ts`
Expected: PASS。回归 `pnpm --filter @zn-ai/zai test src/web/src/store/useAgentStore.test.ts`（若存在，确认 upsert 路径无回归）。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/src/web/src/store/useProjection.ts packages/zai/src/web/src/store/useProjection.test.ts
git commit -m "feat(zai): seq guard in stream upserts and per-session projection store with useProjection hook"
```

---

### Task 6: 投影试点 emit + 消费

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts`（title / context.tokens 投影 emit）
- Modify: 会话信息面板组件（context tokens 改用 `useProjection(sid, 'context.tokens')`）
- Modify: Sidebar 会话标题（title 走投影；`session.renamed` 本地 apply 保留）

**Interfaces:**
- Consumes: `eventBus.emit({ type: 'session/projection', ... })`、`useProjection`（Task 5）
- Produces: 两个投影 key 端到端生效。

- [ ] **Step 1: 定位 emit 点**

- `session.created` / `session.renamed` emit 处（agentRuntime）：追加 `eventBus.emit({ type: 'session/projection', sessionId, key: 'title', value: title, seq })`。注意：`eventBus.emit` 会分配 seq，这里 `seq` 字段**省略**即可（spec §4.4 的"当前seq"由 emit 自动填）。
- `runtime.done` emit 处：若 `contextTokens` 存在，追加 `eventBus.emit({ type: 'session/projection', sessionId, key: 'context.tokens', value: contextTokens })`。

- [ ] **Step 2: 实现 server emit**

按上述两个点追加投影 emit。`session.renamed` 场景下 `useProjection(sid, 'title')` 读到的是投影值；`session.renamed` 事件本身继续走原有 `applySessionEvent`（Sidebar 本地 apply 保持，重连由投影帧兜底）。

- [ ] **Step 3: 实现 client 消费**

- 会话信息面板"当前上下文大小"行：`const ctxTokens = useProjection(sid, 'context.tokens')`，`ctxTokens === undefined ? '—' : ctxTokens`（替代现有从 `runtime.done` 读 `contextTokens` 的写法；`runtime.done` 路径保留作 fallback）。
- Sidebar 标题：优先 `useProjection(sid, 'title')`，undefined 时 fallback 到 sessions 列表 title。

- [ ] **Step 4: 测试 + 回归**

Run: `pnpm --filter @zn-ai/zai test test/server/services/agentRuntime.test.ts`（若存在，确认 projection emit 无回归）
Expected: PASS。会话信息面板组件若有测试一并跑。

- [ ] **Step 5: ego-browser 验收（强制）**

用 `/ego-browser` skill 启动 zai（独立端口如 8101），验证：
1. 发一条 prompt → 正常流式输出，增量渲染无错位。
2. 会话信息面板显示 context tokens 数字（来自投影）。
3. Sidebar 标题正确（重命名后立即更新）。
4. 断网模拟 → 黄色"重连中" → 恢复后 UI 自动补齐消息。
5. 连续断线 → 红色 error 态 + 手动重连按钮。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts <会话信息面板组件> <Sidebar 组件>
git commit -m "feat(zai): emit title/context.tokens projections and consume via useProjection"
```

---

### Task 7: 回归 + 清理 + 收尾

**Files:**
- Modify: 按需（`useEventStream.ts` dispatch 的 `applyBatch` 路由 `stream/error` → `setStreamState('error')` + toast）
- Docs: `docs/DEVELOPMENT_REFERENCE.md` 增加 seq / projection / 连接状态机一节

- [ ] **Step 1: stream/error 前端路由**

`applyBatch` 里 `case 'stream/error'` → `useAppStore.setStreamState('error', attempt)` + `applySystemEvent`（复用 toast 逻辑，可选）。

- [ ] **Step 2: 清理手工 key 防御代码（可选）**

`useAgentStore.ts:626-810` 的部分防御逻辑（空字符串 fallback 等）在 seq 守卫稳定后删除——**仅当 Task 5 的测试 + ego 验收都通过后**再动，避免回归。

- [ ] **Step 3: 文档**

`docs/DEVELOPMENT_REFERENCE.md` 追加：`ServerEvent.seq` 语义、`useProjection` 用法、连接状态机说明。

- [ ] **Step 4: 全量回归**

```bash
pnpm --filter @zn-ai/zai test src/shared/events.test.ts test/server/services/eventBus.test.ts src/web/src/lib/eventSource.test.ts src/web/src/store/useEventStream.test.ts src/web/src/store/useProjection.test.ts
pnpm --filter @zn-ai/zai test test/server/routes/event.test.ts        # SSE id: 行验证
```

（不跑 `pnpm -r test` 全量——AGENTS.md 明确禁止把全量当完成前必跑。）

- [ ] **Step 5: 最终 ego-browser 验收**

完整走一遍 AGENTS.md 要求的真实浏览器验收：对话、中断、Ask/Approve、断线重连、投影显示。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/store/useEventStream.ts docs/DEVELOPMENT_REFERENCE.md
git commit -m "chore(zai): route stream/error to error state and document seq/projection/connection-state"
```
