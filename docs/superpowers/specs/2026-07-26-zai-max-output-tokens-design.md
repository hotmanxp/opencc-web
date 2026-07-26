# zai 主对话路径 max_tokens / 模型感知输出上限 — 设计文档

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-26-zai-max-output-tokens |
| 作者 | Claude(经 brainstorming 流程) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | zai 主对话路径按模型 / 模型族查询 max_tokens,并在 max_output_tokens 错误时按 cap 升级自动恢复 |
| 范围 | 5 个文件 + 2 测试文件,见 §3 |
| 工作量 | 2-3 天 |

## 1. 背景与目标

### 1.1 问题陈述

zai 当前主对话路径有两个相关缺陷,均与 `max_tokens` 配置有关:

| 维度 | OpenCC 上游 | zai 现状 |
|---|---|---|
| ModelCaller 入参 | 接收 `max_tokens?: number` + `maxOutputTokensOverride?: number` | `ModelCaller` 类型无该字段,`runtime/types.ts:27-36` 只 5 个 key |
| 模型感知默认 cap | `getMaxOutputTokensForModel(model)` → Sonnet 4 = 32000,Opus/Haiku 各有 native 值 | ❌ 任何模型都硬编码 8192(`zai/src/server/services/modelCaller.ts:330`) |
| Env 覆盖 | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` + growthbook `tengu_otk_slot_v1` 开关 | ❌ 无 |
| `thinking.budget_tokens` 自适配 | `Math.min(maxOutputTokens - 1, getMaxThinkingTokensForModel(model))` | ❌ 写死 4096,与 max_tokens=8192 的差固定 |
| max_output_tokens 自愈(cap 升级) | `query.ts:1881-1909 max_output_tokens_recovery` + `query.ts:1855 escalate` 完整三段 | ❌ `recoverMaxOutputTokens.ts` 文件存在但**未接到 queryLoop/queryEngine** |
| OpenAI 兼容路径 | `max_completion_tokens` 由 `params.max_tokens` 透传 | ✅ 透传正确(`openaiClient.ts:591-593`) |
| Slot-reservation cap(8k) | `CAPPED_DEFAULT_MAX_TOKENS` 8k(所有模型) + 一次 64k retry | ❌ 无 |

**实际症状**

1. zai 调用任何模型(包括 MiniMax-M3、本地 OpenAI 兼容)都写死 `max_tokens: 8192`
2. 任何超过 ~7k tokens 的回复触发 `finish_reason: 'max_tokens'` 或者 SDK 直接抛 `max_output_tokens` 错误
3. `recoverMaxOutputTokens.ts` 写好的 cap 升级路径(`[4096, 16384, 65536]`)从未被 queryLoop 用上 — 异常直接抛 `runtime.error`,不重试
4. extended thinking 的 `budget_tokens=4096` 与 `max_tokens=8192` 写死,无法适配不同模型(部分 3P 模型 max_tokens 限制更低,会触发 `max_tokens >= thinking.budget_tokens` 校验)

### 1.2 范围

| 编号 | 子项目 | 依赖 | 工作量 |
|---|---|---|---|
| A | 模型 → max_tokens / upperLimit 映射表(`modelLimits`) | 无 | 0.5 天 |
| B | ModelCaller 类型扩展 + queryLoop/queryEngine 透传 | A | 0.5 天 |
| C | modelCaller.ts 实现用 getMaxOutputTokensForModel + env 覆盖 + thinking 自适配 | A, B | 0.5 天 |
| D | queryLoop / queryEngine 接入 recoverMaxOutputTokens 自愈 + 状态接力(per-turn counter 跟随 RuntimeConfig state) | B, C | 0.5 天 |
| E | 测试覆盖(模型表 / env 覆盖 / thinking 自适配 / recovery escalation / OpenAI 兼容路径) | A-D | 0.5-1 天 |

### 1.3 决策汇总(已和现状对齐)

| 决策项 | 决定 |
|---|---|
| 文件位置 | `zai-agent-core/src/runtime/outputLimits/modelLimits.ts`(新模块,不放进 opencc-internals) |
| 模型支持范围 | zai 当前仅暴露 Anthropic(`MiniMax-M3` 实为 Anthropic 协议)+ OpenAI-compatible(`.claude.json profiles`,已存在)两类;MiniMax-M3 默认 32000,上限 64000 |
| 默认 cap | Anthropic Sonnet 4 = 32000,Opus 4 = 32000,Haiku 4 = 64000;OpenAI 兼容走 `getOpenAIMaxOutputTokens(model)`(直接复用 opencc 的 small portable subset,见 §C) |
| Env 覆盖 | `ZAI_MAX_OUTPUT_TOKENS`(= opencc `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 对应 zai 命名),无 cap 开关(zai 默认不开 slot reservation cap,等真要开时再加 growthbook) |
| Thinking 自适配 | `thinkingBudget = min(cappedMaxTokens - 1, getMaxThinkingTokensForModel(model))` |
| Recovery 三层 | 复用 zai 现有 `recoverMaxOutputTokens.ts`,默认 `capEscalation: [n*2, n*4, 64000]`,`maxAttempts: 3` |
| 与 context 联动 | **不做** — zai 已有 `ZAI_AUTOCOMPACT_PCT_OVERRIDE` 等自动压缩 spec,本 spec 不重复 |
| 与 OpenAI 兼容路径 | **不做特殊处理** — `openaiClient.ts` 已透传 `params.max_tokens`,只要 modelCaller 把 max_tokens 算对就 OK |

### 1.4 不做

- ❌ Slot-reservation cap(8k)— opencc 是 growthbook 开关,zai 无类似配置,显式不做
- ❌ Bedrock / Vertex / Ollama 等 OpenCC 多 provider — zai 现在用 providerProfiles 切换,本 spec 把 Anthropic + OpenAI 两类覆盖即可
- ❌ 改动 `recoverMaxOutputTokens.ts` 现有逻辑(其实现已合 spec §2.4)
- ❌ 改 transcript schema(本 spec 不触及 `CompactMetadata` / `compact_boundary`)

## 2. 设计要点

### 2.1 模型 → max_tokens 映射

`zai-agent-core/src/runtime/outputLimits/modelLimits.ts`:

```ts
export interface ModelOutputLimit {
  /** Native default max_tokens (no cap applied). */
  default: number
  /** Hard upper limit the provider enforces. */
  upperLimit: number
}

const ANTHROPIC_LIMITS: Record<string, ModelOutputLimit> = {
  // Claude 4 family — 32k default, 64k upper
  'claude-4-sonnet':    { default: 32_000, upperLimit: 64_000 },
  'claude-4-opus':      { default: 32_000, upperLimit: 64_000 },
  'claude-4-haiku':     { default: 64_000, upperLimit: 64_000 },
  // Claude 3.5/3.7 — 8k default, 8k upper (matches Anthropic docs at launch)
  'claude-3-5-sonnet':  { default: 8_000,  upperLimit: 8_000  },
  'claude-3-7-sonnet':  { default: 8_000,  upperLimit: 64_000 },
  // MiniMax-M3 (zai 默认, 走 Anthropic 协议,通过代理)
  'minimax-m3':         { default: 32_000, upperLimit: 64_000 },
}

const UNKNOWN_FALLBACK: ModelOutputLimit = {
  default: 16_000,  // 已知 8192 太低, 16k 折中
  upperLimit: 64_000,
}

export function getMaxOutputTokensForModel(model: string): ModelOutputLimit
export function getMaxOutputTokensForOpenAIModel(model: string): ModelOutputLimit // 复用 opencc sub-table
```

**模型匹配规则**(参考 opencc):
1. 小写化 + 去前缀(`openai/`,`anthropic/`,`bedrock/` 等)
2. 取第一个 `-` 前的家族键(`claude-4-sonnet-20250514` → `claude-4-sonnet`)
3. 未命中 → `UNKNOWN_FALLBACK`

**Unknown 行为**: 不抛错,返回 UNKNOWN_FALLBACK,日志记一次 warning,避免上层需要分支。`runtime/outputLimits/index.ts` 用 `__logWarning` seam 给测试用。

### 2.2 ModelCaller 类型扩展

`zai-agent-core/src/runtime/types.ts` 改 `ModelCaller` 签名:

```ts
export type ModelCaller = (req: {
  model: string
  systemPrompt: string | string[] | Array<{ type: string; [key: string]: unknown }>
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  tools: Tool[]
  signal: AbortSignal
  maxTokens?: number                  // ← NEW
  maxOutputTokensOverride?: number    // ← NEW (recovery 用)
}) => AsyncGenerator<{ ... }>
```

并发 `RuntimeConfig.runtime` 加 `maxOutputTokens` 块:

```ts
runtime?: {
  // ...existing keys...
  maxOutputTokens?: {
    defaultLimit: number              // 自定义 default override
    upperLimit: number                // 自定义 upperLimit 兜底
    envOverride?: string              // 可指定 env 覆盖来源(默认 ZAI_MAX_OUTPUT_TOKENS)
  }
}
```

### 2.3 modelCaller.ts 改造

`zai/src/server/services/modelCaller.ts:330` 替换硬编码:

```ts
import { getMaxOutputTokensForModel } from '@zn-ai/zai-agent-core/runtime/outputLimits'

const limits = getMaxOutputTokensForModel(resolvedModel)
const envKey = config.runtime?.maxOutputTokens?.envOverride ?? 'ZAI_MAX_OUTPUT_TOKENS'
const envValue = parseInt(process.env[envKey] ?? '', 10)
const cappedDefault = envValue > 0
  ? envValue
  : limits.default
const maxTokens = Math.max(
  1,
  Math.min(cappedDefault, limits.upperLimit),
)

// 自适配 thinking
const thinkingBudget = Math.min(
  maxTokens - 1,
  getMaxThinkingTokensForModel(resolvedModel),
)

const stream = await client.messages.create({
  model: resolvedModel,
  max_tokens: maxTokens,
  thinking: { type: 'enabled', budget_tokens: thinkingBudget },
  // ...其余不变
}, { signal })
```

**`req.maxTokens` / `req.maxOutputTokensOverride` 优先级**:
- `req.maxOutputTokensOverride` > `req.maxTokens` > `getMaxOutputTokensForModel(model)`(走 env + 模型表)

**OpenAI 兼容路径**:
- `openaiClient.ts:591` 已经把 `params.max_tokens` 翻译成 `max_completion_tokens`,只要 `modelCaller` 调用时传入 `max_tokens: <新值>`,自动生效。

### 2.4 queryLoop / queryEngine 接入 recoverMaxOutputTokens

**触发条件**: `modelCaller` 抛 `max_output_tokens` 错误(`classifyApiError(...).kind === 'max_output_tokens'`),或在流中 yield `error` 事件且错误归类为 max_output_tokens。

**改造点**(`queryLoop.ts:342-376` 与 `queryEngine.ts:234-268` `for await (ev of modelStream)`):

```ts
let attempt = 0
const MAX_RECOVERY_ATTEMPTS = 3
let stream: AsyncIterable<RuntimeEvent> = config.modelCaller!({ ... })

while (true) {
  try {
    let sawErrorEvent: any = null
    let sawMessageStop = false
    for await (const ev of stream as any) {
      if ((ev as any).type === 'error') {
        // SDK may yield { type: 'error', error: ... } before throwing
        sawErrorEvent = (ev as any).error
        break
      }
      if ((ev as any).type === 'message_stop') {
        sawMessageStop = true
        break
      }
      // ...existing wrap+accumulate logic...
    }

    if (sawMessageStop || !sawErrorEvent) {
      // 成功或非 max_tokens 错误,跳出 recovery 循环
      break
    }

    // 仅 max_output_tokens 走自愈
    const classified = classifyApiError(sawErrorEvent)
    if (classified.kind !== 'max_output_tokens') {
      throw sawErrorEvent
    }
    if (attempt >= MAX_RECOVERY_ATTEMPTS) {
      yield toRuntimeErrorEvent(new Error(classified.message), { sessionId, turnIndex: turn, kind: 'max_output_tokens' })
      return
    }

    attempt++
    const escalated = ESCALATED_MAX_TOKENS_TABLE[attempt] // [4096, 16384, 65536] 类似 opencc 三层
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.qe] max_output_tokens recovery', { sessionId, turn, attempt, escalated })
    }
    stream = config.modelCaller!({
      ...,
      maxOutputTokensOverride: escalated,
    })
  } catch (err) {
    if (classifyApiError(err).kind !== 'max_output_tokens') throw err
    // 同上,attempt++ 重试
  }
}
```

**注意**:`recoverMaxOutputTokens.ts` 现有实现是**辅助函数**而非控制流,本 spec 不替换它,而是在 queryLoop / queryEngine 直接写上述 while-loop(避免双层 state 维护)。

**thinking 自适配保持不动**(已经在 modelCaller.ts 算好)。

### 2.5 Env 矩阵

| Env | 默认 | 优先级 | 行为 |
|---|---|---|---|
| `ZAI_MAX_OUTPUT_TOKENS` | unset | 高于模型 default,上限 = `ModelOutputLimit.upperLimit` | 设了就用,parseInt 失败静默 |

> 不做 `ZAI_DISABLE_RECOVERY` 开关 — 默认 recover 总是开,行为可观测便于排障。
> 不做 slot-reservation cap(8k)— 等真要时再加 growthbook。

### 2.6 已知风险

- 上游 provider 实际 max_tokens 可能比 `ModelOutputLimit.upperLimit` 严格(尤其 3P OpenAI 兼容);`getMaxOutputTokensForOpenAIModel` 直接复用 opencc 表,**没有兜底测试 3P 兼容性**,只测 Anthropic + 自家 profile
- `thinking.budget_tokens` 改动后, 旧 transcript 中已持久化的 thinking block 不受影响(thinking block 自带数据,不影响下次请求)
- `recoverMaxOutputTokens.ts` 与本 spec while-loop 是**两套并列逻辑**;短期保留两份(recovery 已写好的测试可继续跑),未来若发现并行差异再合并

## 3. 文件索引

| 文件 | 职责 |
|---|---|
| `packages/zai-agent-core/src/runtime/outputLimits/modelLimits.ts` **(新)** | `ModelOutputLimit` 类型 + `getMaxOutputTokensForModel` + `getMaxOutputTokensForOpenAIModel` + Anthropic 静态表 + UNKNOWN fallback |
| `packages/zai-agent-core/src/runtime/outputLimits/openaiLimits.ts` **(新)** | 复用 opencc `getOpenAIMaxOutputTokens` 逻辑(纯函数,无 import cycle) |
| `packages/zai-agent-core/src/runtime/outputLimits/index.ts` **(新)** | re-export + `__logWarning` 测试 seam |
| `packages/zai-agent-core/src/runtime/types.ts` | `ModelCaller` 加 `maxTokens?` + `maxOutputTokensOverride?`;`RuntimeConfig.runtime.maxOutputTokens` 加可选 override block |
| `packages/zai-agent-core/src/runtime/outputLimits/thinkingBudget.ts` **(新)** | `getMaxThinkingTokensForModel(model)`(对 opencc 简化版:仅 claude-4 = 32k,claude-3.5 = 8k,UNKNOWN = 8k) |
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | `for await (modelStream)` 改 while-loop recovery,加 attempt counter |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | 同上 |
| `packages/zai-agent-core/src/runtime/errors/maxOutputTokens.ts` | **不改**(已有 spec,本 plan 不动实现) |
| `packages/zai/src/server/services/modelCaller.ts` | 替换硬编码 8192 → `getMaxOutputTokensForModel + env + thinking 自适配`,接收 `req.maxTokens` / `req.maxOutputTokensOverride` |
| `packages/zai-agent-core/test/runtime/outputLimits/modelLimits.test.ts` **(新)** | 模型家族解析 / 未知模型 fallback / 大小写不敏感 / 前缀剥离 |
| `packages/zai-agent-core/test/runtime/outputLimits/thinkingBudget.test.ts` **(新)** | thinking budget 自适配 = min(maxTokens-1, native) |
| `packages/zai-agent-core/test/runtime/queryLoop-max-tokens-recovery.test.ts` **(新)** | mock modelCaller 三次失败(递增 cap)→ 第四次成功 → 主循环继续 |
| `packages/zai-agent-core/test/runtime/modelCaller-integration.test.ts` **(新)** | end-to-end: 收到 `req.maxTokens` 时透传到 SDK / client 端(用 vi.mock 替换 Anthropic client) |

## 4. 交付目标

- ✅ 主对话路径不再写死 `max_tokens=8192`
- ✅ Sonnet 4 默认 32k,Haiku 4 默认 64k,UNKNOWN fallback 16k
- ✅ `ZAI_MAX_OUTPUT_TOKENS` 可覆盖,上限 = 模型 upperLimit
- ✅ thinking budget 自动 = min(maxTokens-1, native)
- ✅ max_output_tokens 错误自动 cap 升级重试(最多 3 次, [original*2, original*4, 64k]) → 失败 3 次后 yield `runtime.error kind:'max_output_tokens'`
- ✅ 测试:`outputLimits` line ≥ 90%,branch ≥ 80%;recovery flow 至少 5 个 case(成功 / 非 max_tokens 不重试 / 重试用完 / 第 N 次成功 / 中途 abort)
- ✅ OpenAI 兼容路径无回归(自动跟随 modelCaller 改动)
- ✅ 不引入新依赖

## 5. 后续阶段(本 spec 不做)

- 与 `ZAI_AUTOCOMPACT_*` env 联动(queryEngine 入口)
- Slot-reservation cap(8k growthbook 开关)
- 多 provider(Bedrock / Vertex)
- OpenAI 兼容路径 thinking 兼容(MiniMax-M3 OpenAI 协议)
