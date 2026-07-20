# A. 错误分类 + Max output tokens 自愈 + Tool 死循环防护

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-loop-resilience-a |
| 父 spec | [umbrella](./2026-07-19-zai-loop-resilience-master-design.md) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | 错误分类、max_output_tokens 自愈、tool 死循环防护、reactive compact stub |
| 工作量 | 3-5 天 |

## 0. 范围

| 在范围 | 不在范围 |
|---|---|
| 错误分类(classifyApiError) | A4(prompt_too_long → reactive compact 完整实现)— Stage 2 compaction 范围 |
| max_output_tokens 3 次重试 + cap 提升 | 完整 reactive path(本 spec 留 stub 占位,见 §3.6) |
| Tool 死循环防护 | Provider fallback chain(留接口,实现留待 Stage F2) |
| Reactive compact stub 接口 | 与 OpenCC `FallbackTriggeredError` 1:1 移植(只在 §3 中 duck-type 兼容,无完整框架) |

## 1. 背景与目标

zai 当前错误处理只有 `toRuntimeErrorEvent` / `toAbortedEvent`,任何异常立即转 `runtime.error` 直送前端。本 sub-spec 目标:

1. **错误分类**:把 API / 网络 / 工具错误归类为 `ErrorKind` 枚举,前端 toast 可读
2. **max_output_tokens 自愈**:遇 `max_output_tokens`,在同 turn 内重试 3 次,cap 提到 64k,失败后 yield `runtime.error` w/ `kind:'max_output_tokens'`
3. **Tool 死循环防护**:同 `tool_use_id` 连续抛 ≥ N 次,强制 break 当前 turn 并 yield `runtime.error` w/ `kind:'tool_failure_loop'`
4. **Reactive compact 接口预留**:暴露 `tryReactiveCompact`,Stage 1 不可用时返 `kind:'unimplemented'`

## 2. 公共契约(冻结)

### 2.1 函数签名

```ts
// runtime/errors/classification.ts
export type ErrorKind =
  | 'prompt_too_long'
  | 'max_output_tokens'
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'provider_max_tokens_cap'
  | 'tool_failure_loop'
  | 'hook_blocked'           // 由 C 集路径填入;本集不直接生成,但 union 保留兼容
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  providerErrorCode?: string | number;
}

export function classifyApiError(err: unknown): ClassifiedError;

// runtime/errors/maxOutputTokens.ts
export interface MaxTokensRecoveryOptions {
  modelCaller: ModelCaller;
  messages: AnthropicMessage[];
  maxAttempts?: number;                  // 默认 3
  capEscalation?: [number, number, number]; // 默认 [4096, 16384, 65536]
  signal: AbortSignal;
}

export async function* recoverMaxOutputTokens(
  opts: MaxTokensRecoveryOptions
): AsyncIterable<RuntimeEvent>;

// runtime/errors/loopGuard.ts
export interface LoopGuardState {
  consecutiveFailureByToolId: Map<string, number>;
  maxConsecutive?: number;  // 默认 3
}

export type LoopGuardDecision = 'continue' | 'break-and-error' | 'reset';

export function recordToolFailure(
  state: LoopGuardState,
  toolUseId: string
): LoopGuardDecision;

export function recordToolSuccess(
  state: LoopGuardState,
  toolUseId: string
): void;

// runtime/errors/reactiveCompact.ts  (本期 stub)
export interface ReactiveCompactResult {
  kind: 'attempted' | 'unimplemented' | 'failed';
  newMessages?: AnthropicMessage[];
  reason?: string;
}

export async function tryReactiveCompact(
  messages: AnthropicMessage[],
  modelCaller: ModelCaller,
  signal: AbortSignal
): Promise<ReactiveCompactResult>;
```

### 2.2 事件 / 字段 schema

`runtime.error` payload 增加 **`kind: ErrorKind`** 字段(zod 可选);`runtime.tool_call` 等其它事件不变。

```ts
// 新增可选字段(由 zod schema 加上,前端 useAgentStore 不需改)
runtime.error = {
  type: 'runtime.error',
  payload: {
    message: string;
    fatal: boolean;
    kind?: ErrorKind;       // 本集新增,缺省 'unknown'
    providerErrorCode?: string | number;
    toolUseId?: string;      // tool 错误时填
  }
}
```

### 2.3 配置键(从 umbrella §3.3 引用)

| Key | 类型 | 默认 |
|---|---|---|
| `config.runtime.maxOutputTokensRecoveryAttempts` | number | 3 |
| `config.runtime.toolFailureLoopMaxConsecutive` | number | 3 |

### 2.4 错误契约

- `classifyApiError(err)` **永不抛**;失败情况返 `kind:'unknown', retryable:true, message: 'unrecognized error'`
- `recoverMaxOutputTokens` 遇非 `max_output_tokens` 错误 → 立即抛(不重试),错误向上
- `recoverMaxOutputTokens` 第 3 次仍失败 → yield `runtime.error` w/ `kind:'max_output_tokens'`,**不再抛**
- `recordToolFailure` / `recordToolSuccess` **永不抛**,纯函数

### 2.5 接入点(hint;Agent 不直接修改 queryLoop.ts)

| 位置 | 调用 | 顺序 |
|---|---|---|
| queryLoop.ts for-await modelCaller catch 块 | `classifyApiError(err)` → result 转 RuntimeEvent | 1 |
| 同一 catch 块 if kind=='max_output_tokens' | `recoverMaxOutputTokens(opts)` 流式重试 | 2 |
| 同一 catch 块 if kind=='prompt_too_long' | `tryReactiveCompact(...)`,stub 返 unimplemented 时不阻塞,继续抛 `runtime.error` | 3 |
| executeToolsStreaming 串行循环中 | `recordToolFailure(state, toolUseId)`;decision=='break-and-error' → yield error | 4 |
| executeToolsStreaming 末尾 catch | 计数累计判断 recordToolSuccess | 5 |

> **集成 PR 阶段**:`< 50 行` write-in,Agent 不动 queryLoop.ts。

## 3. 行为列表(Agent 至少逐项实现 + 1 test)

1. `classifyApiError` 处理 `Anthropic.APIError`(status: 413/429/500/529/401/403),命中映射到 `kind`
2. `classifyApiError` 处理 axios / fetch 网络层错误(ECONNRESET、ETIMEDOUT)→ `kind:'unknown', retryable:true`
3. `classifyApiError` 处理 message 关键词命中(`'prompt_too_long'`、`'context length exceeded'`、`'rate limit'`)
4. `classifyApiError` 透传 `providerErrorCode`(Anthropic `error.type` 字段、proxy `code` 字段)
5. `classifyApiError` 输入为 unknown 类型时返 `{kind:'unknown', retryable:true, message:'unrecognized error'}`
6. `recoverMaxOutputTokens` 默认按 `[4096, 16384, 65536]` 升级
7. `recoverMaxOutputTokens` 第 N 次失败后立即发起下次第 N+1 次升级
8. `recoverMaxOutputTokens` 第 3 次仍失败 → yield `runtime.error` w/ `kind:'max_output_tokens'`
9. `recoverMaxOutputTokens` 遇非 `max_output_tokens` 错误立即抛
10. `recordToolFailure` 第一次失败 → `'continue'`
11. `recordToolFailure` 连续 N 次同 toolUseId → `'break-and-error'`
12. `recordToolSuccess` → `'reset'`(清零该 toolUseId 计数)
13. 不同 toolUseId 之间计数独立
14. `tryReactiveCompact` Stage 1 不存在 → 直接返 `kind:'unimplemented'`
15. `tryReactiveCompact` Stage 1 存在 → 调 `runtime/compact/conversation.ts` 的 `compactConversation` 并返 `attempted` + newMessages
16. `tryReactiveCompact` 调 compactConversation 抛错 → 返 `kind:'failed'`,**不抛**

## 4. 测试点(Agent 必写,1 file / case)

```
packages/zai-agent-core/test/integration/agent/resilience/a-error-classification.test.ts
  ✓ classifies Anthropic.APIError status 413 → kind:'prompt_too_long', retryable:false
  ✓ classifies Anthropic.APIError status 429 → kind:'rate_limit', retryable:true
  ✓ classifies Anthropic.APIError status 529 → kind:'rate_limit', retryable:true
  ✓ classifies Anthropic.APIError status 401 → kind:'auth', retryable:false
  ✓ classifies network error (ECONNRESET) → kind:'unknown', retryable:true
  ✓ classifies message containing 'prompt_too_long' literal → kind:'prompt_too_long'
  ✓ preserves provider error code in payload
  ✓ unknown error type → kind:'unknown', retryable:true, message:'unrecognized error'

packages/zai-agent-core/test/integration/agent/resilience/a-max-output-tokens-recovery.test.ts
  ✓ yields resumed stream on first recovery attempt with cap=4096
  ✓ escalates to 16384 on second failure
  ✓ escalates to 65536 on third failure
  ✓ yields runtime.error kind:'max_output_tokens' after 3 attempts exhausted
  ✓ propagates non-max_output_tokens error without retry

packages/zai-agent-core/test/integration/agent/resilience/a-tool-failure-loop-guard.test.ts
  ✓ first failure → 'continue'
  ✓ 3 consecutive failures on same toolUseId → 'break-and-error'
  ✓ success between failures → 'reset' (count back to 0)
  ✓ distinct toolUseIds don't interfere with each other

packages/zai-agent-core/test/integration/agent/resilience/a-reactive-compact-stub.test.ts
  ✓ tryReactiveCompact returns kind:'unimplemented' when Stage 1 absent (mock import)
  ✓ tryReactiveCompact returns kind:'attempted' + newMessages when Stage 1 present
  ✓ tryReactiveCompact returns kind:'failed' and does not throw when compactConversation throws
```

## 5. 验收门

1. `pnpm --filter @zn-ai/zai-agent-core typecheck`
2. `pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/a-*`
3. `pnpm --filter @zn-ai/zai-agent-core test`(全量)— auto-compact-turn-loop.test.ts 仍绿

## 6. 风险与边界场景

1. **Stage 1 不可用**:tryReactiveCompact 返 stub,前端 `runtime.error` w/ `kind:'prompt_too_long'` 给用户提示去做 /compact。
2. **SDK 字段名差异**:`Anthropic.APIError` 不同 SDK 版本用 `status` / `statusCode`,统一用 duck typing(`typeof err.status === 'number'`)或 `'status' in err ? err.status : err.statusCode`。
3. **错误流 vs 事件流并发**:`for-await` 中间 yield `RuntimeEvent` 与流结束后 catch 同时存在,集成 PR 决定 call site。
4. **同 turn 多次 max_output_tokens**:recoverMaxOutputTokens 一个 turn 内只调一次;turn 边界由 loop 控制。
5. **provider 透传**:`providerErrorCode` 不解析,只透传字符串 — 前端 toast 自己处理。

## 7. 不锁定(实现细节由 Agent 决定)

- 文件命名(`runtime/errors/classification.ts` 等为建议名,Agent 可选)
- class vs function 实现
- 测试用 stub / mock / fake 实现细节
- 错误码字符串映射细节(只要 export 类型签名一致)
- 是否引入新 util(如 `withheldErrors: ClassifiedError[]` 数组)— 自由
