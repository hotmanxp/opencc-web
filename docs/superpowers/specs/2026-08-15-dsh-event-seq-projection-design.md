# 借鉴 dsh 的 SSE 事件序列化与投影状态推送 设计规格

- 日期：2026-08-15
- 状态：设计稿，待评审
- 范围：`packages/zai/src/shared/events.ts`、`packages/zai/src/server/services/eventBus.ts`、`packages/zai/src/server/routes/event.ts`、`packages/zai/src/web/src/store/useEventStream.ts`、`packages/zai/src/web/src/store/useAgentStore.ts`、`packages/zai/src/web/src/lib/eventSource.ts`

> 借鉴 deepseek-harness（dsh）的通信与状态管理架构，为 opencc-web 的 SSE 通道引入：**单调递增 `seq`**（替代手工 key 拼接）、**连接状态机**（替代 EventSource 隐式重连）、**结构化 `stream/error` 帧**（替代松散 server.error）、**microtask 批量 dispatch**（替代逐事件 setState）、**`session/projection` 投影帧**（替代派生数据混在事件流里）。
>
> 参考源：dsh `packages/host/apiproxy/src/api/rpc.ts`、`packages/host/apiproxy/src/api/events.ts`、`packages/client/runtime/src/client/sessions/conversation-assembler.ts`、`packages/client/runtime/src/client/sessions/projection-store.ts`。

---

## 1. 背景与问题

### 1.1 当前痛点

| # | 痛点 | 现状 | 后果 |
|---|---|---|---|
| P1 | 消息合并靠手工 key 拼接 | `upsertStreamBlock` 用 `${sendSeq}:${turnIndex}:${textSegmentRev}:${blockIndex}:${kind}` 拼 React key（`useAgentStore.ts:819-848`） | SSE 重连补发、事件乱序时 key 不可靠；需要大量防御代码（空字符串 fallback、迟到 start 吞并，`useAgentStore.ts:626-810` 约 200 行） |
| P2 | UI 不感知断流 | `useAppStore.connected` 是布尔，靠 `server.connected` 事件置位（`useEventStream.ts:69-76`） | 断流重连中无任何 UI 提示；重连期间用户以为 agent 在思考 |
| P3 | 错误不结构化 | `server.error` 事件 payload 松散，无闭合错误码 union | 前端按字符串匹配 category；新错误类型容易漏处理 |
| P4 | SSE 事件逐条 setState | `dispatch(event)` 直接调 `useAgentStore.getState().applyXxx(event)`（`useEventStream.ts:33-109`） | 一帧内 N 个事件触发 N 次 setState，reducer 跑 N 次 |
| P5 | 派生数据与事件流耦合 | transcript 节点（`deriveTranscriptNodes`）、title、context tokens 都在前端从 messages 数组重新推导 | 重连后要重放全部事件才能重建视图；组件必须订阅整个 messages 数组 |
| P6 | 历史缓冲无监控 | `eventBus.ts:5` `CAPACITY = 256` 硬编码，溢出静默 | 长时间运行 + 高频事件时早期事件静默丢失，重连后视图不完整 |

### 1.2 借鉴目标（dsh 的设计要点）

dsh 的相关机制（以 `packages/client/runtime/src/client/sessions/` 为主）：

1. **`event.seq` 单调递增**（`conversation-assembler.ts:94-117` `mergeMatches` 按 seq 二路归并）：事件窗口以 seq 为唯一顺序基准，重连/重放天然安全。
2. **`stream/error` 帧 + `RpcError` 闭合 union**（`packages/host/apiproxy/src/api/rpc.ts:32-102`）：`RpcErrorDetailsMap` 24 个闭合 code，每个 code 配独立 details shape；帧级错误优雅降级。
3. **`Notifier` 批合并**（`packages/client/runtime/src/client/sessions/notifier.ts:13-86`）：`markDirty()` 排 microtask，`markFrameDirty()` 排 animation-frame，`notifyNow()` 同帧回声。
4. **`session/projection` 帧**（`packages/host/apiproxy/src/api/events.ts:100-107`）：host 算完的派生值按 `{key, value, seq}` 整体推送，client 按 `higher-seq-wins` 合并，重放由 host 重算。
5. **连接状态机**（`packages/client/connection/src/client/connection.ts`）：`'connected' | 'reconnecting'` 二态，严格握手后置位。

### 1.3 目标

1. 给所有 ServerEvent 增加 `seq: number`（服务端单调递增），作为消息合并、重连补发的唯一顺序基准。
2. `useEventStream` 暴露 `'connecting' | 'connected' | 'reconnecting' | 'error'` 状态机，UI 顶栏显示连接指示。
3. 新增 `stream/error` 帧 + `RpcErrorCode` 闭合 union，替代松散的 `server.error`。
4. `useEventStream.dispatch` 改为 microtask 批量：同 tick 内事件合并为一次 setState。
5. 新增 `session/projection` 帧 + `useProjection` 订阅面，先迁移 title / context tokens，后续迁移 transcript nodes。
6. 历史缓冲溢出告警（`console.warn` + 可选 toast）。

### 1.4 非目标 (YAGNI)

- 不实现 WebSocket / 双通道下行（单 SSE 够用，P2 用状态机解决）。
- 不实现四象限 JSON-RPC / RpcId 关联（当前 REST + SSE 模型清晰简单，改造收益边际）。
- 不引入 cordis 依赖注入（2-package monorepo，过度工程）。
- 不实现 dsh 的完整 `ConversationNodeAssembler` 事件窗口（那是框架级抽象；本设计只取其 seq 思想）。
- 不迁移全部派生数据到 projection（只先做 title / context tokens 两个试点，验证模式后再扩展）。

---

## 2. 架构

### 2.1 事件 seq 生命周期

```
server emit 时分配 seq（全局单调递增，不复位）
        │
        ▼
ServerEventBus.emit({...event, seq: ++seqCounter})
        │
        ├─ history (全局 256) + historyBySid (per-sid 256)
        │
        ▼
SSE: id: <eventId> / event: <type> / data: <JSON 含 seq>
        │
        ▼
client EventSource → dispatch() → microtask 批 → applyXxx(events)
        │
        ▼
useAgentStore: 每 session 记录 lastSeqBySession[sid]（只升不降）
                upsertStreamBlock / upsertToolCall 以 seq 守卫替代手工 key
```

### 2.2 连接状态机

```
          EventSource onopen (首个连接)
                │
                ▼
           'connecting' ──onopen──▶ 'connected'
                ▲                        │
                │                    断线 (onerror)
                │                        ▼
                │                   'reconnecting' ──onopen──▶ 'connected'
                │                        │
                │                   连续失败 > 3 次
                │                        ▼
                └─────────────── 'error'（UI 显示错误 + 手动重连按钮）
```

- `server.connected` 事件到达 → 置 `connected`（并触发 `hydrateSessionState`，保持现有冷启动逻辑）。
- `server.error` 事件到达 → 置 `error`。
- EventSource `onopen` → 置 `connected`（若之前是 reconnecting/connecting）。
- EventSource `onerror` → 置 `reconnecting`；连续 3 次 → `error`。

### 2.3 帧级错误

```
stream/error 帧：
{ type: 'stream/error', seq, error: { code, message, details } }
code 为 RpcErrorCode 闭合 union（新增 schema，见 §3.3）
```

- server 在 SSE 写入中途崩溃 → 发一个 `stream/error` 帧然后关闭连接（dsh `api-proxy.ts` fetch handler 同款行为）。
- client 收到 `stream/error` → 置 `error` 状态 + toast，不再静默断流。

### 2.4 projection 投影帧

```
session/projection 帧：
{ type: 'session/projection', seq, sessionId, key: string, value: unknown, seq: number }
        │
        ▼
useAgentStore.projectionsBySession: Record<sid, Record<key, { value, seq }>>
        │
        ▼
useProjection(sid, key, selector?) → 订阅面（select 派生 + 订阅）
```

- `value` 是 host 侧 schema 校验过的完整快照（不是 diff）。
- client 只做 `higher-seq-wins` 合并：`incoming.seq < current.seq` 直接丢弃。
- 重连后：host 重算投影值整体下发（`getHistoryAfterForSid` 已覆盖），client 不用关心合并。
- 首个试点：`title`（会话标题）、`context.tokens`（上下文 token 数）。
- title 事件（`session.renamed`）到达时同步 `projections.apply('title', title, seq)`，与 dsh `session.ts:341-349` rename 后本地 apply 同款。

---

## 3. 事件 schema

### 3.1 Base 增加 `seq`

`shared/events.ts:3-6`：

```ts
const Base = z.object({
  eventId: z.string(),
  ts: z.number(),
  // 服务端全局单调递增顺序号 — 消息合并 / 重连补发 / 投影合并的唯一基准。
  // 由 eventBus.emit 分配（见 §4.1），server 手工 emit 时必须显式提供或省略
  // （省略则 emit 时填充）。
  seq: z.number(),
})
```

所有事件（runtime.* / session.* / job.* / prompt.* / system.* / state.* / instance.* / queue.*）自动继承 `seq`。

### 3.2 新增 `stream/error` 帧

`shared/events.ts` 新增 `StreamErrorEvent` 并加入 `ServerEvent` union：

```ts
const RpcErrorCode = z.enum([
  'internal',
  'bad-request',
  'session-not-found',
  'session-conflict',
  'model-unavailable',
  'timeout',
  'cancelled',
  'agent-busy',
  'stream-write-failed',
  'invalid-response',
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
```

- `stream/error` 是纯 server→client 推送，无 sid（或带 `sessionId?: string` 可选，有则聚焦到会话，无则全局）。
- 现有 `server.error` 保留（兼容旧 toast 逻辑），`stream/error` 是更结构化的补充，不互相替代。

### 3.3 新增 `session/projection` 帧

```ts
const ProjectionEvent = z.object({
  ...Base.shape,
  type: z.literal('session/projection'),
  sessionId: z.string(),
  key: z.string().min(1),
  value: z.unknown(),          // host 侧 schema 已校验；此处保持 wide
  seq: z.number().int().nonnegative(),  // 投影单元的 watermark，higher-seq-wins
})
```

### 3.4 `ServerEvent` union 扩展

`shared/events.ts:255-264`：

```ts
export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
  ...StateEvent.options,
  ...InstanceEvent.options,
  ...QueueEvent.options,
  // 新增：
  z.object({ ...Base.shape, type: z.literal('stream/error'), error: z.object({ code: RpcErrorCode, message: z.string(), details: z.record(z.unknown()).default({}) }) }),
  z.object({ ...Base.shape, type: z.literal('session/projection'), sessionId: z.string(), key: z.string().min(1), value: z.unknown(), seq: z.number().int().nonnegative() }),
])
```

---

## 4. Server 端实现

### 4.1 `ServerEventBus.emit` 分配 seq

`eventBus.ts:82-113`：

```ts
export class ServerEventBus {
  private seqCounter = 0
  // ...

  emit(event: ServerEventInput) {
    const full: ServerEvent = {
      ...event,
      eventId: event.eventId ?? nextId(),
      ts: event.ts ?? Date.now(),
      seq: event.seq ?? ++this.seqCounter,   // 分配全局单调 seq
    } as ServerEvent
    // ... 现有 history / historyBySid / subscriber 逻辑不变
  }
}
```

- `seq` 只在 emit 时分配，所有 emit 源（agentRuntime、stateBridge、backgroundRuntime 等）无需关心。
- 进程重启后从 0 重新计数——**seq 只保证单进程内单调**，跨进程/跨重启的排序由 `history` replay + `eventId` 兜底。

### 4.2 SSE 路由写入 seq

`event.ts:27-97`：`writeSse` 已用 `event.seq ?? event.eventId` 作为 `id:`（`sse.ts:47`）。seq 加入后，`id:` 自动携带 seq——`Last-Event-ID` 续读不受影响（eventBus history 按 eventId 比对，`getHistoryAfterForSid` 逻辑不变）。

### 4.3 stream/error 生成点

- `sse.ts` `writeSse` 包一层 try/catch：写入失败 → 尝试发 `stream/error` 帧（code `stream-write-failed`）再关闭。
- 业务侧捕获到未预期异常且无法继续推送时 → emit `stream/error`（code `internal`）再关连接。

### 4.4 projection 试点 emit 点

| key | 触发点 | 值来源 |
|---|---|---|
| `title` | `session.created` / `session.renamed` | `title` 字段 |
| `context.tokens` | `runtime.done`（带 `contextTokens`） | `contextTokens` 字段 |

在 agentRuntime 里现有 emit 处追加：

```ts
// 标题变化后
eventBus.emit({ type: 'session/projection', sessionId, key: 'title', value: title, seq: 当前seq })

// runtime.done 后
eventBus.emit({ type: 'session/projection', sessionId, key: 'context.tokens', value: contextTokens, seq: 当前seq })
```

### 4.5 历史缓冲溢出告警

`eventBus.ts:97,103` 的 `shift()` 处：

```ts
if (this.history.length > CAPACITY) {
  console.warn(`[eventBus] history overflow: 全局缓冲已达 ${CAPACITY} 条, 最旧事件将被丢弃`)
  this.history.shift()
}
// historyBySid 同理（per-sid 维度）
```

不推 toast（避免高频刷屏），只 console.warn + 可后续接监控。

---

## 5. Client 端实现

### 5.1 EventSource 封装加状态回调

`eventSource.ts:68-100` 的 `subscribeServerEvents` 增加 `onState` 回调参数：

```ts
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'error'

export function subscribeServerEvents(
  sid: string | null,
  onEvent: (event: ServerEvent) => void,
  onState?: (state: StreamState, attempt: number) => void,
): StreamHandle
```

- `es.onopen` → `onState('connected', attempt)`（重置 attempt 计数）。
- `es.onerror` → `attempt++`，`attempt <= 3 ? onState('reconnecting', attempt) : onState('error', attempt)`。
- 首次连接（尚未 onopen）→ `onState('connecting', 0)`。

### 5.2 useEventStream 连接状态机

`useEventStream.ts:22-31`：

```ts
export function useEventStream(): void {
  const sessionId = useAgentStore((s) => s.sessionId)
  useEffect(() => {
    if (!sessionId) return
    const handle = subscribeServerEvents(sessionId, dispatch, (state, attempt) => {
      useAppStore.getState().setStreamState(state, attempt)
    })
    return () => { handle.close() }
  }, [sessionId])
}
```

- `useAppStore` 增加 `streamState: StreamState` + `streamAttempt: number` + `setStreamState`。
- `server.connected` 事件到达时仍置 `connected`（覆盖 EventSource onopen 的时序差）。
- UI：顶栏（或状态栏）显示连接指示：`connected` 隐藏 / `reconnecting` 黄色 spinner + "重连中…" / `error` 红色 + 手动重连按钮。

### 5.3 dispatch 批量处理

`useEventStream.ts:33-109` 改为：

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

function applyBatch(batch: ServerEvent[]): void {
  // 按 sessionId 分组；同 session 的事件按 seq 排序后合并成一次 setState 调用。
  // 具体合并策略见 §5.4。
}
```

- `applyBatch` 内每个 reducer 调用改为传 `batch` 而不是单事件（`applyRuntimeEvents(events)` 等），内部合并后再 set。
- 受控输入（输入框 onChange）不走此路径，保持同步——`submitPrompt` / 本地 UI 状态不受影响。

### 5.4 seq 守卫替代手工 key

`useAgentStore.ts:819-848` `upsertStreamBlock`：

```ts
// 保留 key 拼接用于 React 渲染（不变），
// 新增 seq 守卫：同一 turn/block 的 delta 只在 seq 严格递增时合并，
// 乱序/重放的 delta 直接丢弃。
upsertStreamBlock: (kind, base, delta, seq) =>
  set((s) => {
    const key = `${s.sendSeq}:${turnIndex}:${s.textSegmentRev}:${blockIndex}:${kind}`
    const prevSeq = s.lastSeqBySession[base.sessionId] ?? 0
    if (seq < prevSeq) return {}          // 重放/乱序 → 丢弃
    s.lastSeqBySession[base.sessionId] = seq
    // ... 现有 findIndex/append 逻辑
  })
```

- `lastSeqBySession: Record<string, number>` 加进 `AgentState`。
- `upsertToolCall` 同样在入口做 seq 守卫（保留 toolUseId 主索引不变）。
- **渐进式**：第一版只加守卫，不删手工 key（手工 key 仍负责 React 渲染分组）；手工 key 的防御代码后续清理。

### 5.5 useProjection 订阅面

`useAgentStore` 增加投影存储 + hook：

```ts
// store
projectionsBySession: Record<string, Record<string, { value: unknown; seq: number }>>
applyProjection: (event) => set((s) => {
  const sid = event.sessionId
  const cur = s.projectionsBySession[sid]?.[event.key]
  if (cur && event.seq < cur.seq) return {}   // higher-seq-wins
  return {
    projectionsBySession: {
      ...s.projectionsBySession,
      [sid]: { ...(s.projectionsBySession[sid] ?? {}), [event.key]: { value: event.value, seq: event.seq } },
    },
  }
})
```

`useProjection`（新文件 `src/web/src/store/useProjection.ts`）：

```ts
export function useProjection<T>(
  sessionId: string | null,
  key: string,
  selector: (value: unknown) => T = (v) => v as T,
  equal: (a: T, b: T) => boolean = Object.is,
): T | undefined {
  return useAgentStore(
    (s) => {
      const cell = sessionId ? s.projectionsBySession[sessionId]?.[key] : undefined
      return cell ? selector(cell.value) : undefined
    },
    equal,
  )
}
```

**试点迁移**：
- 会话信息面板的"当前上下文大小"：`useProjection(sid, 'context.tokens')`。
- Sidebar 会话标题（session.renamed 时本地 apply 已同步，重连由投影帧覆盖）。

---

## 6. 数据流（端到端示例）

```
用户发送 prompt
  │
  ▼
POST /api/agent/prompt → runQueryLoop
  │
  ▼
模型开始流式输出 → translateRuntimeEvents → eventBus.emit(runtime.delta)
  │                                   seq = 42
  ▼
SSE id: 42 / event: runtime.delta / data: {...}
  │
  ▼
EventSource onmessage → dispatch → pending.push → microtask flush
  │
  ▼
applyRuntimeEvents([delta#42, delta#43]) → 一次 setState
  │
  ▼
upsertStreamBlock(seq=43 > lastSeq=42) → append → React 渲染增量
```

断线重连场景：

```
EventSource onerror → attempt=1 → streamState='reconnecting' → UI 黄色提示
  │
  ▼
EventSource 自动重连 → 重新 GET /api/event?sid=xxx（带 Last-Event-ID）
  │
  ▼
eventBus.getHistoryAfterForSid(lastEventId, sid) → 补发缺失事件（含 seq）
  │
  ▼
dispatch → seq 守卫丢弃已应用的（seq <= lastSeqBySession），只应用新的
  │
  ▼
onopen → streamState='connected' → UI 恢复正常
```

---

## 7. 文件清单

### Server

| 文件 | 改动 |
|---|---|
| `packages/zai/src/shared/events.ts` | Base 加 `seq`；新增 `stream/error`、`session/projection` 帧；`ServerEvent` union 扩展 |
| `packages/zai/src/server/services/eventBus.ts` | emit 分配 seq；历史缓冲溢出告警 |
| `packages/zai/src/server/services/sse.ts` | writeSse try/catch → stream/error |
| `packages/zai/src/server/routes/event.ts` | 无改动（id: 自动带 seq）；可选：路由级 stream/error 兜底 |
| `packages/zai/src/server/services/agentRuntime.ts` | projection 试点 emit（title / context.tokens） |

### Client

| 文件 | 改动 |
|---|---|
| `packages/zai/src/web/src/lib/eventSource.ts` | `onState` 回调 |
| `packages/zai/src/web/src/store/useEventStream.ts` | 连接状态机 + microtask 批量 dispatch |
| `packages/zai/src/web/src/store/useAppStore.ts` | `streamState` / `streamAttempt` |
| `packages/zai/src/web/src/store/useAgentStore.ts` | `lastSeqBySession` + seq 守卫；`projectionsBySession` + `applyProjection` |
| `packages/zai/src/web/src/store/useProjection.ts` | 新文件：`useProjection` hook |
| 状态栏组件（`src/web/src/components/`） | 连接指示 UI |

---

## 8. 测试策略

- **单元测试**（vitest，`packages/zai/src/web/src/` 或 `packages/zai/test/`）：
  - `eventBus.test.ts`：seq 分配单调递增；溢出告警触发。
  - `useEventStream` dispatch 批量：同 tick 多次 emit → 一次 setState（mock zustand set）。
  - `upsertStreamBlock` seq 守卫：乱序/重放 delta 丢弃；正常递增合并。
  - `applyProjection` higher-seq-wins：低 seq 丢弃、高 seq 覆盖、首次写入。
- **服务端测试**：`event.ts` SSE 路由 `id:` 行携带 seq。
- **手工验收**（AGENTS.md 强制规则）：`/ego-browser` 启动真实实例，验证：
  - 正常对话流式输出（增量渲染无错位）。
  - 断网（ego 断网或 kill 连接）→ 黄色"重连中"提示 → 恢复后 UI 自动补齐。
  - 会话信息面板显示 context tokens（来自 projection）。
  - 断开后等待 >3 次重连 → 红色 error + 手动重连按钮。

---

## 9. 验收标准

1. `shared/events.ts` 所有事件带 `seq`，zod schema 全通过。
2. 同 session 事件按 seq 合并，重放事件被 seq 守卫丢弃（单元测试覆盖）。
3. 断网后 UI 显示"重连中"，恢复后自动补齐；连续失败显示错误态 + 手动重连。
4. `session/projection` 帧在 title / context.tokens 两个试点生效，`useProjection` 组件订阅正确。
5. 历史缓冲溢出触发 console.warn。
6. 现有 59 种事件类型的订阅、渲染、中断、Ask/Approve 流程全部回归通过（ego-browser 验收）。
7. 无 WebSocket / 无 RpcId / 无 cordis 引入（非目标守住）。
