# zai 主循环鲁棒性补全 — Umbrella Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 本 plan 是**调度层 plan**,不是 task-by-task 实现 plan。Phase 0 已完成(commit `a5b8fc9`)。Phase 1 由 dispatcher(主 session)用 AgentTool 一次性并行派出 5 个独立 Agent;各 Agent 在自己的 sub-spec `/docs/superpowers/specs/2026-07-19-zai-loop-resilience-{a,b,c,d,e}-*.md` 带领下,自行走 `superpowers:executing-plans` 在 sub-spec 内细化 task 步骤。Phase 2 由主 session 在 5 PR 都验证后做 wiring 集成 PR。

**Goal:** 由 5 个独立 Agent 并行实现 5 个子项目(A 错误分类 / B streaming tool / C nudge / D attachment / E step-limit),每个 Agent 按各自 sub-spec 的契约实现 + 自跑 verify gate;完成后由主 session 做 < 50 行的 wire-in 集成 PR,把 5 个模块串入 queryLoop.ts / toolExecution.ts。

**Architecture:**
- 5 个 sub-spec(contract-level)在 commit `a5b8fc9` 中已签名冻结。本 plan 不重写合同。
- Phase 1:dispatcher(主 session)同时调用 `AgentTool.run_in_background=true × 5`,每 Agent 拿到的 prompt 都是**完全独立**的(无交叉引用)。
- 各 Agent 用 `superpowers:executing-plans` skill 在自己的工作目录(`runtime/{errors,streaming,nudge,attachment,summary}/`)内做 task-by-task TDD 实现,各自 commit。
- Phase 2:人工 review 5 PR;主 session 增改 < 50 行(`runtime/queryLoop.ts` 顶端 + `runtime/toolExecution.ts` 顶端),把 5 个 wire-in 点串起来。

**Tech Stack:** TypeScript ES2022 / Node.js / vitest + tsc --noEmit / zod discriminatedUnion for RuntimeEvent / proper-lockfile for transcript + summary persistence。

---

## Global Constraints

来自 umbrella spec + 各 sub-spec,所有 Agent 隐式遵守:

- **绝对不可触动文件**(5 Agent 全部):
  - `packages/zai-agent-core/src/runtime/queryLoop.ts`(主循环主体,主 session 在 Phase 2 改)
  - 任何 `packages/zai-agent-core/src/opencc-internals/` 文件(OpenCC 上游 vendor 区域)
  - 任何 `packages/zai/` 服务端 / 前端代码(本 plan 范围仅 zai-agent-core)
- **Agent 可改(契约冻结前)**:`runtime/{errors,streaming,nudge,attachment,summary}/` 新目录下所有文件 + `test/integration/agent/resilience/{a,b,c,d,e}-*` 新测试;以及 sub-spec §2.5 接入点(hint)中明确列出的"Agent 可附加扩展的现有文件":
  - **C Agent**:`packages/zai-agent-core/src/plugins/HookRunner.ts`(扩展 payload 字段,纯 additive)
  - **B Agent**:`packages/zai-agent-core/src/runtime/toolExecution.ts` 顶部(替换串行调度为 streaming;公共 signature 不变)
  - **D Agent**:**不可改 BashTracker / BackgroundRuntime**,只读它们的 store API
  - **E Agent**:**不可改 TaskListStore**;只新增 `~/.zai/summaries/` 目录路径
- **配置键**(umbrella §3.3 冻结,**禁止新增**):
  - `config.runtime.maxOutputTokensRecoveryAttempts`(A)
  - `config.runtime.toolFailureLoopMaxConsecutive`(A)
  - `config.runtime.streamingToolExecution`(B);`streamingToolExecution.maxParallel`(B)
  - `config.runtime.continuationNudgeMax`(C);`continuationNudgeEnabled`(C)
  - `config.runtime.agentStepLimit`(E);`toolUseSummaryEnabled`(E);`summaryModel`(E)
  - `config.runtime.attachmentPrefetchEnabled`(D);`memoryPrefetchWindow`(D)
- **公共类型契约**(已被 5 sub-spec 锁定;Agent 不得扩展):
  - `ErrorKind`(A §2.1)— 已含 `'tool_failure_loop' | 'hook_blocked'`
  - `HookBlockedError`(C §2.1)
  - `StreamingToolExecutor` / `StreamingToolExecutorHandle`(B §2.1)
  - `getAttachmentMessages` / `MemoryPrefetchHandle`(D §2.1)
  - `getAgentStepLimit` / `generateToolUseSummary` / `SummaryStore`(E §2.1)
- **新增 RuntimeEvent 类型**:**禁止**;仅允许在既有 union 加字段(`runtime.error.kind: ErrorKind`,`runtime.tool_call.parallel: boolean`)
- **测试运行**:`pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/{a,b,c,d,e}-*`
- **类型检查**:`pnpm --filter @zn-ai/zai-agent-core typecheck`(必须 0 error)
- **commit 风格**:Conventional Commits,一个 task 一个 commit;Agent 内部细分的 task 各自 commit
- **文件大小**:每个新文件 < 300 行(超过就拆)
- **数据契约(transcript/summary)**:SummaryStore 写 `~/.zai/summaries/<transcriptId>.json`,用 `proper-lockfile`(已存在),与 `appendAssistantMessageV2` 解耦
- **失败行为**:任一 Agent verify 失败 → 单独 reject 该 PR,不影响其它 Agent

---

## File Structure(增量)

| 路径 | Agent | 状态 |
|---|---|---|
| `packages/zai-agent-core/src/runtime/errors/classification.ts` | A | 新增 |
| `packages/zai-agent-core/src/runtime/errors/maxOutputTokens.ts` | A | 新增 |
| `packages/zai-agent-core/src/runtime/errors/loopGuard.ts` | A | 新增 |
| `packages/zai-agent-core/src/runtime/errors/reactiveCompact.ts` | A | 新增(stub) |
| `packages/zai-agent-core/src/runtime/errors/index.ts` | A | 新增(re-export facade) |
| `packages/zai-agent-core/src/runtime/streaming/streamingToolExecutor.ts` | B | 新增 |
| `packages/zai-agent-core/src/runtime/streaming/types.ts` | B | 新增 |
| `packages/zai-agent-core/src/runtime/streaming/index.ts` | B | 新增(re-export facade) |
| `packages/zai-agent-core/src/runtime/nudge/analyze.ts` | C | 新增 |
| `packages/zai-agent-core/src/runtime/nudge/inject.ts` | C | 新增 |
| `packages/zai-agent-core/src/runtime/nudge/hooks.ts` | C | 新增(`HookBlockedError` 类型导出) |
| `packages/zai-agent-core/src/runtime/nudge/index.ts` | C | 新增(re-export facade) |
| `packages/zai-agent-core/src/runtime/attachment/get.ts` | D | 新增 |
| `packages/zai-agent-core/src/runtime/attachment/prefetchMemory.ts` | D | 新增 |
| `packages/zai-agent-core/src/runtime/attachment/index.ts` | D | 新增(re-export facade) |
| `packages/zai-agent-core/src/runtime/summary/stepCounter.ts` | E | 新增 |
| `packages/zai-agent-core/src/runtime/summary/toolUseSummary.ts` | E | 新增 |
| `packages/zai-agent-core/src/runtime/summary/index.ts` | E | 新增(re-export facade) |
| `packages/zai-agent-core/test/integration/agent/resilience/a-*.test.ts` | A | 新增(3 文件) |
| `packages/zai-agent-core/test/integration/agent/resilience/b-*.test.ts` | B | 新增(1 文件) |
| `packages/zai-agent-core/test/integration/agent/resilience/c-*.test.ts` | C | 新增(2 文件) |
| `packages/zai-agent-core/test/integration/agent/resilience/d-*.test.ts` | D | 新增(2 文件) |
| `packages/zai-agent-core/test/integration/agent/resilience/e-*.test.ts` | E | 新增(2 文件) |
| `packages/zai-agent-core/src/runtime/toolExecution.ts` | B | 顶部 ~10 行替换(不破坏 public signature) |
| `packages/zai-agent-core/src/plugins/HookRunner.ts` | C | Stop-hook payload 加 `blocking` 字段(纯 additive) |

主 session 在 Phase 2 改的文件(不属于任何 Agent 范围):

| 路径 | Phase 2 改动范围 |
|---|---|
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | 顶端加 < 50 行 wire-in(`D.get → D.prefetchMemory → for-await → A.classify → B.drain → C.analyze → A.loopGuard → C.hook + E.stepLimit`) |
| `packages/zai-agent-core/src/runtime/toolExecution.ts` | 上一步 B 替换 + 可能补 1 行 dispatch counter |

---

## Phase 0 — 签名冻结(已完成,不重做)

- [x] umbrella + 5 sub-spec 写完并 commit(`a5b8fc9`)
- [x] 所有公共类型签名 / 事件字段 / 配置键在 6 份 spec 中冻结
- [x] Agent 工作目录 / 不可碰文件 / Agent 间交叉接口已列表化

## Phase 1 — 5 Agent 并行实现

> **Dispatcher = 主 session**。按下面 5 段 prompt 分别用 `AgentTool.subagent_type="general-purpose".run_in_background=true` 一次性派出 5 个调用(可以放在一个 message 内同一 tool block 并发调用)。每 Agent 拿到 prompt 后自决如何细化 task-by-task,但**不得修改 prompt 里"不可触"清单**。

### Phase 1 — Dispatch 表

| Dispatch ID | Agent Type | Prompt 段 |
|---|---|---|
| `agent-A-errors` | general-purpose | 见 §A Prompt |
| `agent-B-streaming` | general-purpose | 见 §B Prompt |
| `agent-C-nudge` | general-purpose | 见 §C Prompt |
| `agent-D-attachment` | general-purpose | 见 §D Prompt |
| `agent-E-step-limit` | general-purpose | 见 §E Prompt |

---

### §A Prompt — A Agent(错误分类 / max_output_tokens / loop guard)

```
你是 ZAI 子项目 A 的独立实现 Agent。请使用 superpowers:executing-plans skill
在你的工作目录内做 task-by-task TDD 实现。

【Spec 来源】docs/superpowers/specs/2026-07-19-zai-loop-resilience-a-errors-design.md
【umbrella】  docs/superpowers/specs/2026-07-19-zai-loop-resilience-master-design.md
【Spec 状态】 commit a5b8fc9 已落主干,签名为冻结合同,**一切实现以 spec §2 为准**

【你的工作目录】
  Create: packages/zai-agent-core/src/runtime/errors/
    ├─ classification.ts   (classifyApiError)
    ├─ maxOutputTokens.ts  (recoverMaxOutputTokens 流式恢复)
    ├─ loopGuard.ts        (recordToolFailure / recordToolSuccess)
    ├─ reactiveCompact.ts  (tryReactiveCompact,本期 stub)
    └─ index.ts            (re-export facade)
  Create: packages/zai-agent-core/test/integration/agent/resilience/
    ├─ a-error-classification.test.ts
    ├─ a-max-output-tokens-recovery.test.ts
    ├─ a-tool-failure-loop-guard.test.ts
    └─ a-reactive-compact-stub.test.ts

【绝对不可触文件】
  ✗ packages/zai-agent-core/src/runtime/queryLoop.ts        (主 session Phase 2 改)
  ✗ packages/zai-agent-core/src/runtime/toolExecution.ts    (B Agent 改)
  ✗ packages/zai-agent-core/src/plugins/HookRunner.ts       (C Agent 改)
  ✗ packages/zai-agent-core/src/opencc-internals/**         (OpenCC 上游 vendor)
  ✗ packages/zai/**                                         (不在范围)

【你必须严格按 spec 实现的事】
  1. ErrorKind union 必须**完全**包含 spec §2.1 列出的 9 个 literal:
     'prompt_too_long' | 'max_output_tokens' | 'rate_limit' | 'auth'
     | 'context_overflow' | 'provider_max_tokens_cap' | 'tool_failure_loop'
     | 'hook_blocked' | 'unknown'
     不允许删/改,即使你觉得某些不必要。
  2. classifyApiError 永不抛,网络层错误兜底到 kind:'unknown',retryable:true
  3. recoverMaxOutputTokens capEscalation 顺序: [4096, 16384, 65536]
     第 3 次仍失败 → yield runtime.error kind:'max_output_tokens',**不抛**
  4. recordToolFailure 第一次失败 → 'continue',连续 N 次同 toolUseId → 'break-and-error'
  5. tryReactiveCompact 调 runtime/compact/conversation.ts 的 compactConversation:
     - 不存在 → kind:'unimplemented'
     - 存在且成功 → kind:'attempted' + newMessages
     - 存在但抛错 → kind:'failed',**不抛**
  6. 公共 ClassifiedError payload 透传 providerErrorCode(Anthropic error.type / proxy code)
  7. 每个 spec §3 行为编号 = 一个 test case (子 spec §4 全部 case 必写)
  8. 暴露 RuntimeEvent runtime.error 时,必须在 payload 加 kind:ErrorKind + providerErrorCode

【TDD 流程】
  1. 读 spec §4 测试点列表
  2. 每个测试点先写失败的 test (vitest,参考 packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts 的 fake modelCaller 写法)
  3. 实现对应模块函数让测试通过
  4. 一个 test = 一个 commit。commit 风格:
     feat(zai-agent-core): add classifyApiError for 413/429/5xx
     test(zai-agent-core): a-error-classification.anthropic_413

【Verify Gate(必须全绿才能回报)】
  cd packages/zai-agent-core
  pnpm --filter @zn-ai/zai-agent-core typecheck
  pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/a-*
  pnpm --filter @zn-ai/zai-agent-core test   # 全量,确保 auto-compact-turn-loop.test.ts 不退

【回报格式(主 dispatcher 看)】
  报告必须包含:
    - 文件清单(新增 N 个 + 改 0 个)
    - 测试 case 数 + 通过数
    - typecheck 0 error
    - 全量 vitest 通过
    - commit SHA list
    - 任何 spec 偏离(若有,需明确说明)
  报告末尾写出"READY TO MERGE"或"BLOCKED: <原因>"
```

### §B Prompt — B Agent(streaming tool execution)

```
你是 ZAI 子项目 B 的独立实现 Agent。请使用 superpowers:executing-plans skill
在你的工作目录内做 task-by-task TDD 实现。

【Spec 来源】docs/superpowers/specs/2026-07-19-zai-loop-resilience-b-streaming-tools-design.md
【umbrella】  docs/superpowers/specs/2026-07-19-zai-loop-resilience-master-design.md
【Spec 状态】 commit a5b8fc9 已落主干,签名为冻结合同

【你的工作目录】
  Create: packages/zai-agent-core/src/runtime/streaming/
    ├─ streamingToolExecutor.ts  (createStreamingToolExecutor 主体)
    ├─ types.ts                  (StreamingToolExecutorOptions / Handle / ParallelToolEvent)
    └─ index.ts                  (re-export facade)
  Create: packages/zai-agent-core/test/integration/agent/resilience/
    └─ b-streaming-tool-execution.test.ts  (1 个大文件,9 个 case)

  Modify: packages/zai-agent-core/src/runtime/toolExecution.ts
    范围:仅顶部调度逻辑,**public signature 不变**。
    - 在文件顶部 import { createStreamingToolExecutor } from '../streaming/...'
    - 保留现有 executeToolsStreaming 流式 API,但内部调度改为 streaming executor
    - 保留 appendToolUse / appendToolResult 调用(行为不变)

【绝对不可触文件】
  ✗ packages/zai-agent-core/src/runtime/queryLoop.ts
  ✗ packages/zai-agent-core/src/plugins/HookRunner.ts        (C Agent)
  ✗ packages/zai-agent-core/src/runtime/errors/**            (A Agent)
  ✗ packages/zai-agent-core/src/runtime/nudge/**             (C Agent)
  ✗ packages/zai-agent-core/src/runtime/attachment/**        (D Agent)
  ✗ packages/zai-agent-core/src/runtime/summary/**           (E Agent)
  ✗ packages/zai-agent-core/src/opencc-internals/**
  ✗ packages/zai/**

【你必须严格按 spec 实现的事】
  1. createStreamingToolExecutor 签名 = spec §2.1 完整
  2. submit(toolUse) 入队;maxParallel 上限默认 4(config 可调)
  3. 工具 execute 异常 → 仍 yield runtime.tool_result {ok:false},不抛
  4. cancel() / AbortSignal abort → drain 立即 resolve(可能空数组)
  5. submit 不存在的 tool → runtime.tool_call invalid + runtime.tool_result ok:false 'tool not found'
  6. runtime.tool_call payload 加 parallel:boolean (streaming 派发恒为 true)
  7. 端到端:10 个并行 tool < 串行 60% 时间(spec §5 第 4 条)
  8. spec §3 行为 = 1 个 test case(spec §4 列的 9 个 case 必写)

【TDD 流程 + Verify Gate + 回报】同 §A。

【额外】你**只动** toolExecution.ts 顶部 + 顶部下方调度段;
  不要触碰 abortController / transcriptStore / append* 用法。
  公共函数签名 export function executeToolsStreaming(...) 不变。
```

### §C Prompt — C Agent(stop hook blocking + continuation nudge)

```
你是 ZAI 子项目 C 的独立实现 Agent。请使用 superpowers:executing-plans skill
在你的工作目录内做 task-by-task TDD 实现。

【Spec 来源】docs/superpowers/specs/2026-07-19-zai-loop-resilience-c-nudge-design.md
【umbrella】  docs/superpowers/specs/2026-07-19-zai-loop-resilience-master-design.md
【Spec 状态】 commit a5b8fc9 已落主干,签名为冻结合同

【你的工作目录】
  Create: packages/zai-agent-core/src/runtime/nudge/
    ├─ analyze.ts      (analyzeContinuationIntent)
    ├─ inject.ts       (injectContinuationNudge + NudgeCounters)
    ├─ hooks.ts        (export HookBlockedError / StopHookBlockingError)
    └─ index.ts        (re-export facade)
  Create: packages/zai-agent-core/test/integration/agent/resilience/
    ├─ c-continuation-nudge.test.ts
    └─ c-stop-hook-blocking.test.ts

  Modify: packages/zai-agent-core/src/plugins/HookRunner.ts
    范围:仅扩展 Stop-hook payload(`StopHookPayload` 接口)加 `blocking: boolean`
    字段。**纯 additive**,不破坏现有 hook 注册逻辑。
    如果现有 HookRunner 没有 StopHookPayload interface,
    可在 HookRunner.ts 内部新增 local interface(不要 export,避免污染外部 API)。
    注意:HookBlockedError 类由 runtime/nudge/hooks.ts 导出,
    HookRunner 不持有该类型 reference。

【绝对不可触文件】
  ✗ packages/zai-agent-core/src/runtime/queryLoop.ts
  ✗ packages/zai-agent-core/src/runtime/toolExecution.ts    (B)
  ✗ packages/zai-agent-core/src/runtime/errors/**            (A)
  ✗ packages/zai-agent-core/src/runtime/streaming/**         (B)
  ✗ packages/zai-agent-core/src/runtime/attachment/**        (D)
  ✗ packages/zai-agent-core/src/runtime/summary/**           (E)
  ✗ packages/zai-agent-core/src/opencc-internals/**
  ✗ packages/zai/**

【你必须严格按 spec 实现的事】
  1. analyzeContinuationIntent 永不抛,文本空 → 'complete',lastBlock='tool_use' → 'complete'
  2. injectContinuationNudge 永不抛,纯函数,返 InjectNudgeResult
  3. consecutive 计数到 max → inject:false reason:'needs-tool-max'
  4. HookBlockedError 名字 = 'HookBlockedError',hookName + reason 字段
  5. runtime.error payload 加 kind:'hook_blocked' + hookName 字段
     (ErrorKind union 已含 'hook_blocked',不要重复定义)
  6. spec §3 行为 10 条,每个 = 1 test case(spec §4 列的 14 个 case 必写)

【TDD 流程 + Verify Gate + 回报】同 §A。

【额外】HookRunner.ts 的修改务必 minimal:
  - 只加一个 StopHookPayload interface(可 export 或 local)
  - 现有 Stop hook 调用点不动
  - public run() signature 不变
  - 阻断逻辑由主 session 在 Phase 2 接入
```

### §D Prompt — D Agent(mid-turn attachment + memory prefetch)

```
你是 ZAI 子项目 D 的独立实现 Agent。请使用 superpowers:executing-plans skill
在你的工作目录内做 task-by-task TDD 实现。

【Spec 来源】docs/superpowers/specs/2026-07-19-zai-loop-resilience-d-attachment-design.md
【umbrella】  docs/superpowers/specs/2026-07-19-zai-loop-resilience-master-design.md
【Spec 状态】 commit a5b8fc9 已落主干,签名为冻结合同

【你的工作目录】
  Create: packages/zai-agent-core/src/runtime/attachment/
    ├─ get.ts                (getAttachmentMessages)
    ├─ prefetchMemory.ts     (startRelevantMemoryPrefetch)
    └─ index.ts              (re-export facade)
  Create: packages/zai-agent-core/test/integration/agent/resilience/
    ├─ d-attachment-messages.test.ts
    └─ d-memory-prefetch.test.ts

【绝对不可触文件】
  ✗ packages/zai-agent-core/src/runtime/queryLoop.ts
  ✗ packages/zai-agent-core/src/runtime/toolExecution.ts    (B)
  ✗ packages/zai-agent-core/src/plugins/HookRunner.ts       (C)
  ✗ packages/zai-agent-core/src/runtime/errors/**            (A)
  ✗ packages/zai-agent-core/src/runtime/streaming/**         (B)
  ✗ packages/zai-agent-core/src/runtime/nudge/**             (C)
  ✗ packages/zai-agent-core/src/runtime/summary/**           (E)
  ✗ BashTracker / BackgroundRuntime / TaskListStore 内部代码 (只读它们的 store API)
  ✗ packages/zai-agent-core/src/opencc-internals/**
  ✗ packages/zai/**

【你必须严格按 spec 实现的事】
  1. getAttachmentMessages 永不抛,异常 → 返 []
  2. 拉取 BackgroundRuntime 已完成 task output
  3. 拉取 BashTracker 已完成 task output
  4. source 4 类: 'background-bash' | 'background-agent' | 'skill-prefetch' | 'memory-prefetch'
  5. consumedAt asc 排序
  6. fromTimestamp 过滤(spec §3 行为 4)
  7. startRelevantMemoryPrefetch 立即返回 handle,不等待 IO
  8. dispose() / AbortSignal → prefetched 立即 resolve null
  9. windowMs 默认 1500ms (config.runtime.memoryPrefetchWindow)
  10. spec §3 行为 11 条,每个 = 1 test case (spec §4 列的 13 个 case 必写)

【TDD 流程 + Verify Gate + 回报】同 §A。
```

### §E Prompt — E Agent(agent step limit + tool use summary)

```
你是 ZAI 子项目 E 的独立实现 Agent。请使用 superpowers:executing-plans skill
在你的工作目录内做 task-by-task TDD 实现。

【Spec 来源】docs/superpowers/specs/2026-07-19-zai-loop-resilience-e-step-limit-design.md
【umbrella】  docs/superpowers/specs/2026-07-19-zai-loop-resilience-master-design.md
【Spec 状态】 commit a5b8fc9 已落主干,签名为冻结合同

【你的工作目录】
  Create: packages/zai-agent-core/src/runtime/summary/
    ├─ stepCounter.ts        (getAgentStepLimit)
    ├─ toolUseSummary.ts     (generateToolUseSummary)
    ├─ summaryStore.ts       (SummaryStore / getSummaryStore)
    └─ index.ts              (re-export facade)
  Create: packages/zai-agent-core/test/integration/agent/resilience/
    ├─ e-agent-step-limit.test.ts
    └─ e-tool-use-summary.test.ts

【绝对不可触文件】
  ✗ packages/zai-agent-core/src/runtime/queryLoop.ts
  ✗ packages/zai-agent-core/src/runtime/toolExecution.ts    (B)
  ✗ packages/zai-agent-core/src/plugins/HookRunner.ts       (C)
  ✗ packages/zai-agent-core/src/runtime/errors/**            (A)
  ✗ packages/zai-agent-core/src/runtime/streaming/**         (B)
  ✗ packages/zai-agent-core/src/runtime/nudge/**             (C)
  ✗ packages/zai-agent-core/src/runtime/attachment/**        (D)
  ✗ TaskListStore / BashTracker / BackgroundRuntime 内部代码
  ✗ packages/zai-agent-core/src/opencc-internals/**
  ✗ packages/zai/**

【你必须严格按 spec 实现的事】
  1. getAgentStepLimit 永不抛,无 config → null
  2. 优先级: userOptIn > config > env,env.ZAI_DISABLE_AGENT_STEP_LIMIT='1' → null
  3. generateToolUseSummary timeout 5s,失败 fallback {summary:'' modelUsed:'fallback'},不抛
  4. SummaryStore 写 ~/.zai/summaries/<transcriptId>.json + proper-lockfile
  5. set idempotent: 写同 toolUseId 两次取最后一次
  6. 与 transcript 落盘解耦(appendAssistantMessageV2 不依赖 SummaryStore)
  7. 【关键本期边界】仅生成 + storage;**不接入 prompt 装配**(留给后续 F2 spec)
  8. spec §3 行为 10 条,每个 = 1 test case (spec §4 列的 13 个 case 必写)

【TDD 流程 + Verify Gate + 回报】同 §A。

【额外】SummaryStore 路径 ~/.zai/summaries/ 不要进 transcript/ 目录:
  - spec §2.2 schema:'tool-summary/v1'
  - 用 proper-lockfile (已 zai 依赖)
  - 不要试图改 ~/.zai/transcripts/** 或 TranscriptStore 接口
```

---

### Phase 1 — Dispatch 流程(主 session 执行)

- [ ] **Step 1: 主 session 启动 5 个 AgentTool 调用**

  在一个 message 内,5 个 Agent 调用并发发出,每个用以下 schema(以 A 为例):

  ```
  AgentTool(
    subagent_type: "general-purpose",
    run_in_background: true,
    description: "zai-loop-resilience-A 错误分类/自愈/loop-guard 实现",
    prompt: <§A Prompt 内容整段>
  )
  ```

  5 个调用在同一 tool block 内同时发起,主 session 不等任何 response。

- [ ] **Step 2: 主 session 轮询监听 5 Agent 结果**

  使用 `BackgroundAgentResult` 工具检查每个 dispatch 的 progress。
  当返回 `<subagent_result>` 标签时,记录其报告到主 session 上下文。

- [ ] **Step 3: 主 session 评估 5 报告**

  每个报告必须含 "READY TO MERGE" 才进 Phase 2;否则该 Agent 的 PR 单独 reject 重做,不阻塞其它。

- [ ] **Step 4: 主 session 推 5 PR**

  各 Agent 完成时会推 1 个 PR 到 origin。5 个 PR 互不冲突(因文件所有权)。

  若有 PR 在 main 上直接合并,合并顺序不影响(零冲突 architecture)。

---

## Phase 2 — Wire-in 集成 PR

> 仅由主 session 执行,不属于 5 Agent 范围。在所有 5 sub-spec PR 都合并后做。

- [ ] **Task 1: 阅读 5 PR + spec 的 wire-in 表**

  打开 umbrella §3.1 系统全图 + 5 sub-spec §2.5 接入点表。

- [ ] **Task 2: 写 5 wiring `runtime/queryLoop.ts` 增量**

  在 `runtime/queryLoop.ts` 顶端(turn entry 处)加 < 50 行,按以下顺序串接(参考伞 §3.1 流程图):

  ```ts
  // === wire-in start ===
  // D
  const attachmentResult = await getAttachmentMessages({ sessionId, signal })
  for (const att of attachmentResult) messages.push(att.payload)
  const memPrefetch = startRelevantMemoryPrefetch({ sessionId, signal })

  // A
  let loopGuardState: LoopGuardState = { consecutiveFailureByToolId: new Map() }
  let nudgeCounters: NudgeCounters = { consecutive: 0, total: 0 }
  const stepLimit = getAgentStepLimit({ config })

  // turn loop:
  while (turn < maxTurns) {
    if (stepLimit !== null && turn > stepLimit) break
    try {
      for await (const ev of modelCaller(...)) {
        // B: 把闭合 tool_use 推给 streaming executor
        if (ev.type === 'content_block_stop' && pendingToolUse) {
          streamingExec.submit(pendingToolUse)
          pendingToolUse = null
        }
        yield ev
      }
      // A: tryRecoverMaxOutputTokens if last error
      // C: analyzeContinuationIntent + injectContinuationNudge
      const intent = analyzeContinuationIntent(text, lastBlockKind)
      const nudgeResult = injectContinuationNudge(intent, { counters: nudgeCounters, max: config.runtime.continuationNudgeMax, enabled: config.runtime.continuationNudgeEnabled })
      if (nudgeResult.inject && nudgeResult.nudgeMessage) yield nudgeResult.nudgeMessage
      // E: fire-and-forget summary
      void generateToolUseSummary({ toolResult, sessionId, transcriptId, signal })
    } catch (err) {
      const classified = classifyApiError(err)
      if (classified.kind === 'max_output_tokens') {
        yield* recoverMaxOutputTokens({ ... })
      } else {
        yield { type: 'runtime.error', payload: { ...classified, fatal: true } }
        break
      }
    }
    // C: Stop-hook + A: loopGuard
    // loopGuard decision check
    // Stop-hook run with try/catch HookBlockedError
    turn++
  }
  memPrefetch.dispose()
  // === wire-in end ===
  ```

  > **实现细节**(行内具体 import / try-catch 结构)由主 session 写实现。**总行数上限 50**;超过说明应分多个 commit。

- [ ] **Task 3: 写 < 10 行 `toolExecution.ts` 增补**

  若 B Agent 已替换调度,主 session 不再改 toolExecution.ts;
  若 toolExecution.ts 顶部调度替换未生效(检查 B PR diff),主 session 补 `streamingExec` 集成行。

- [ ] **Task 4: 全量 verify gate**

  ```bash
  cd packages/zai-agent-core
  pnpm --filter @zn-ai/zai-agent-core typecheck
  pnpm --filter @zn-ai/zai-agent-core test
  ```

  期望:
  - typecheck 0 error
  - 全量 vitest 通过(resilience/a-* + b-* + c-* + d-* + e-*,以及存量所有 test)
  - auto-compact-turn-loop.test.ts 仍绿

- [ ] **Task 5: 手测 5 个场景**

  启动 zai server(开发模式 + 简单 prompt),手动验证:
  - 正常短会话通过(基线)
  - 注入 prompt_too_long → 触发 reactive path(runtime.error kind:'prompt_too_long')
  - 注入重复失败 tool → 触发 loopGuard(runtime.error kind:'tool_failure_loop')
  - 单 tool 长时间执行 → streaming parallel 起作用(观察 runtime.tool_call.parallel: true)
  - 设 agentStepLimit:5 → 第 6 turn break, runtime.done reason:'step-limit-reached'

  任一场景异常 → wire-in PR 修正,重新 task 2。

- [ ] **Task 6: commit + push wire-in PR**

  ```bash
  git add packages/zai-agent-core/src/runtime/queryLoop.ts
  git add packages/zai-agent-core/src/runtime/toolExecution.ts  # 若改动
  git commit -m "feat(zai-agent-core): wire-in 5 resilience modules (A/B/C/D/E)"
  git push origin <branch>
  ```

  PR 描述列出 5 sub-spec 链接 + verify gate 结果 + 手测场景清单。

---

## Spec ↔ Plan Coverage Self-Review

按 writing-plans skill 要求自评:

### Spec coverage

| Spec 章节 / 要求 | Plan 对应 Task |
|---|---|
| umbrella §3 架构 + wire-in 三步法 | Phase 0 + Phase 1 + Phase 2 |
| A §2.1 函数签名 + §3 行为 | Phase 1 §A Prompt + 测试 / verify gate |
| B §2.1 函数签名 + §3 行为 + toolExecution 改 | Phase 1 §B Prompt |
| C §2.1 函数签名 + §3 行为 + HookRunner 加字段 | Phase 1 §C Prompt |
| D §2.1 函数签名 + §3 行为 | Phase 1 §D Prompt |
| E §2.1 函数签名 + §3 行为 | Phase 1 §E Prompt |
| 5 sub-spec §4 测试点 | 每个 Agent prompt 里要求逐 case 写 |
| umbrella §5 测试路径前缀 | 5 Agent prompt 都要求 `test/integration/agent/resilience/{a,b,c,d,e}-*` |
| umbrella §6 verify gate | "Global Constraints" + 5 Agent prompt 都要求全跑 |
| umbrella §7 Agent 调度 | Phase 1 Step 1-4 |
| sub-spec E §2.2 schema:'tool-summary/v1' | §E Prompt 写了 ~/.zai/summaries/ + proper-lockfile |
| 集成 PR < 50 行 | Phase 2 Task 2 显式约束 |

### Placeholder scan

检查计划中无 `TBD` / `TODO` / `implement later` / `fill in details` / 隐性 placeholder:

- Phase 1 Task Step 描述 ✅ 全部为具体 action
- Phase 2 Task 1-6 ✅ 全部为具体 action
- 5 Agent Prompt 段 ✅ 全部 spec 引用 + 文件清单 + verify 命令

### Type consistency

umbrella spec §3.3 配置键表与 Agent Prompt 里列出的配置键一致。
umbrella spec §3.4 数据/事件契约(不引入新 RuntimeEvent)与 Agent Prompt 里"禁止"一致。
ErrorKind union 加 `tool_failure_loop | hook_blocked` 在 A spec 已固定,Prompt 让 A 不删改。
HookBlockedError 名与 C spec 一致。
StreamingToolExecutor 签名与 B spec 一致。
MemoryPrefetchHandle 签名与 D spec 一致。
SummaryStore 签名与 E spec 一致。

### 不在范围

umbrella §1.3 列的不在范围项,本 plan 均未触及(Stage 2-4 compaction、多 provider、CLI、frontend 等)。

---

## Plan 完成后下一步

按 writing-plans skill 终点 → 给用户两个执行选项:

1. **Subagent-Driven**(推荐)— 主 session 立即按 Phase 1 Step 1 派出 5 个 Agent
2. **Inline Execution**— 主 session 在当前 session 内逐 task 跑(规模过大不建议)

请告诉主 dispatcher 你选哪个。
