# zai modelCaller 业务级 529/429/5xx 自动重试 — 设计文档

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-22-zai-modelcaller-529-retry |
| 作者 | Claude(经 brainstorming 流程) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | 在 `zai/src/server/services/modelCaller.ts` 之上包一层业务级重试,补齐 zai 主对话路径对瞬时 API 错误(529 / 429 / 5xx)的自动恢复能力 |
| 范围 | 单文件改动 + 1 个新 SSE 事件 + 2 个测试文件 |
| 工作量 | 2-3 天 |

## 1. 背景与目标

### 1.1 问题陈述

zai 主对话路径(`runtime/queryLoop.ts` → `zai/src/server/services/modelCaller.ts` → `@anthropic-ai/sdk`)在遇到 529 (`overloaded_error`)、429 限速、5xx 时,**没有自动重试**。当前错误路径:

```
client.messages.create() throws 529 (eventCount=0, SDK 内 maxRetries:2 已耗尽)
  ↓ modelCaller.ts:377 throw err
  ↓ queryLoop.ts:320 for-await 无外层 try/catch,异常向上冒泡
  ↓ routes/agent.ts:556 catch → emit runtime.error(recoverable:false)
  ↓ useAgentStore.applyRuntimeEvent:1328 setStatus('error') + 红色 Card
  ↓ turn 终止,用户需手动重发
```

对比:`zai-agent-core/src/runtime/background/DefaultBackgroundRuntime.ts:280-381` 已有完整的重试循环(while + `classifyRetryableError` + `getRetryDelay` + `retrySleep`),对齐 OpenCC `withRetry.ts` 的 3/10/500/32s 退避策略。**只有后台任务路径有保护,主对话路径裸奔。**

### 1.2 现状证据

- 日志 `[zai.modelCaller] ← error {"model":"MiniMax-M3","stage":"create","eventCount":0,...,"message":"...overloaded_error... (2064) (529)"}`(`modelCaller.ts:361`)
- `eventCount === 0` 表明 SDK 在 `messages.create()` HTTP 调用阶段就抛了,即使 SDK 客户端已经配 `maxRetries: 2`(`modelCaller.ts:153/185`),依然失败
- SDK 内置重试不响应 `AbortSignal`,用户取消也无法中断

### 1.3 目标

1. zai 主对话路径在 SDK create 阶段抛出 529/429/5xx 时,自动退避重试(对齐 BackgroundRuntime 语义:529 连续 3 次上限、5xx 总 10 次上限、500ms→32s 指数退避 + 25% jitter)
2. 重试期间前端可见(`runtime.retrying` SSE 事件,StatusBar 显示"重试中…")
3. 重试期间用户取消(`signal.abort`)立即中断并抛 AbortError,语义对齐 `retrySleep(signal)`
4. 流中途 529 (`eventCount > 0`) **不重试** —— 避免丢弃已送出的 delta / thinking token
5. 复用 `zai-agent-core/retryPolicy` 的分类器与退避策略,**不重复造轮子**

## 2. 公共契约(冻结)

### 2.1 函数签名(modelCaller 内部)

无新公开 API。`createAnthropicModelCaller()` 工厂签名不变;retry loop 在工厂返回的 generator 函数内本地实现。

### 2.2 SSE 事件 schema(`packages/zai/src/shared/events.ts`)

新增 `runtime.retrying`,加入 RuntimeEvent discriminated union:

```ts
{
  type: 'runtime.retrying',
  eventId: string,
  sessionId: string,
  ts: number,
  turnIndex: number,
  attempt: number,           // 当前失败的是第 N 次(从 1 起)
  delayMs: number,           // 下次重试前的 sleep 毫秒数
  nextAttemptAtMs: number,   // ts + delayMs,前端可渲染倒计时
  category: ErrorCategory,   // 'llm_provider_overloaded' | 'llm_provider_rate_limit' | 'llm_provider_server'
}
```

`ErrorCategory` 已存在于 `zai-agent-core/src/runtime/events.ts`,直接复用。

zod schema `RuntimeEvent` discriminated union 在 `packages/zai/src/shared/events.ts` 中追加 `z.object({...})` 变体。

### 2.3 复用常量(`zai-agent-core/src/runtime/background/retryPolicy.ts`)

```ts
import { RETRY_POLICY, classifyRetryableError, getRetryDelay, retrySleep } from '@zn-ai/zai-agent-core/background/retryPolicy'
```

预算:
- `RETRY_POLICY.max529Retries = 3` —— 连续 529/429 上限
- `RETRY_POLICY.maxRetries = 10` —— 5xx 总尝试上限
- `RETRY_POLICY.baseDelayMs = 500` —— 首次退避
- `RETRY_POLICY.maxDelayMs = 32_000` —— 退避封顶
- `getRetryDelay(attempt)` —— 指数退避 + 25% jitter
- `retrySleep(ms, signal)` —— 响应 AbortSignal 的 sleep

### 2.4 错误契约

| 场景 | eventCount | decision.retryable | 行为 |
|---|---|---|---|
| SDK create 抛 529 | 0 | true + isTransientCapacity | 重试(consecutive529 + 1,超 3 抛) |
| 连续 529 第 4 次 | 0 | true + isTransientCapacity | throw SDKError,上层 emit `runtime.error(category=llm_provider_overloaded)` |
| SDK create 抛 5xx/503/504 | 0 | true + !isTransientCapacity | 重试(attempt + 1,超 10 抛) |
| SDK create 抛 429 quota-exhausted | 0 | false (`isQuotaExhausted`) | throw,不重试 |
| SDK create 抛 429 限速 | 0 | true + isTransientCapacity | 走 transient 槽位 |
| SDK create 抛 401/403 | 0 | false | throw,不重试(依赖上层 token 刷新) |
| 流中途抛任意错 | > 0 | * | throw,**不走 retry** |
| 用户取消(`signal.aborted=true`) | * | * | throw,`retrySleep` 立刻 resolve |
| sleep 期间 abort | * | * | 下次 while 检查 signal 抛 AbortError |

### 2.5 接入点(只动 modelCaller)

**只修改** `packages/zai/src/server/services/modelCaller.ts` 一个文件 + 1 个 zod schema 改动 + 1 个 store reducer 改动。queryLoop / routes/agent.ts 不动。

- **modelCaller.ts**: 工厂返回的 generator 内,在 `client.messages.create` 调用的外层包 while-retry loop
- **shared/events.ts**: `RuntimeEvent` discriminated union 加 `runtime.retrying` 变体
- **useAgentStore.ts**: `applyRuntimeEvent` switch 加 `case 'runtime.retrying'`: `setStatus('retrying')` + push 临时 toast

## 3. 行为列表(必实现 + 1 test)

| 编号 | 行为 | 验收 |
|---|---|---|
| B1 | SDK create 阶段抛 529 → yield `runtime.retrying{attempt:1, delayMs, category:'llm_provider_overloaded'}` → sleep 500ms+jitter → 重试 | test 1 |
| B2 | 529 连续 3 次后第 4 次抛 → 不再 yield `runtime.retrying` → 抛 SDKError 让上层 emit `runtime.error(category=llm_provider_overloaded)` | test 2 |
| B3 | SDK create 阶段抛 5xx(503/504) → yield `runtime.retrying{attempt:1, category:'llm_provider_server'}` → 重试,attempt > 10 抛 | test 3 |
| B4 | 流中途抛 529 (`eventCount > 0`) → 立刻抛 SDKError,**不 yield `runtime.retrying`**,不重试 | test 4 |
| B5 | sleep 期间 `signal.aborted=true` → `retrySleep` 立刻 resolve → while 顶检查 signal → 抛 AbortError,不再 yield `runtime.retrying` | test 5 |
| B6 | SDK create 阶段抛 401/403 → `classifyRetryableError` 返回 `retryable:false` → 立刻抛 SDKError,不重试 | test 6 |
| B7 | retry 期间 yield 的 `runtime.retrying` event 携带 `attempt`/`delayMs`/`nextAttemptAtMs`/`category` 字段,被前端 store 接住后 `setStatus('retrying')` | test 7 |
| B8 | 退避序列 `getRetryDelay(1..N)` 不超过 `RETRY_POLICY.maxDelayMs = 32_000` | test 8 |

## 4. 测试点

### 4.1 Layer 1 — `packages/zai-agent-core/test/background/retryPolicy.test.ts`(已存在,新增 case)

仅做契约验证,确保被新调用方消费时语义稳定:

- `classifyRetryableError({status:529})` → `{retryable:true, isTransientCapacity:true, category:'llm_provider_overloaded'}`
- `classifyRetryableError({status:503})` → `{retryable:true, isTransientCapacity:false, category:'llm_provider_server'}`
- `classifyRetryableError({status:401})` → `{retryable:false}`
- `classifyRetryableError({status:429, message:'limit: 0'})` → `{retryable:false, category:'internal'}`(quota exhausted)

### 4.2 Layer 2 — `packages/zai/test/services/modelCaller.test.ts`(新建)

mock `@anthropic-ai/sdk` 的 `messages.create`,按 BackgroundRuntime 既有测试模式(`test/background/DefaultBackgroundRuntime.test.ts:341-398`)复用 `make529Error` / `make503Error` / `make401Error` 工厂。

| Test ID | 描述 | 关键断言 |
|---|---|---|
| T1 | 529 → 3 retries → 4th attempt 成功 | for-await 收到全部 event,无 throw;收到 3 个 `runtime.retrying` |
| T2 | 529 连续 4 次 → 抛 SDKError | for-await 在 3 个 `runtime.retrying` 后抛 SDKError,顶层 `runtime.error(category=llm_provider_overloaded)` |
| T3 | 503 连续 11 次 → attempt > 10 抛 SDKError | 收到 10 个 `runtime.retrying`(attempt 1..10),第 11 次抛 |
| T4 | 流中途 529 不重试 | controller[0] yield 一个 event 后 throwError(529) → for-await 立刻抛 SDKError,0 个 `runtime.retrying` |
| T5 | abort 中断 retry | 中途 `signal.aborted=true` → for-await 抛 AbortError,无更多 `runtime.retrying` |
| T6 | 401 不重试 | throwError(make401Error()) → 立刻抛 SDKError,无 `runtime.retrying` |
| T7 | retry 期间 emit `runtime.retrying` 字段正确 | spy yield events,断言 `{type:'runtime.retrying', attempt:1, delayMs≥500, category:'llm_provider_overloaded'}` |
| T8 | 退避不超 32s | spy `retrySleep` 调用,断言 delayMs ≤ 32000 |

mock SDK 模式:

```ts
const mockControllers: Array<{ yield: (ev: any) => void; finish: () => void; throwError: (e: Error) => void }> = []
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockImplementation(() => {
        // return AsyncIterable that pushes to mockControllers[i]
      }),
    },
  }),
}))
```

更简单:用 `readZaiSettings` 的 mock + 直接注入 fake client(参考 `DefaultBackgroundRuntime.test.ts` 的做法)。

## 5. 验收门

1. `pnpm test packages/zai-agent-core` 全绿,新增 test 文件 100% pass
2. `pnpm test packages/zai` 全绿,新增 `modelCaller.test.ts` 8 个 case 100% pass
3. `pnpm typecheck` 全绿(`packages/zai` 与 `packages/zai-agent-core` 都过)
4. 手动验证:在 dev server 中,临时构造一个 mock SDK 让 `messages.create` 第 1/2 次抛 529 第 3 次成功,确认前端 StatusBar 出现"重试中…" toast,turn 正常完成不报错
5. 手动验证:在重试期间点 UI 的"停止"按钮(abort),确认 for-await 抛 AbortError,前端状态变 `aborted` 不是 `error`

## 6. 风险与边界场景

| 风险 | 缓解 |
|---|---|
| SDK 内置 `maxRetries: 2` 与业务 retry 叠加,总重试次数可能过多(最坏情况 1 + 2×4 = 9 次) | 业务层仍能感知到 SDK 抛错,语义不会破坏;若实测发现过长,再把 SDK 内置改为 0 |
| 流中途 529 不重试,用户仍需手动重发 | 与设计 §2.4 一致;后续可单独发起"流中途 resume" spec |
| `runtime.retrying` 事件触发前端高频 toast 抖动 | toast 5s 自动消失,见 `applyRuntimeEvent` 已有 `compact.completed` 模式;若抖动再加 debounce |
| retry helper 与 BackgroundRuntime 共用 `retryPolicy`,改动会影响后台路径 | 不修改 `retryPolicy.ts`,只新增 import,风险隔离 |
| `signal.aborted` 后 `client.messages.create` 的 in-flight 请求不会立即取消(SDK 不响应 abort) | 与现状一致,不是新引入;最长等待取决于 SDK 内部 keep-alive |

## 7. 不锁定(实现细节由实现者决定)

- `runtime.retrying` 在 `applyRuntimeEvent` 里的 toast 具体文案(中文/英文)
- retry helper 放在 modelCaller.ts 内私有还是抽到独立 helper 文件
- 测试 mock SDK 的具体 jest API 形态(`jest.mock` vs dependency injection)
- 是否在控制台加 `[zai.modelCaller] retrying` 的 always-on log(类似现有 `[zai.modelCaller] ← error`)

## 8. 范围之外(Out of Scope)

- 流中途 529 自动重试(单独 spec)
- BackgroundRuntime 流中途 529 retry(单独 spec)
- queryLoop 外层重试(单独 spec)
- `runtime.retrying` 事件的 i18n(单独 spec)
- `runtime.error` 携带 retry 次数历史(单独 spec)