# zai 流中途网络崩溃后用户【继续上一轮】按钮 — 设计文档

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-22-zai-stream-mid-continue |
| 作者 | Claude(经 brainstorming) |
| 状态 | 设计中 → 待评审 |
| 父 spec | 2026-07-22-zai-modelcaller-529-retry(spec §8 第 1 项 out-of-scope 的"流中途 retry") |
| 目标交付 | 在 StatusBar 上提供【继续上一轮】按钮,允许用户在流中途网络崩溃 (TypeError: terminated / 5xx / 529) 后,一键让 LLM 从中断点续写,不丢失已有消息上下文,不需手输原 prompt |
| 范围 | 1 个新 SSE category + 1 个新 server 路由 + 1 个 queryLoop 扩展点 + 1 个 store 字段 + StatusBar UI + 测试 |
| 工作量 | 1.5-2 天 |

## 1. 背景与目标

### 1.1 问题陈述

zai 主对话路径在**流中途**遇到网络层崩溃时(典型:proxied minimax API 返回 TypeError: terminated / 5xx / 529 mid-stream),`modelCaller.ts:410` 的设计**主动不重试**(避免丢弃已送出的 token 致 UI 闪退),而是抛错向上。`routes/agent.ts:556` catch → 推 `runtime.error(internal)` SSE → 前端 `useAgentStore` 红色 Card → turn 终止。用户必须手输原 prompt 才能继续,而中断前的 LLM 输出 token 已经残留在 messages 里。

最近的 minimax 监控日志:
```
[zai.modelCaller] ← error {"model":"MiniMax-M3","stage":"stream","eventCount":6,"name":"TypeError","message":"terminated"}
```
(stream 阶段已送出 6 个事件后 socket 被对端关闭,典型 30-60s 后 minimax proxy 强踢 keep-alive)

### 1.2 与父 spec 的关系

父 spec `2026-07-22-zai-modelcaller-529-retry` §8 已明确列出"流中途 retry"作为**单独 spec 后续处理**。本 spec 是该 out-of-scope 的具体实现,**不**做流中途重试,**做** UI 层"继续"按钮。两者是同一问题的两个独立解决方案。

### 1.3 目标

1. 流中途网络崩溃时,前端 StatusBar 出现【继续上一轮】按钮
2. 点击按钮:server 在该 session 上启新 turn,带不可见 user message "请继续"(promptIsMeta=true,不入 transcript),LLM 看到 6 个 token + "请继续" 自然续写
3. button 出现条件限定:仅 stream-interrupted 类错误(create 阶段错误不显示 — 因为 modelCaller 已自动重试,用户不需要手触发)
4. server 端错误不可消歧时回 409 Conflict,前端用 toast 显示
5. 与父 spec 的 `runtime.retrying` 事件无冲突

## 2. 公共契约(冻结)

### 2.1 New ErrorCategory

`packages/zai-agent-core/src/runtime/events.ts:0` 给 `ErrorCategory` union 增加新值:

```ts
export type ErrorCategory =
  | 'llm_provider'
  | 'llm_provider_overloaded'
  | 'llm_provider_rate_limit'
  | 'llm_provider_server'
  | 'llm_provider_auth'
  | 'stream_interrupted'   // ← new
  | 'tool_execution'
  | 'permission_denied'
  | 'transcript_io'
  | 'context_window'
  | 'compaction_failure'
  | 'mcp_server'
  | 'skill_load'
  | 'internal'
  | 'aborted'
```

### 2.2 New queryLoop option: `promptIsMeta`

`packages/zai-agent-core/src/runtime/types.ts:QueryOptions` 加字段:

```ts
export interface QueryOptions {
  // ... 现有字段 ...
  /** 当 true 时,不 appendUserMessageV2 到 transcript (避免"自动注入的 hidden 系统消息"污染用户历史),
   *  但 messages.push 仍然跑 → LLM 上下文看到这条 hidden user message. */
  promptIsMeta?: boolean
}
```

`packages/zai-agent-core/src/runtime/queryLoop.ts:266` 改造:

```ts
} else if (typeof options.prompt === 'string') {
  messages.push({ role: 'user', content: options.prompt })
  // ↓ 加条件
  if (!options.promptIsMeta) {
    const u = await appendUserMessageV2(store, sessionId, options.prompt, 0, lastUuid, ctx)
    if (u) lastUuid = u
  }
}
```

类似对 `Array.isArray(options.prompt)` 分支(line 270-275)应用同样的 `if (!options.promptIsMeta)` 守护。

### 2.3 New SSE runtime.error category 字段语义

`packages/zai/src/shared/events.ts:49` zod variant `runtime.error` 不动(category 字段已经是 `z.string()`),前端 reducer 根据 category === 'stream_interrupted' 切到 `continuableBySession[sid] = true` 分支。

### 2.4 New module: `sessionStates.ts`

`packages/zai/src/server/services/sessionStates.ts` (new):

```ts
/** Stream-interrupted session tracker. 服务器进程内 in-memory Map,per-session 布尔.
 *
 *  模型调用流中途抛错时 (TypeError: terminated / 5xx / 529) mark 进入;
 * /api/agent/continue 调用时 consume (atomic delete-and-true);
 * LRU 1h 清理防内存膨胀.
 *
 * 不持久化 — 重启 server 后这些标记丢失, 用户重新点 button 时会拿到 409,
 * 不是正确状态, 但属于可接受的"重启后状态丢失"语义. */
const streamInterrupted = new Map<string, { at: number; partialText?: string }>()

export function markStreamInterrupted(sid: string, partialText?: string): void {
  streamInterrupted.set(sid, { at: Date.now(), partialText })
}

export function consumeStreamInterrupted(sid: string): boolean {
  return streamInterrupted.delete(sid)  // 单次读取即清, 防止重复 continue
}

export function hasStreamInterrupted(sid: string): boolean {
  return streamInterrupted.has(sid)
}

// LRU 清理: 1h 没消费的 entry 删掉
const STREAM_INTERRUPTED_TTL_MS = 3_600_000
const STREAM_INTERRUPTED_GC_INTERVAL_MS = 600_000
const gcTimer = setInterval(() => {
  const expireAt = Date.now() - STREAM_INTERRUPTED_TTL_MS
  for (const [sid, v] of streamInterrupted) {
    if (v.at < expireAt) streamInterrupted.delete(sid)
  }
}, STREAM_INTERRUPTED_GC_INTERVAL_MS)
gcTimer.unref()  // 不阻塞 process exit
```

注:LLM 续写的 partialText(已送出的前 6 个 token 文本)在 `markStreamInterrupted` 时被填入,**不用于本次** spec — 因为 transcript 里已有这些 token 的 assistant partial-block,LLM 跟 transcript 续写已经足够。partialText 字段是为未来 "client-side 续写而非 LLM 续写" 的方案预留,本 PR 不消费它。

### 2.5 New route: `/api/agent/continue`

`packages/zai/src/server/routes/agent.ts` 加路由:

```ts
router.post('/agent/continue', async (req, res) => {
  const parsed = ContinueRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {sessionId}' })
  }
  const { sessionId } = parsed.data
  if (!consumeStreamInterrupted(sessionId)) {
    return res.status(409).json({
      error: 'session is not in stream-interrupted state',
      hint: 'use /api/agent/prompt for fresh prompts',
    })
  }
  // 复用 /prompt 路由的 dispatch helper:
  const ctx = req.app.locals.instanceContext as { cwd: string; cwdName: string }
  return dispatchPrompt({
    sessionId,
    prompt: '请继续',
    promptIsMeta: true,
    cwd: ctx.cwd,
    res,
    req,
  })
})
```

`ContinueRequest` zod schema:

```ts
const ContinueRequest = z.object({
  sessionId: z.string().min(1),
})
```

`/prompt` 路由内部抽出 `dispatchPrompt(params)` 公共 helper, `/prompt` 与 `/continue` 共用。`/prompt` 不传 `promptIsMeta` (undefined → transcript 正常 append),`/continue` 传 true → transcript 不 append。

### 2.6 New store field: `continuableBySession`

`packages/zai/src/web/src/store/useAgentStore.ts`:

```ts
interface AgentState {
  // ... 现有 ...
  /** Set of sessionIds whose last turn ended in stream-interrupted error.
   *  Keyed by sessionId. StatusBar reads this to render the [继续上一轮] button. */
  continuableBySession: Record<string, true>
  handleContinue: (sessionId: string) => Promise<void>
}
```

reducer 改造:

`applyRuntimeEvent` 中 `case 'runtime.error':` 分支(line 1328): 当 `category === 'stream_interrupted'` 时:
```ts
useAgentStore.setState((s) => ({
  ...s,
  continuableBySession: { ...s.continuableBySession, [sid]: true },
}))
```

(在原 setStatus('error') 之外,**不**替代。两条都跑。)

新增 `handleContinue` action:

```ts
handleContinue: async (sessionId: string) => {
  const s = get()
  if (!s.continuableBySession[sessionId]) return
  // 立即让 UI 切到 streaming 状态,按钮消失
  set((cur) => ({
    ...cur,
    continuableBySession: Object.fromEntries(
      Object.entries(cur.continuableBySession).filter(([k]) => k !== sessionId)
    ),
    status: 'streaming',
  }))
  try {
    const res = await fetch('/api/agent/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!res.ok) {
      // 409 not-interrupted / 400 / etc. — revert to error
      set({ status: 'error' })
    }
    // 200: SSE 流走 eventBus → applyRuntimeEvent 推 status='streaming' → status='idle'
    // 已经有, 不需要这里管
  } catch (err) {
    set({ status: 'error' })
  }
}
```

### 2.7 StatusBar UI 改造

`packages/zai/src/web/src/components/AgentInputBox.tsx`(BottomStatusBar 实际位置在 AgentInputBox 内,不是独立 BottomStatusBar 文件,见 113 行)。状态行区域增加 button:

```tsx
const showContinue = status === 'error' && continuableBySession[currentSessionId]

<div data-testid="agent-input-status-row">
  {showContinue ? (
    <>
      <span>✗ {errorMessage}</span>
      <button
        data-testid="agent-input-continue"
        onClick={() => useAgentStore.getState().handleContinue(currentSessionId)}
      >
        继续上一轮
      </button>
    </>
  ) : (
    <span>...正常状态行...</span>
  )}
</div>
```

`errorMessage` 显示需新增 `errorBySession: Record<string, string>` 字段(存 runtime.error.message),applyRuntimeEvent 时写入。

## 3. 行为列表(必实现 + 测试)

| 编号 | 行为 | 验收测试 |
|---|---|---|
| B1 | modelCaller 流中途抛 TypeError → catch 推到上层 | 已通过(modelCaller.test.ts T4) |
| B2 | routes/agent 收到 stream-interrupted 错误,mark + emit SSE with category='stream_interrupted' | routes/agent.test.ts new |
| B3 | 前端 applyRuntimeEvent 收到 category='stream_interrupted' → continuableBySession[sid]=true, store.status='error' | useAgentStore-retrying.test.ts 扩展 |
| B4 | StatusBar status='error' & continuable → 渲染 [继续上一轮] 按钮 | new StatusBar test |
| B5 | 点击 [继续上一轮] → POST /api/agent/continue { sessionId } | E2E / manual |
| B6 | server /continue route 接收,consumeStreamInterrupted → true | sessionStates.test.ts new |
| B7 | server dispatchPrompt helper with prompt='请继续', promptIsMeta=true | queryLoop-promptIsMeta.test.ts new (zai-agent-core) |
| B8 | zai-agent-core queryLoop 收到 promptIsMeta=true → 不调用 appendUserMessageV2, 但 push messages (LLM 上下文可见) | queryLoop-promptIsMeta.test.ts new |
| B9 | server /continue 在没有 stream-interrupted 时返回 409 | sessionStates.test.ts new |
| B10 | LLM 续写成功, runtime.done → status='idle', 按钮消失(continuableBySession 已清空) | E2E / manual |

## 4. 测试点

### 4.1 Layer 1 — `packages/zai/test/services/sessionStates.test.ts` (new)

- markStreamInterrupted + consumeStreamInterrupted → consume returns true
- 同一 sid mark 两次后再 consume → returns true (delete idempotent)
- 不同 sid 独立
- hasStreamInterrupted 反映 mark/consume 状态
- 1h GC 清理 (用 vitest fake timers 推进时间)

### 4.2 Layer 2 — `packages/zai/test/server/agentContinue.test.ts` (new)

- POST /api/agent/continue 无 body → 400
- POST /api/agent/continue 无效 sessionId 格式 → 400
- session 未标记 → 409 with hint
- session 已标记 → 200, session 标记被 consume, promptIsMeta=true 透传到 agentRuntime.run options
- 双重注册(session 已在跑 + 收 continue)→ 409

### 4.3 Layer 3 — `packages/zai-agent-core/test/runtime/queryLoop-promptIsMeta.test.ts` (new)

- promptIsMeta=true + prompt='请继续' → transcript 不 append (mock store.appendUserMessageV2 验证未调)
- messages 数组含 {role:'user', content:'请继续'}
- agentRuntime.run 透传 promptIsMeta 到 queryLoop

### 4.4 Layer 4 — `packages/zai/test/web/useAgentStore-retrying.test.ts` 扩展

- runtime.error with category='stream_interrupted' → continuableBySession[sid]=true, messages 含 error msg
- runtime.error with category='internal' → continuableBySession[sid] 不变 (button 不亮)
- handleContinue 调用 → clear continuableBySession + status='streaming'
- handleContinue 调用后清 continuableBySession 后再次收到 runtime.done → status='idle' 正常

## 5. 验收门

1. `pnpm test packages/zai` 全绿 — 所有 sessionStates / agentContinue / useAgentStore / 已有 modelCaller 测试 100% pass
2. `pnpm test packages/zai-agent-core` 全绿 — queryLoop-promptIsMeta + 已有 retryPolicy/DefaultBackgroundRuntime 测试 100% pass
3. `pnpm typecheck` 在 zai 和 zai-agent-core 都 0 错误
4. 手动场景:
   a. dev server 跑起来, 打开 /agent
   b. 等真实 5xx / 529 网络错误(可临时 mock 一下 minimax baseURL 让它 5xx)→ 复现"6 个 token + 错误"
   c. 点 [继续上一轮] → StatusBar 切 streaming → LLM 接着 6 个 token 后面续写
   d. 续写成功 → status='idle'
   e. 续写也流中途崩 → 按钮再次出现(可再次点,直到修好网络)

## 6. 风险与边界场景

| 风险 | 缓解 |
|---|---|
| 内存中的 `streamInterrupted` Map 在 server 重启后丢失, 用户重新点 button 时拿到 409 但仍想继续 | 接受 409 + UI toast "session 已过期, 请重新发 prompt"。不要补一次空 prompt 兜底 — 兜底会让用户看到无明确语义的继续, 反而更迷惑 |
| 用户在 button 渲染后立刻手 abort (Esc) → button 已 visible 但 streamInterrupted entry 仍存在, 用户后续点 button 仍能 invoke continue (但 turn 已被 abort) | consume 在用户点时执行 — 若 abort signal 已 set, queryLoop 看到 abort → runtime.aborted SSE 推前端 → status='aborted'。中途 button click 也无副作用 |
| 双重 click(用户连点 2 下 [继续]) | 第 1 击 → consume clears entry → status='streaming', button 消失 (条件 §2.7). 第 2 击在 button 不在 DOM 时不可触发. 但 server 端仍可能有 race — 在 `/continue` handler 里 `consumeStreamInterrupted(sid)` 原子 delete-and-test, 第 2 次 → false → 409. 安全 |
| continue 期间再次流中途崩 → markStreamInterrupted 覆盖之前的 at 时间戳 → 用户能再次点 [继续]. 进入"无限继续"循环 | 不加循环上限. 这是用户在该场景下唯一恢复路径. 加了反而阻挠用户恢复. 但加监控 metric 暴露该场景数量 |
| promptIsMeta=true 的 transcript 缺失 — 后续 transcript 重启新 turn 时, 不读到这条 hidden message | 没问题. 设计意图就是如此: hidden message 仅 serve 当前 LLM turn. transcript 是干净的 user 交互历史. 重启后行为与正常 user 行为一致 |
| SDK on zai-agent-core 内 hardcode 把 `options.prompt = '请继续'` 字符串截断 → 需要统一来源 | '请继续' 字符串只在 server 端硬编码 (一处). agent-core 不需要认识这条文字 |
| QueryLoop option 新增 `promptIsMeta` 后 zai-agent-core 兼容老的 defaultAgentRuntime caller | QueryOptions 是 interface, optional 字段 — 既有 caller (SubagentNotifier 等) 不需要改 |

## 7. 不锁定 (实现细节由实现者决定)

- **server `dispatchPrompt` 公共 helper** 的具体实现 — 是抽函数还是类, 由实现者挑
- **StatusBar 状态行组件的精确布局** — 当前 MessageBubble.tsx:936 Card + AgentInputBox.tsx StatusBar 都可能成为按钮容器, 见 zai 该区域是否一并替换
- **`errorBySession` 字段是否在 store 内合并到 continuableBySession** — 是 `Record<string, {message, partialText}>` 还是两个独立 Map, 由实现者定
- **i18n key 命名** — 'agent.continueTurn' / 'agent.error.networkInterrupted' 等, 由 i18n 工程师定
- **session-interrupted entry 的 LRU GC interval** — 1h TTL + 10min GC 是默认值; 若 server 重启频繁可改

## 8. 范围之外 (Out of Scope)

- 流中途自动 retry (modelCaller 层变更, 独立 spec, spec §8 第 1 项)
- BackgroundRuntime 流中途 retry (spec §8 第 2 项)
- queryLoop 外层 retry (spec §8 第 3 项)
- 改 ErrorCategory 之外的其他 type 扩展 (e.g., message.resume_count, etc.)
- 改 promptIsMeta 之外的 queryLoop 行为
- 重构 routes/agent.ts (除抽 dispatchPrompt helper)
- 改 SDK error.message 内容
- 国际化新 key (用现有 i18n 资源或临时硬编码中文)
- 监控埋点 (Meta 暴露, MetricEmitter) — 仅在后续 PR 考虑
- 改变原有的 4 类新增 category 之外的 ErrorCategory (e.g., 把 'internal' 改名 'unknown' 等)

## 9. 时间线与依赖

| 依赖 | 说明 |
|---|---|
| 父 spec `2026-07-22-zai-modelcaller-529-retry` | 已交付, `modelCaller.ts` 与 `useAgentStore` 已支持 runtime.retrying. 本 spec 复用 useAgentStore.applyRuntimeEvent |
| zai-agent-core queryLoop | 改 queryLoop.ts + types.ts; 不改 runtime/index.ts export |
| StatusBar UI | 当前在 AgentInputBox.tsx 113 行 (data-testid="agent-input-status-row"). 复用既有组件, 不新开 |
| SSE schema | 不改 zod variant. runtime.error category 已经是 z.string() |

预计落地:
- T+0d 设计批准 + spec commit
- T+1d PR1: agent-core 新增 promptIsMeta + test (zai-agent-core)
- T+2d PR2: zai 新增 sessionStates + route + reducer + UI + test (zai)

PR1 与 PR2 可合并 PR, 但 promptIsMeta 需先于 dispatchPrompt helper 上线.
