# E. Agent Step Limit + Tool Use Summary

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-loop-resilience-e |
| 父 spec | [umbrella](./2026-07-19-zai-loop-resilience-master-design.md) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | turn 上限可配置 + 跨 turn tool result 总结复用 |
| 工作量 | 2-3 天 |

## 0. 范围

| 在范围 | 不在范围 |
|---|---|
| `getAgentStepLimit(opts)` 解析 step 上限 | 调整 maxTurns(冻结,留新 spec) |
| turn 末 `generateToolUseSummary(result)` fire-and-forget | 接管全 prompt 的 summary(留给 Stage F2) |
| 总结存入 `transcript/*` 工具字段供下轮复用 | 总结 token 计费 / cost-tracker 集成 |
| 控制 model caller 调用 haiku 时不阻塞主 turn | Hook 触发 summary |

## 1. 背景与目标

zai `queryLoop.ts` 的 `while (turn < maxTurns)` 默认 `maxTurns = Infinity`;且 turn 末尾不生成 tool 总结,长 tool 流后的 transcript 增长无界。

本 sub-spec 目标:

1. **`getAgentStepLimit(opts)`**:解析 step 上限(`config.runtime.agentStepLimit` 或 env),若有 → 注入到 queryLoop step 检查;若否 → 返 `null`(行为不变)
2. **`generateToolUseSummary(toolResult)`**:turn 末尾 fire-and-forget 调 haiku 模型生成一句简短 summary,存入 `transcript.toolUseSummaries[toolUseId]` 字段,下轮 prompt 引用
3. **summary 复用**:下轮 turn prompt 检查 transcript 是否有 summary,有则用(不发送原始 tool_result)— **保持历史可见**(对应 F 决策"不做本地 microcompact")

## 2. 公共契约(冻结)

### 2.1 函数签名

```ts
// runtime/summary/stepCounter.ts
export interface StepLimitOptions {
  config?: RuntimeConfig;
  env?: Record<string, string | undefined>;   // ZAI_AGENT_STEP_LIMIT, ZAI_DISABLE_AGENT_STEP_LIMIT
  userOptIn?: number | undefined;             // options.agentStepLimit
}

export function getAgentStepLimit(opts?: StepLimitOptions): number | null;

// runtime/summary/toolUseSummary.ts
export interface ToolSummaryRecord {
  toolUseId: string;
  summary: string;          // 1-2 句简短总结
  generatedAt: number;
  modelUsed: string;        // haiku 默认 / config.runtime.summaryModel
}

export interface GenerateSummaryOptions {
  toolResult: ToolResult;
  sessionId: string;
  transcriptId: string;
  signal: AbortSignal;
  modelCaller?: ModelCaller;     // 缺省:small model(haiku)
}

export function generateToolUseSummary(
  opts: GenerateSummaryOptions
): Promise<ToolSummaryRecord>;

// runtime/summary/index.ts
export interface SummaryStore {
  get(toolUseId: string): ToolSummaryRecord | undefined;
  set(record: ToolSummaryRecord): void;
}

export function getSummaryStore(transcriptId: string): SummaryStore;
```

### 2.2 事件 / 字段 schema

无新 RuntimeEvent。

transcript v2 schema 加可选字段:

```ts
// transcript v2
{
  type: 'assistant',
  content: [
    {
      type: 'tool_use',
      id: string,
      name: string,
      input: unknown
    },
    // ...
  ]
}

// 新增 transcript metadata(由 SummaryStore 管理,与上面分开存储,不进 DAG 主结构)
// 存储路径: ~/.zai/summaries/<transcriptId>.json
{
  schema: 'tool-summary/v1',
  records: ToolSummaryRecord[]
}
```

`SummaryStore.get(toolUseId)` 在 turn 入点被 queryLoop / toolExecution 查;若有则让 `serializeForAnthropic` 用 summary 取代 raw tool_result content(在 prompt assembly 处,**集成 PR 阶段**)。**本期 spec 不要求实现 summary 注入 prompt 这一步** — 仅交付 summary **生成** + storage,**prompt 集成交给后续 spec F2**。

> ⚠️ 关键边界:本集**只生成 summary,不在本集替换 prompt 内容**。summary 当作"已就绪但未消费"的状态。这是为和上一轮 Stage F2 决策("保持 transcript 历史完整可见")一致 — summary 接入 prompt 是另一份 spec(建议作为 F2 子项目)。

### 2.3 配置键(从 umbrella §3.3 引用)

| Key | 类型 | 默认 |
|---|---|---|
| `config.runtime.agentStepLimit` | number \| undefined | undefined |
| `config.runtime.toolUseSummaryEnabled` | boolean | true |
| `config.runtime.summaryModel` | string | `haiku`(由 modelCaller alias 解析) |

> Stage F2 才会真正把 summary 注入 prompt,本期不动 prompt 装配代码。

### 2.4 错误契约

- `getAgentStepLimit` 纯函数,**永不抛**;无 config/env/opts → 返 `null`(不限制)
- `generateToolUseSummary` 内部 modelCaller 抛错 → 返默认 fallback:`{summary: '', generatedAt: now, modelUsed: 'fallback'}`,**不抛**(本就是 fire-and-forget)
- `SummaryStore.get/set` 永不抛;storage IO 错误返 undefined / 静默 no-op
- 与 transcript 落盘解耦:summary 写入失败不影响 transcript

### 2.5 接入点

| 位置 | 调用 |
|---|---|
| queryLoop.ts while condition 初始化 | `const stepLimit = getAgentStepLimit({config}); if (stepLimit !== null && turn > stepLimit) break + force-summary` |
| turn 末尾(`message_stop` 后,executeToolsStreaming 完成后) | `void generateToolUseSummary({toolResult, ...})` fire-and-forget |
| summarize 写入 SummaryStore | 集成阶段(F2)注入到 prompt 装配位置 |

集成 PR 阶段在 queryLoop.ts 顶端加 < 25 行 wire-in(只涉及 stepLimit 检查 + fire-and-forget 调用,**不**改 prompt 装配)。

## 3. 行为列表

1. `getAgentStepLimit({config})` → `config.runtime.agentStepLimit ?? null`
2. `getAgentStepLimit({config, env})` → `config.runtime.agentStepLimit ?? env.ZAI_AGENT_STEP_LIMIT ? parseInt : null`
3. `getAgentStepLimit({config, env, userOptIn})` → userOptIn 最优先,其次 config,其次 env
4. `getAgentStepLimit({env: {ZAI_DISABLE_AGENT_STEP_LIMIT: '1'}})` → null(显式禁用)
5. `generateToolUseSummary` 调 modelCaller,prompt 为 "summarize this tool result in 1-2 sentences";超时 5s
6. `generateToolUseSummary` 失败 fallback:`{summary: '', toolUseId, generatedAt, modelUsed: 'fallback'}`
7. SummaryStore 持久化到 `~/.zai/summaries/<transcriptId>.json`,读时 lockfile 保护
8. SummaryStore 跨进程读优先(写时 fsync + lock),set 是 idempotent(同 toolUseId 写两次取最后一次)
9. step 超过 limit → loop break + force-summary model message(via runtime.compacted 一样的 pattern)
10. step-limit 触发时不抛错,仅 yield `runtime.done` 携带 `reason:'step-limit-reached'`

## 4. 测试点

```
packages/zai-agent-core/test/integration/agent/resilience/e-agent-step-limit.test.ts
  ✓ getAgentStepLimit returns null when no config / env / userOptIn
  ✓ getAgentStepLimit returns config.runtime.agentStepLimit when set
  ✓ getAgentStepLimit returns env.ZAI_AGENT_STEP_LIMIT when parsed integer
  ✓ getAgentStepLimit returns userOptIn when provided (highest priority)
  ✓ getAgentStepLimit returns null when env.ZAI_DISABLE_AGENT_STEP_LIMIT='1'
  ✓ loop with stepLimit=5 breaks after 5 turns and yields runtime.done reason='step-limit-reached'

packages/zai-agent-core/test/integration/agent/resilience/e-tool-use-summary.test.ts
  ✓ generateToolUseSummary returns summary record with non-empty summary on success
  ✓ generateToolUseSummary returns fallback record (summary: '') on model error
  ✓ generateToolUseSummary respects 5s timeout (does not block longer)
  ✓ SummaryStore.set + get roundtrip returns last written record
  ✓ SummaryStore persists to ~/.zai/summaries/<transcriptId>.json (roundtrip across instances)
  ✓ SummaryStore write failure does not throw (silent no-op)
  ✓ SummaryStore idempotent: writing same toolUseId twice returns latest
```

## 5. 验收门

1. `pnpm --filter @zn-ai/zai-agent-core typecheck`
2. `pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/e-*`
3. `pnpm --filter @zn-ai/zai-agent-core test`(全量)
4. transcript v2 schema 不破坏现有持久化测试

## 6. 风险与边界场景

1. **summary 与 transcript 写入顺序**:不与 `appendAssistantMessageV2` 耦合;summary 是 fire-and-forget
2. **summary 注入 prompt**:本期**不做**,避免破坏"transcript 历史可见"决策;若有人尝试提前接入,需明确指出"这是 F2 工作"
3. **step-limit 与 maxTurns 关系**:step 是 turn 的子集概念(turn = 一次 model 调用;step = tool invocation 计数);spec 选 turn 作为步骤(简化模型)— Agent 可定义 step 计数 = turn 计数
4. **summary 体积**:1-2 句强制,prompt 中带 max_tokens=200 限制,避免无限 token 浪费
5. **summary 模型**:haiku 默认(便宜),但缺 haiku 时 fallback 到主模型,Agent 决定具体回退

## 7. 不锁定

- summary 文件存储 layout(per-transcript 单文件 vs per-record 多文件)— 自由
- step-limit 与 maxTurns 的关系(取小 vs 取大)— Agent 决定
- force-summary message 文案 — 自由
- modelCaller alias 解析 — 自由
