# zai 会话压缩能力 — 完整追平 OpenCC 设计文档

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-session-compaction |
| 作者 | Claude(经 brainstorming 流程) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | 在 zai 主路径中完整追平 OpenCC 上游会话压缩能力 |
| 范围 | 6 个子项目,见 §1.2 |
| 工作量 | 7-12 天 |

## 1. 背景与目标

### 1.1 问题陈述

zai 当前主路径(`runtime/queryLoop.ts` + `runtime/compactService.ts` + `zai/src/server/services/commands/builtin/compact.ts`)只支持手动 `/compact` 命令,且实现是简化版:

| 维度 | OpenCC 上游 | zai 现状 |
|---|---|---|
| 模块体量 | 11 个文件,~150 KB | 1 个文件,7 KB |
| 主动防线(snip / microcompact / autocompact) | ✅ 全部 | ❌ 全部缺失 |
| Reactive compact(API 413 自愈) | ✅ 全套(PTL + media_size + max_tokens escalate) | ❌ 缺失 |
| API 原生 microcompact(`context_management.edits`) | ✅ 接入 ModelCaller | ❌ 未接入 |
| Circuit breaker | ✅ `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` + 5min cooldown + half-open | ❌ 缺失 |
| Manual `/compact` 质量 | streaming + PTL 自愈 + cache 复用 + hook | 60s timeout,无重试,无 hook,无 cache 复用 |
| Transcript resume 支持 `compact_boundary` | ✅ `getMessagesAfterCompactBoundary` | ❌ 缺失 |

后果:zai 用户跑长会话时,200k 上下文打满只能等 `prompt_too_long` 报错,API 偶发 413 也会让任务挂掉,即使有 `/compact` 命令也存在 PTL 自愈能力弱、cache 失效、回放错位等问题。

### 1.2 范围(6 个子项目)

| 编号 | 子项目 | spec 内编号 | 依赖 | 工作量 |
|---|---|---|---|---|
| A | 自动压缩核心 | §4 | 无 | 3-5 天 |
| C | API microcompact | §5 | 无 | 0.5-1 天 |
| D | Reactive compact | §6 | A | 1-2 天 |
| E | `/compact` 命令 v2 | §7 | A | 1-2 天 |
| F | Transcript 回放支持 `compact_boundary` | §8 | E | 0.5-1 天 |
| G | Circuit breaker + tracking state | §9 | A | 1-2 天 |

> **明确不做**:OpenCC 上游的本地版 microcompact(`microCompact.ts` 的本地路径,清掉旧 tool_result 内容)。经 brainstorming 澄清,这是为了保持用户体验朴素(用户仍能在 transcript 中看到完整历史 tool_result)。子项目 B 已从本 spec 移除。

### 1.3 决策汇总(经 brainstorming 确认)

| 决策项 | 决定 |
|---|---|
| 降级策略 | OpenCC 风格 circuit breaker |
| 默认启用 | 默认开,`ZAI_DISABLE_AUTO_COMPACT=1` opt-out |
| 用户可见行为 | 顶部状态条 toast:"对话已压缩 / 节省 N 个 token",不阻塞 |
| 可观测性 | `~/.zai/logs/compact.jsonl` + `logEvent()` 模拟接口 |
| Microcompact 策略 | 仅接 API microcompact,**跳过本地版** |
| Reactive compact 范围 | PTL + media_size + max_tokens escalate 全套 |
| `/compact` v2 实现路径 | 在 `runtime/compactService.ts` 上原地扩展 |
| Transcript resume 策略 | 跳过 boundary 之前 + 保留链式压缩 |
| 实现路径 | zai 内部干净实现,**不依赖 `opencc-internals`** |

## 2. 架构

### 2.1 主循环接入点

```
runtime/queryLoop.ts(每轮 turn)
  │
  │ turn 进入
  │
  ├─① snipCompactIfNeeded(messages, opts)
  │     └─ 削掉最早的 N 条 user 消息(占 tokenCount ≥ 95% 时)
  │
  ├─② resolveForceReason({ messageCount, tokenCount, memoryPressureFlag })
  │     └─ 在 tracking state 设 forceReason(可选,绕过 token 阈值)
  │
  ├─③ autoCompactIfNeeded(messages, context, cacheSafeParams, querySource, tracking)
  │     ├─ resolveAutoCompactCircuitBreakerState 守卫
  │     ├─ shouldAutoCompact 检查 token / forceReason
  │     ├─ compactConversation(走 streaming + PTL retry)
  │     ├─ store.replace(sessionId, newMessages)
  │     ├─ runPostCompactCleanup(querySource)
  │     └─ yield 'runtime.compacted' event
  │
  └─ 状态条 toast: useAgentStore.applySystemEvent({ type: 'toast', text })

runtime/queryLoop.ts(streaming 期间 — 子项目 D)
  │
  ├─ for-await modelCaller(stream)
  │     └─ 累积 delta / tool_use / tool_result
  │           └─ if 收到 prompt_too_long / media_size / max_tokens 错误
  │                 └─ withhold(不 yield 给前端),流结束后进 reactive 路径
  │
  └─ 流结束
        └─ tryReactiveCompact(...) 三种错误场景分别处理
              └─ 失败后 yield 'runtime.error' 让用户看到
```

### 2.2 模块拆分与文件布局

新增 `packages/zai-agent-core/src/runtime/compact/` 子目录:

```
runtime/compact/
├── index.ts                  ── public exports,统一 facade
├── tracking.ts               ── AutoCompactTrackingState + circuit breaker (子项目 G)
├── context-window.ts         ── getEffectiveContextWindowSize + getAutoCompactThreshold
├── snip.ts                   ── snipCompactIfNeeded()(子项目 A)
├── force-reason.ts           ── resolveForceReason() (子项目 A)
├── autocompact.ts            ── autoCompactIfNeeded()(子项目 A)
├── conversation.ts           ── compactConversation() streaming + PTL retry(子项目 E)
├── prompt-cache-share.ts     ── isCompactionCacheSharingCompatible(子项目 E)
├── cleanup.ts                ── runPostCompactCleanup()(子项目 A 复用)
├── hooks.ts                  ── pre/post compact hook 接口(子项目 E)
├── ptl-retry.ts              ── truncateHeadForPTLRetry(子项目 E)
├── reactive.ts               ── tryReactiveCompact + handleWithheld(子项目 D)
├── api-microcompact.ts       ── getAPIContextManagement()(子项目 C)
├── log-event.ts              ── logEvent() 模拟(本地 JSONL)
└── types.ts                  ── 共享类型定义(CompactResult / RecompactionInfo / ...)
```

**设计原则**:
1. 每个文件 < 300 行,职责单一
2. `index.ts` 是唯一对外 API,内部模块不互相 import 多个
3. 跟 `transcript/`、`runtime/queryLoop.ts` 的边界通过 `types.ts` 类型契约,不共享可变状态

**修改的文件**:
- `runtime/queryLoop.ts` — 注入 3 道防线 + reactive compact hooks
- `runtime/compactService.ts` — 改为 shim,委托给 `runtime/compact/conversation.ts`(向后兼容)
- `zai/src/server/services/commands/builtin/compact.ts` — 改用 `runtime/compact/index.ts`
- `transcript/store.ts` — 新增 `replaceWithBoundary()` 链式压缩版本
- `transcript/types.ts` — 新增 `compact_boundary` 类型 + `compactMetadata.preservedSegment`
- `shared/events.ts` — 新增 `runtime.compacted` SSE event 类型
- `web/src/store/useAgentStore.ts` — 新增 `applyCompactionEvent` reducer
- `runtime/queryLoop.ts` resume 路径 — 调 `preprocessResume(messages)` 跳过 boundary 之前

### 2.3 边界与依赖约束

- `runtime/compact/` 不依赖 `opencc-internals/`(全部独立实现)
- `runtime/compact/` 不依赖 `react` / `antd`(纯 TS,服务端/客户端同构)
- `runtime/compact/` 不依赖 `runtime/compactService.ts`(后者作为 deprecated shim)
- `runtime/compact/` 可被 `runtime/queryLoop.ts`、`runtime/compactService.ts`(shim)、`zai/src/server/services/commands/builtin/compact.ts` import

## 3. 横切关注点

### 3.1 默认启用

zai-server 启动后默认开启自动压缩。环境变量 opt-out:

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `ZAI_DISABLE_AUTO_COMPACT` | `0` | 设为 `1` 禁用自动压缩,manual `/compact` 仍可用 |
| `ZAI_DISABLE_COMPACT` | `0` | 设为 `1` 禁用所有压缩(包括 manual) |
| `ZAI_AUTOCOMPACT_PCT_OVERRIDE` | (unset) | 0-100,覆盖 token 阈值百分比,用于压测 |
| `ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS` | `300000`(5min) | ≥ 10000,circuit breaker cooldown |
| `ZAI_MAX_ACTIVE_MESSAGES` | `200` | forceReason 触发的 message count 上限 |
| `ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT` | `75` | 大上下文模型不被强制压缩的安全百分比 |

### 3.2 用户可见行为

自动压缩成功后:
- SSE event: `runtime.compacted` `{ sessionId, trigger, preTokens, postTokens, savedCount, timestamp }`
- 前端: `useAgentStore.applyCompactionEvent` 处理 → 推一条 `system.toast` 到顶部状态条
- 文案:`对话已压缩 · 节省 N tokens`(不阻塞,可关闭)
- manual `/compact` 走原有 `kind: 'compacted'` SSE event(保持不变)

reactive compact 失败:
- SSE event: `runtime.error` `{ sessionId, toolUseId: undefined, message, source: 'reactive-compact' }`
- 前端: 现有红色 Card 渲染逻辑(不变)

### 3.3 可观测性

每次 compact 触发(无论成功失败)记录一条 JSONL 到 `~/.zai/logs/compact.jsonl`:

```json
{
  "ts": 1752921600000,
  "sessionId": "sess-xxx",
  "trigger": "auto" | "manual" | "reactive-ptl" | "reactive-media" | "reactive-max-tokens",
  "model": "MiniMax-M3",
  "preCompactTokens": 195000,
  "postCompactTokens": 52000,
  "savedTokens": 143000,
  "circuitBreakerState": "closed" | "half-open" | "open",
  "consecutiveFailures": 0,
  "durationMs": 4200,
  "error": null | "PROMPT_TOO_LONG"
}
```

同时提供 `logEvent(eventName, metadata)` 函数(在 `runtime/compact/log-event.ts`),写入 JSONL。未来接入 Statsig / OpenTelemetry 只需替换 `logEvent` 实现。

### 3.4 不变量

1. `store.replace()` 永远走 `proper-lockfile`,跟 `append` / `replaceWithBoundary` 互斥
2. `compact_boundary` 一旦写入,后续 `queryLoop` resume 永远跳过其前面所有 messages
3. `forceReason` 在 `autoCompactIfNeeded` 内一次性消费(consumed in place),不会跨轮累积
4. `circuit breaker state` 只活在 `tracking` 对象里,不会写到 transcript(避免冷启动时复活旧状态)
5. `preprocessResume` 永远不修改 messages 数组本身,只返回子集(原数组保持磁盘上的完整状态)

## 4. 子项目 A:自动压缩核心

**目标**:zai 主路径每轮 turn 前,自动执行 snip → forceReason → autocompact 三道防线。

### 4.1 数据流

```
runtime/queryLoop.ts(每轮 turn)
  │
  ├─ 读 transcript.messages ──→ store.read(sessionId)
  │
  ├─ snipCompactIfNeeded(messages, opts)
  │     ├─ tokenCount = tokenCountWithEstimation(messages)
  │     ├─ if tokenCount ≥ effective_window * 0.95 → groupMessagesByApiRound
  │     ├─ 削掉最早的 1 个 group,保证剩 ≥ 1 group
  │     └─ 返回 { messages, tokensFreed, boundaryMessage?: SnipBoundaryMessage }
  │
  ├─ resolveForceReason({ messageCount, tokenCount, memoryPressureFlag })
  │     ├─ if memoryPressureFlag → 'memory-pressure'
  │     ├─ elif messageCount ≥ ZAI_MAX_ACTIVE_MESSAGES → 'message-count'
  │     ├─ elif tokenCount/threshold * 100 ≥ ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT → above
  │     └─ else → undefined
  │
  └─ autoCompactIfNeeded(messages, context, cacheSafeParams, querySource, tracking)
        ├─ 详见 §4.2
        └─ if wasCompacted → yield 'runtime.compacted' + 状态条 toast
```

### 4.2 `autoCompactIfNeeded` 主逻辑

```ts
// runtime/compact/autocompompact.ts (伪代码,非最终)
export async function autoCompactIfNeeded(
  messages, toolUseContext, cacheSafeParams, querySource, tracking, snipTokensFreed,
) {
  const model = toolUseContext.options.mainLoopModel
  const forcedBy = tracking?.forceReason
  if (tracking?.forceReason) tracking.forceReason = undefined
  if (!forcedBy && process.env.ZAI_DISABLE_AUTO_COMPACT === '1') return { wasCompacted: false }

  const should = await shouldAutoCompact(messages, model, querySource, snipTokensFreed, forcedBy)
  if (!should) return { wasCompacted: false }

  const cooldownMs = getAutoCompactFailureCooldownMs()
  const breaker = resolveAutoCompactCircuitBreakerState({ tracking, nowMs: Date.now(), cooldownMs })
  if (breaker.action === 'skip') return { wasCompacted: false, circuitBreakerActive: true }

  try {
    const result = await compactConversation(messages, context, cacheSafeParams, true, undefined, true)
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    logEvent('z auto_compact_succeeded', { ... })
    return { wasCompacted: true, compactionResult: result, consecutiveFailures: 0 }
  } catch (error) {
    return handleAutoCompactError(error, breaker, cooldownMs)
  }
}
```

### 4.3 `shouldAutoCompact` 判定

```ts
// runtime/compact/autocompompact.ts (伪代码)
export async function shouldAutoCompact(messages, model, querySource, snipTokensFreed, forceReason) {
  if (querySource === 'compact' || querySource === 'session_memory') return false
  if (!forceReason && !isAutoCompactEnabled()) return false
  if (forceReason) {
    logForDebugging(`auto-compact: forced by ${forceReason}`)
    return true
  }
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  return tokenCount >= threshold
}
```

### 4.4 关键函数签名

```ts
// runtime/compact/snip.ts
export type SnipResult = {
  messages: Message[]
  tokensFreed: number
  boundaryMessage?: SnipBoundaryMessage  // 仅在削过头时插入
}
export function snipCompactIfNeeded(messages: Message[], opts: { model: string }): SnipResult

// runtime/compact/force-reason.ts
export type ForceReason = 'memory-pressure' | 'message-count'
export function resolveForceReason(args: {
  messageCount: number
  tokenCount: number
  memoryPressureFlag: boolean
  maxActiveMessages: number
  naturalThreshold: number
  floorPct: number
}): ForceReason | undefined
```

### 4.5 与 OpenCC 的差异

| 差异 | 说明 |
|---|---|
| 无 `partitionContext` + `pruneByRelevance` | OpenCC 的"超阈值时按相关性裁剪"在 zai 暂不需要 — zai 直接走 compactConversation |
| 无 `trySessionMemoryCompaction` | OpenCC 实验分支,依赖 `~/.claude/memories/`,zai 不引入 |
| 无 ContextCollapse 模式互斥 | OpenCC 的 `CONTEXT_COLLAPSE` feature flag 是替代品,zai 不接入 |

## 5. 子项目 C:API microcompact

**目标**:zai ModelCaller 在每次请求时,把 `context_management.edits` 字段塞进 messages params,让 Anthropic 服务端帮忙清掉旧 tool_result / thinking。

### 5.1 数据流

```
runtime/queryLoop.ts 调 modelCaller(request)
  │
  └─ streamAdapter.wrapWithZaiMeta(request)
        │
        └─ getAPIContextManagement({
              hasThinking: messages 中存在 thinking block,
              isRedactThinkingActive: false,  // zai 暂未实现 thinking 脱敏
              clearAllThinking: false,
            })
              ├─ if !hasThinking → return undefined
              └─ else → return { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }
        │
        └─ request.context_management = edits   ← 注入到 Anthropic API request body
```

### 5.2 配置策略

- **thinking clear**:`hasThinking` 时启用,清掉旧 thinking 块(保留最近 1 轮)
- **tool clear**:zai 不启用(`process.env.USER_TYPE !== 'ant'` 默认为 false,需显式 `ZAI_USE_API_CLEAR_TOOL_RESULTS=1`)
- 阈值默认 180k input tokens,目标降到 40k(由 `ZAI_API_MAX_INPUT_TOKENS` / `ZAI_API_TARGET_INPUT_TOKENS` 覆盖)

### 5.3 关键函数

```ts
// runtime/compact/api-microcompact.ts
export type ContextEditStrategy =
  | { type: 'clear_tool_uses_20250919'; trigger?: ...; keep?: ...; clear_tool_inputs?: ...; exclude_tools?: ...; clear_at_least?: ... }
  | { type: 'clear_thinking_20251015'; keep: { type: 'thinking_turns'; value: number } | 'all' }

export function getAPIContextManagement(opts?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}): { edits: ContextEditStrategy[] } | undefined
```

### 5.4 接入点

`streamAdapter.wrapWithZaiMeta` 是 zai ModelCaller 的 wrapper,在每次 Anthropic API request 前注入 `context_management`。该函数原本只加 `zai_meta` 字段(见 §3.2 of AGENTS.md),现增加:

```ts
// runtime/streamAdapter.ts(增量)
export function wrapWithZaiMeta(request: CreateMessageParams, opts: WrapOptions): CreateMessageParams {
  const cm = getAPIContextManagement({ hasThinking: detectThinking(opts.messages) })
  return {
    ...request,
    context_management: cm?.edits,
    zai_meta: { ... },
  }
}
```

## 6. 子项目 D:Reactive compact

**目标**:当 API 返 413(prompt_too_long) / media_size 错误 / max_tokens 受限,自动 withhold + retry,不再让任务挂掉。

### 6.1 数据流

```
runtime/queryLoop.ts(streaming)
  │
  ├─ for-await modelCaller(stream)
  │     ├─ 累积 delta / tool_use / tool_result
  │     │
  │     ├─ if delta.event.type === 'error' && isWithheldPromptTooLong(error)
  │     │     ├─ withhold = true
  │     │     └─ 继续累积后续 events
  │     │
  │     └─ if delta.event.type === 'message_stop'
  │           └─ lastMessage = 累积的最后一条 assistant message
  │
  ├─ 流结束
  │     │
  │     ├─ if lastMessage.isApiErrorMessage && isWithheldPromptTooLong(lastMessage)
  │     │     └─ tryReactiveCompact({ trigger: 'ptl', ... })
  │     │           ├─ truncateHeadForPTLRetry(messages, lastMessage)
  │     │           ├─ 削头直到 tokenGap 覆盖
  │     │           ├─ if 削不够 → return null → yield 'runtime.error'
  │     │           ├─ store.replace(sessionId, truncated)
  │     │           ├─ 重试 modelCaller(stream)
  │     │           └─ hasAttempted = true
  │     │
  │     ├─ elif isWithheldMediaSizeError(lastMessage)
  │     │     └─ tryReactiveCompact({ trigger: 'media-size', ... })
  │     │           └─ stripImagesFromMessages + retry
  │     │
  │     └─ elif isWithheldMaxOutputTokens(lastMessage)
  │           └─ maxOutputTokensOverride = 64000 + retry
  │
  └─ if 全部 retry 失败 → yield 'runtime.error'
```

### 6.2 关键函数

```ts
// runtime/compact/reactive.ts
export type ReactiveTrigger = 'ptl' | 'media-size' | 'max-tokens'

export async function tryReactiveCompact(args: {
  trigger: ReactiveTrigger
  hasAttempted: boolean
  querySource: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
  lastError: AssistantMessage
}): Promise<{ messages: Message[]; retryCount: number } | null>

export function isWithheldPromptTooLong(msg: Message | undefined): msg is AssistantMessage
export function isWithheldMediaSizeError(msg: Message | undefined): msg is AssistantMessage
export function isWithheldMaxOutputTokens(msg: Message | undefined): msg is AssistantMessage
```

### 6.3 retry 上限

| Trigger | retry 上限 | 超限行为 |
|---|---|---|
| `ptl` | 3 次(truncateHeadForPTLRetry 内部) | yield `runtime.error` |
| `media-size` | 1 次(strip 后) | yield `runtime.error` |
| `max-tokens` | 1 次(8k → 64k escalate) | yield `runtime.error`, toast:"输出受限" |

每种 trigger 都有 `hasAttempted` 状态位,防止死循环。

## 7. 子项目 E:`/compact` 命令 v2

**目标**:在 `runtime/compactService.ts` 上原地扩展,加入 streaming 摘要 + PTL 自愈 + pre/post hook + cache 复用。

### 7.1 数据流

```
POST /api/command { name: 'compact', args: '', sessionId }
  │
  └─ routes/command.ts → cmd.call(args, context)
       │
       └─ compactCommand.call(args, context)
             ├─ sessionId = context.sessionId ?? getCurrentSessionId()
             ├─ existing = await store.read(sessionId)
             ├─ if existing.messages.length < 2 → return { kind: 'error' }
             │
             ├─ runtime = getRuntime()
             ├─ modelCaller = runtime.config.modelCaller
             │
             ├─ compactSession({ store, sessionId, modelCaller, cwd, model })
             │     │
             │     ├─ executePreCompactHooks({ trigger: 'manual' }, signal)
             │     ├─ compactConversation(messages, ..., suppressFollowUp: false)
             │     │     ├─ stripImagesFromMessages
             │     │     ├─ streamCompactSummary(messages, summaryRequest, cacheSafeParams)
             │     │     │     └─ for-await modelCaller → 累积 text,遇 message_stop break
             │     │     ├─ if PTL 错误 → for i = 1..3: truncateHeadForPTLRetry → 重试
             │     │     └─ return CompactionResult
             │     ├─ executePostCompactHooks({ trigger: 'manual' }, signal)
             │     └─ return CompactSessionResult { kind: 'compacted', summary, newMessages }
             │
             ├─ store.replace(sessionId, newMessages)
             └─ return { kind: 'compacted', removedMessages, summary }
```

### 7.2 `compactConversation` 关键签名

```ts
// runtime/compact/conversation.ts
export type CompactionResult = {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  compactionUsage?: TokenUsage
}

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
): Promise<CompactionResult>
```

### 7.3 PTL 自愈

```ts
// runtime/compact/ptl-retry.ts
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null
```

- 调用 API 摘要本身可能 prompt_too_long(典型场景: 用户传了大量图片附件)
- `truncateHeadForPTLRetry` 按 `getPromptTooLongTokenGap(ptlResponse)` 计算 token gap,削掉最早的 API-round group
- 最多 3 次重试,失败抛 `ERROR_MESSAGE_PROMPT_TOO_LONG`

### 7.4 Prompt cache 复用

```ts
// runtime/compact/prompt-cache-share.ts
export function isCompactionCacheSharingCompatible(model: string | undefined): boolean {
  // zai 默认走 Anthropic 协议,所以 isAnthropicProvider() 等价于 provider.kind === 'anthropic'
  return isAnthropicProvider()
}
```

- 走 cache sharing 时,compactConversation 用 `runForkedAgent` 路径,带 `CacheSafeParams`
- 非 Anthropic provider 强制走 cold cache path,不发 `betas` / `context_management` 字段

### 7.5 Hook 接口

```ts
// runtime/compact/hooks.ts
export type PreCompactHookInput = {
  trigger: 'auto' | 'manual'
  customInstructions: string | null
}
export type PostCompactHookInput = {
  trigger: 'auto' | 'manual'
  summary: string
  messagesToKeep: Message[]
}

export async function executePreCompactHooks(
  input: PreCompactHookInput,
  signal: AbortSignal,
): Promise<{ newCustomInstructions?: string; userDisplayMessage?: string }>

export async function executePostCompactHooks(
  input: PostCompactHookInput,
  signal: AbortSignal,
): Promise<HookResultMessage[]>
```

- zai 暂未实现 user-defined hooks,这两个函数在 zai 里是 no-op(直接 return `{}`)
- 接口保留为后续接入 zai 自有 hook 系统(zai-plugin / zai-skill)留位

### 7.6 `compactService.ts` 兼容性

现有 `runtime/compactService.ts`(7 KB, 196 行)改为 shim:

```ts
// runtime/compactService.ts(新)
export { compactConversation as _internal } from './compact/conversation.js'

export async function compactSession(opts: CompactSessionOptions): Promise<CompactSessionResult> {
  // 适配老接口:读 + summarize + 写盘,但内部走 compactConversation
  const file = await opts.store.read(opts.sessionId)
  if (file.messages.length < 2) return { kind: 'error', message: '...' }
  const result = await _internal(file.messages, ...)
  const newMessages = buildPostCompactMessages(result)
  await opts.store.replace(opts.sessionId, newMessages)
  return { kind: 'compacted', summary: extractSummary(result), newMessages }
}
```

保证旧 `compactService.test.ts` 继续通过。

## 8. 子项目 F:Transcript 回放支持 `compact_boundary`

**目标**:zai session resume 时,跳过 `compact_boundary` 之前的 messages,避免重复喂摘要 + 原始历史。

### 8.1 transcript schema 变更

`TranscriptMessage` 增加 `compactMetadata`(可选):

```ts
// transcript/types.ts(增量)
export type CompactMetadata = {
  trigger: 'auto' | 'manual'
  preTokens: number
  userContext?: string
  messagesSummarized: number
  preservedSegment?: {
    headUuid: UUID   // messagesToKeep[0].uuid
    anchorUuid: UUID // boundary 前一条 message 的 uuid(摘要锚点)
    tailUuid: UUID   // messagesToKeep.at(-1).uuid
  }
}

export type CompactBoundaryMessage = TranscriptMessage & {
  type: 'compact_boundary'
  message: {
    content: [{ type: 'text'; text: '对话从这之后被压缩为摘要。详细历史已归档。' }]
    role: 'system'
  }
  compactMetadata: CompactMetadata
}
```

### 8.2 resume 流程

```
runtime/queryLoop.ts(session resume)
  │
  └─ store.read(sessionId) → TranscriptFile { messages, meta }
       │
       └─ preprocessResume(messages)
             │
             ├─ 扫描 messages,识别所有 type === 'compact_boundary' 的点
             │
             ├─ 维护 Map<boundaryUuid, CompactMetadata>
             │     └─ 按 messages 中的 uuid 顺序排序
             │
             ├─ 链式压缩重建:
             │     ├─ latest_boundary = 最后一个 boundary
             │     ├─ effective_messages = [
             │     │     boundary,
             │     │     summary_message,
             │     │     ...messagesAfterLatestBoundary,
             │     │   ]
             │     └─ 重新挂父子关系: messagesAfter[i].parentUuid = messagesAfter[i-1].uuid
             │
             └─ return effective_messages
  │
  └─ queryLoop 续跑(只看到 boundary 之后的内容,不重复喂 summary)
```

### 8.3 `store.replaceWithBoundary`

```ts
// transcript/store.ts(增量)
export async function replaceWithBoundary(
  transcriptId: string,
  newMessages: Message[],
  boundaryMetadata: CompactMetadata,
): Promise<void>
```

- 沿用 `replace()` 的 proper-lockfile 模式
- 接受 boundary message + summary messages + messagesToKeep
- 在 boundary 上挂 `compactMetadata`,包括 `preservedSegment` 信息

### 8.4 错误兜底

| 错误场景 | 兜底 |
|---|---|
| boundary 元数据损坏 | 退化为只跳过 boundary 之前的 messages,不做链式重链 |
| 多个 boundary chain 顺序错乱 | 找 `parentUuid` 最新的 boundary,只跳其前 |
| 没有任何 boundary 但 messages > 100k | 不主动压缩,只在 yield `runtime.warning` 提示用户 |
| `preprocessResume` 异常 | 用原始 messages 续跑 + yield warning event |

## 9. 子项目 G:Circuit breaker + tracking state

**目标**:OpenCC 风格的失败熔断,防止"1279 session × 50+ 次失败 × 250K API/天"的事故。

### 9.1 `AutoCompactTrackingState`

```ts
// runtime/compact/tracking.ts
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number   // 连续 5xx/529 失败次数
  nextRetryAtMs?: number         // 下次允许试的时间戳
  lastFailureAtMs?: number       // 上次失败时间戳
  forceReason?: 'memory-pressure' | 'message-count'
}
```

`tracking` 是 process-local 状态,**不写到 transcript**(避免冷启动时复活旧 state)。由 `queryLoop` 在每轮 turn 间 thread。

### 9.2 状态机

```
         consecutiveFailures < 3
   ┌────────────────────────────────────────┐
   │                                         │
   │                                         ▼
[closed]                          (allow, normal path)
   ▲                                         │
   │                                         │
   │  success                                │  5xx/529
   │  consecutiveFailures = 0                │  consecutiveFailures++
   │                                         ▼
   │                                     (check >= 3?)
   │                                         │
   │                                         │  no
   │                                         └──→ [closed]
   │
   │  half-open 成功
   │  consecutiveFailures = 0
   │                                         │
   ◀─────────────────────────────────────────┘
                                            │
                                            │  yes (≥ 3)
                                            ▼
                                       [open]
                                       nextRetryAtMs = lastFailureAtMs + cooldownMs
                                            │
                                            │  now < nextRetryAtMs → skip
                                            │  now ≥ nextRetryAtMs → allow (half-open)
                                            ▼
                                       (try once)
                                            │
                                            │  失败 → 立即 trip
                                            │  成功 → [closed]
```

### 9.3 关键函数

```ts
// runtime/compact/tracking.ts
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
export const AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
export const MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000

export function getAutoCompactFailureCooldownMs(): number
export function resolveAutoCompactCircuitBreakerState(args: {
  tracking?: Pick<AutoCompactTrackingState, 'consecutiveFailures' | 'nextRetryAtMs' | 'lastFailureAtMs'>
  nowMs: number
  cooldownMs: number
}): { action: 'allow'; effectiveConsecutiveFailures: number; wasHalfOpen: boolean }
 | { action: 'skip'; consecutiveFailures: number; nextRetryAtMs: number; circuitBreakerActive: true }
```

### 9.4 失败计数规则

- **5xx / 529**:递增 `consecutiveFailures`(5xx 用 5min cooldown,529 用同样 cooldown)
- **4xx 请求错误**:**不递增**(用户输入问题,不算 LLM 故障)
- **网络错误 / timeout**:**递增**(同 5xx)
- **API 主动返 413(PTL)**:在 reactive compact 路径递增(单独计数器 `reactiveFailures`,不污染 autocompact 计数器)
- **摘要本身被 PTL**:走 truncateHeadForPTLRetry 重试,3 次都失败才算失败

## 10. 错误处理总表

### 10.1 自动压缩本身的错误

| 错误类型 | 检测点 | 兜底策略 | 用户可见性 |
|---|---|---|---|
| 摘要 LLM 4xx | `compactConversation` catch | 不递增 CB,记 debug 日志 | 不提示 |
| 摘要 LLM 5xx / 529 | 同上 | CB `consecutiveFailures++`,< 3 让 queryLoop 重试,≥ 3 trip cooldown | toast:"对话压缩暂时跳过" |
| 摘要 PTL 3 次失败 | 抛 `ERROR_MESSAGE_PROMPT_TOO_LONG` | CB trip,记录 `lastFailureAtMs`,yield `runtime.error` | toast:"自动压缩失败,对话可能过长" |
| `store.replace` IO 失败 | catch in `autoCompactIfNeeded` | 不写盘,CB trip | toast:"压缩后保存失败" |
| pre/post hook 超时 | hook wrapper try/catch | 跳过当前 hook,继续压缩 | 不提示 |

### 10.2 Reactive compact 的错误

| 错误类型 | 兜底 | 用户可见性 |
|---|---|---|
| PTL 削头削到 < 1 group | 让 `runtime.error` 上浮 | 红色 Card |
| PTL retry 3 次仍 413 | 同上 | 同上 |
| media_size 削了图仍 413 | 同上 | 同上 |
| max_tokens escalate 后仍 cap | yield `runtime.error`,要求 manual | toast:"输出受限,请手动压缩" |

### 10.3 Manual `/compact` 的错误

| 错误类型 | 兜底 |
|---|---|
| messages.length < 2 | `kind: 'error'`,message 告知 |
| modelCaller 未配置 | `kind: 'error'`,message 告知 |
| compactConversation PTL 失败 | `kind: 'error'`,message 告知"摘要生成失败" |
| store.replace 失败 | `kind: 'error'`,message 告知 |
| LLM 摘要返回空 / 未收到 message_stop | `kind: 'error'`,message 告知"响应不完整" |

### 10.4 Transcript 回放错误

| 错误类型 | 兜底 |
|---|---|
| boundary 元数据损坏 | 退化为只跳过 boundary 前 messages |
| 多个 boundary 链顺序错乱 | 找最新 boundary,只跳其前 |
| 没 boundary 但 messages > 100k | yield `runtime.warning`,不主动压缩 |
| preprocessResume 异常 | 用原始 messages 续跑 + yield warning event |

## 11. 测试策略

### 11.1 Unit tests(per module)

```
test/runtime/compact/
├── tracking.test.ts                 ── resolveAutoCompactCircuitBreakerState 状态机
│                                        (half-open / closed / open 三态转换)
├── context-window.test.ts           ── getEffectiveContextWindowSize buffer 边界
│                                        (issue #635 重现:阈值负数)
├── snip.test.ts                     ── snipCompactIfNeeded 削头逻辑
│                                        (边界: < 1 group / 空 messages)
├── force-reason.test.ts             ── resolveForceReason 优先级
│                                        (memory-pressure > message-count)
├── autocompact.test.ts              ── autoCompactIfNeeded 主路径 + 失败注入
├── conversation.test.ts             ── compactConversation streaming + PTL 重试
├── ptl-retry.test.ts                ── truncateHeadForPTLRetry token gap 计算
├── prompt-cache-share.test.ts       ── isCompactionCacheSharingCompatible provider 矩阵
├── cleanup.test.ts                  ── runPostCompactCleanup 调用顺序
├── hooks.test.ts                    ── pre/post hook 超时与失败注入
├── reactive.test.ts                 ── tryReactiveCompact 三种错误场景
├── api-microcompact.test.ts         ── getAPIContextManagement 输出
└── log-event.test.ts                ── logEvent 写入 JSONL 格式校验
```

### 11.2 Transcript resume 测试

```
test/transcript/
└── resume-with-boundary.test.ts     ── preprocessResume 各种 boundary 组合
                                          (单 boundary / 链式 / 损坏 metadata)
```

### 11.3 集成 / e2e

```
test/integration/agent/
├── auto-compact-turn-loop.test.ts   ── 模拟 200k 上下文 + 多次 turn,
│                                        断言 queryLoop 自动触发 compact
├── reactive-ptl-retry.test.ts       ── 注入 mock modelCaller 返 413,
│                                        断言 reactive compact retry 链
├── compact-command-v2.test.ts       ── /compact 全路径: pre hook → 摘要 → 落盘
│                                        → post hook → UI 显示 compacted
└── circuit-breaker-trip.test.ts     ── 注入连续 5xx, 断言 trip + cooldown + half-open
```

### 11.4 关键 fixture

- **mock modelCaller**:返回受控的 streaming 事件序列,可注入 5xx / 413 / 429 / message_stop 缺失 / 空 summary 等异常
- **mock transcript fixture**:预置 1k / 10k / 100k token 的 messages,含图片 / 工具结果 / thinking 块
- **in-memory TranscriptStore**:用 `os.tmpdir()` 隔离,确保 test 之间不污染
- **clock injection**:`autoCompactIfNeeded` 接受 `nowMs: number` 参数,避免真实 sleep

### 11.5 回归测试锚点

- 现有 `packages/zai-agent-core/test/runtime/compactService.test.ts`(原 /compact 简化版)必须继续通过,直到 `compactService` 被新 `compactConversation` 替换
- 现有 `packages/zai/test/server/agent.test.ts` 的 prompt/agent 流程测试必须不受影响
- 现有 transcript v2 落盘测试(`persistence.test.ts`、`store.test.ts`)必须继续通过

### 11.6 覆盖率目标

| 模块 | line | branch |
|---|---|---|
| tracking (circuit breaker) | ≥ 95% | ≥ 90% |
| autocompact | ≥ 90% | ≥ 85% |
| conversation (含 PTL retry) | ≥ 90% | ≥ 85% |
| reactive | ≥ 85% | ≥ 80% |
| resume-with-boundary | ≥ 85% | ≥ 80% |
| 其余模块 | ≥ 80% | ≥ 75% |

### 11.7 性能 / 非功能验证

不写正式 benchmark,但用 e2e fixture 验证关键不变量:
- snip 后 messages 数组不重复
- compact 后 `message.usage.input_tokens` 单调下降
- resume 后 boundary 前的 messages 不出现在 queryLoop 的输入里
- 5xx 风暴 3 次后,cooldown 期间不再触发 compactConversation(只应增加 consecutiveFailures 计数)

## 12. 实施计划(roadmap)

按依赖关系分 4 个阶段,每阶段单独写 plan:

### 阶段 1 — 自动压缩核心(A + G,3-5 天)

目标:`runtime/queryLoop.ts` 主循环里跑通 snip → forceReason → autocompact + circuit breaker,缺 reactive compact 和 transcript resume。

交付:
- `runtime/compact/` 14 个文件全部建好
- `runtime/queryLoop.ts` turn loop 注入 3 道防线
- `runtime/compactService.ts` 改为 shim
- `shared/events.ts` 新增 `runtime.compacted`
- `web/src/store/useAgentStore.ts` 处理 `runtime.compacted` → toast
- 单测覆盖率达标
- integration test 1 个(自动压缩触发链)

### 阶段 2 — `/compact` v2(E,1-2 天)

目标:`/compact` 手动命令升级到完整版(streaming + PTL 自愈 + cache 复用 + hook)。

交付:
- `compactSession` shim 内部走 `compactConversation`
- `truncateHeadForPTLRetry` 完整实现
- `isCompactionCacheSharingCompatible` + provider 矩阵
- `executePreCompactHooks` / `executePostCompactHooks` no-op 实现
- integration test 1 个(PTL 自愈链)

### 阶段 3 — Transcript 回放(F,0.5-1 天)

目标:`compact_boundary` 链式压缩 + resume 跳过。

交付:
- `TranscriptMessage.compactMetadata` schema
- `store.replaceWithBoundary` 新方法
- `preprocessResume` 函数
- `queryLoop.ts` resume 路径接入
- 单测 1 个(链式压缩)

### 阶段 4 — Reactive compact + API microcompact(D + C,2-3 天)

目标:`prompt_too_long` / `media_size` / `max_tokens` 自动 retry + `context_management.edits` 接入。

交付:
- `tryReactiveCompact` + 三种 trigger 检测
- `queryLoop.ts` streaming 路径 withhold + retry
- `getAPIContextManagement` 实现 + `streamAdapter.wrapWithZaiMeta` 注入
- integration test 1 个(reactive retry 链)
- 阶段 4 完成 → zai 主路径"完整追平 OpenCC"

## 13. 验收标准

### 13.1 功能验收

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| F1 | 200k 上下文 + 多次 turn 自动压缩 | integration test |
| F2 | 摘要 LLM 失败不阻断主对话 | unit test + integration test |
| F3 | 5xx 连续 3 次触发 cooldown,half-open 复测 | unit test |
| F4 | API 返 413 自动 retry,3 次仍失败 yield error | integration test |
| F5 | media_size 错误自动脱附件重试 | integration test |
| F6 | max_tokens 受限自动 escalate 重试 | unit test |
| F7 | `/compact` 摘要失败 PTL 自愈 | integration test |
| F8 | `/compact` cache 复用(Anthropic provider) | unit test(provider 矩阵) |
| F9 | Session resume 跳过 boundary 之前 messages | unit test |
| F10 | 链式压缩(boundary → boundary)正确 | unit test |
| F11 | API microcompact 注入 `context_management.edits` | unit test(streamAdapter mock) |
| F12 | `ZAI_DISABLE_AUTO_COMPACT=1` 静默 | unit test(env) |

### 13.2 性能 / 可观测性验收

| 编号 | 验收项 | 验证方式 |
|---|---|---|
| P1 | compact 后 `message.usage.input_tokens` 单调下降 | e2e fixture |
| P2 | circuit breaker trip 后 5min cooldown 内不触发摘要 | unit test(time mock) |
| P3 | `~/.zai/logs/compact.jsonl` 写入格式正确 | unit test(读文件断言) |

### 13.3 回归验收

- 现有 `compactService.test.ts`、`agent.test.ts`、`persistence.test.ts`、`store.test.ts` 全部通过
- 现有 transcript v2 落盘格式不变(只新增 `compactMetadata` 字段)
- 现有 `/api/command` 路由契约不变(`/compact` 返回结构不变)

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `preprocessResume` 改动 transcript resume 逻辑,可能回归 2013(tool_use_id 错位) | 高 | 现有 transcript v2 resume 测试必须保留 + 覆盖链式压缩场景 |
| `context_management.edits` 字段在 OpenAI-compatible provider 报错 | 中 | `isAnthropicProvider()` 守门,非 Anthropic provider 不发该字段 |
| circuit breaker state 不写盘,进程重启后状态丢失 | 低 | 接受(进程重启后从 cold start 重新计数,符合预期) |
| LLM 摘要调用本身消耗大量 token(被压 200k 但摘要要再发 200k) | 中 | 阶段 2 用 cache 复用解决(cache 命中 99% token),阶段 1 暂接受 |
| PTL 自愈 3 次后用户感知:对话太长无法恢复 | 低 | toast 明确告知,引导用户手动 /compact |
| Hook 接口预留但未实现,用户期望落差 | 低 | spec 文档明确"zai 暂未实现 user-defined hooks,接口保留为后续接入" |

## 15. 附录

### 15.1 与 OpenCC 上游的具体差异

| 维度 | OpenCC | zai(本 spec) | 原因 |
|---|---|---|---|
| 本地版 microcompact | ✅ | ❌ 不接 | brainstorming 决定 |
| Session memory 压缩分支 | ✅ | ❌ 不接 | 依赖 `~/.claude/memories/`,zai 不引入 |
| ContextCollapse 模式 | ✅ | ❌ 不接 | OpenCC 替代品,互斥,不引入 |
| KAIROS sessionTranscript | ✅ | ❌ 不接 | OpenCC experimental,跳过 |
| partitionContext + pruneByRelevance | ✅ | ❌ 不接 | zai 直接走 compactConversation |
| prompt cache break detection | ✅ | ❌ 简化 | zai 暂不实现 Statsig 集成,仅 logEvent |

### 15.2 文件改动清单

**新建**:
- `packages/zai-agent-core/src/runtime/compact/{index,tracking,context-window,snip,force-reason,autocompact,conversation,prompt-cache-share,cleanup,hooks,ptl-retry,reactive,api-microcompact,log-event,types}.ts`(15 个文件)
- `test/runtime/compact/{tracking,context-window,snip,force-reason,autocompact,conversation,ptl-retry,prompt-cache-share,cleanup,hooks,reactive,api-microcompact,log-event}.test.ts`(13 个测试)
- `test/transcript/resume-with-boundary.test.ts`(1 个测试)
- `test/integration/agent/{auto-compact-turn-loop,reactive-ptl-retry,compact-command-v2,circuit-breaker-trip}.test.ts`(4 个测试)

**修改**:
- `packages/zai-agent-core/src/runtime/queryLoop.ts`(主循环注入 3 道防线 + reactive compact hooks)
- `packages/zai-agent-core/src/runtime/compactService.ts`(改为 shim)
- `packages/zai-agent-core/src/runtime/streamAdapter.ts`(注入 `context_management`)
- `packages/zai-agent-core/src/runtime/types.ts`(添加 CompactResult 类型)
- `packages/zai-agent-core/src/transcript/store.ts`(新增 `replaceWithBoundary`)
- `packages/zai-agent-core/src/transcript/types.ts`(新增 `compactMetadata`)
- `packages/zai-agent-core/src/shared/events.ts`(新增 `runtime.compacted`)
- `packages/zai/src/server/services/commands/builtin/compact.ts`(改用 `runtime/compact/index.ts`)
- `packages/zai/src/web/src/store/useAgentStore.ts`(新增 `applyCompactionEvent`)

**总计**:15 个新文件 + 18 个测试文件 + 9 个修改文件。

### 15.3 OpenCC 上游参考

设计文档参照 OpenCC 源码:
- `opencc-internals/services/compact/autoCompact.ts` — 子项目 A + G 主参考
- `opencc-internals/services/compact/compact.ts` — 子项目 E 主参考(67 KB)
- `opencc-internals/services/compact/microCompact.ts` — 子项目 C 部分参考(仅 API 部分)
- `opencc-internals/services/compact/apiMicrocompact.ts` — 子项目 C 完整参考
- `opencc-internals/query.ts:740-925` — 主循环 hook 点位置参考

所有代码均为**zai 内部干净实现**,不直接 import opencc-internals。

