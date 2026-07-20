# zai 主循环鲁棒性补全 — Umbrella Spec

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-loop-resilience-master |
| 父 spec | — |
| 子 spec | [A](./2026-07-19-zai-loop-resilience-a-errors-design.md) · [B](./2026-07-19-zai-loop-resilience-b-streaming-tools-design.md) · [C](./2026-07-19-zai-loop-resilience-c-nudge-design.md) · [D](./2026-07-19-zai-loop-resilience-d-attachment-design.md) · [E](./2026-07-19-zai-loop-resilience-e-step-limit-design.md) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | 在 zai 主对话路径补足 5 类与 OpenCC 上游对齐的鲁棒性能力,由 5 个独立 Agent 并行落地 |
| 范围 | A / B / C / D / E |
| 不在范围 | F(Stage 2-4 compaction),继续按既有 `2026-07-19-zai-session-compaction-design.md` 推进 |
| 工作量 | 总计约 2-3 周有效工作量(5 Agent 并行各 3-5 天 + 集成 1 天) |

## 1. 背景与目标

### 1.1 问题陈述

zai 与 OpenCC 上游 `~/code/opencc/src/query.ts`(2760 行)在 queryLoop 能力上差异显著 — `zai-agent-core/src/runtime/queryLoop.ts` 仅 557 行,是上游 queryLoop 的"最小可移植内核"。

下表列出 **仍待补的关键能力**(Stage 1 主动压缩已交付,不含在此):

| 集 | 能力 | OpenCC 上游位置 | zai 现状 |
|---|---|---|---|
| A | 错误分类 + max_output_tokens recovery + tool 死循环防护 | `query.ts` 中 `FallbackTriggeredError` / withheld / `tryReactiveCompact` / loop guard | ❌ 直接抛 `runtime.error` |
| B | Streaming tool execution(并行) | `StreamingToolExecutor` (q.ts:1035) + `tengu_streaming_tool_execution_used` | ❌ 仅串行 `executeToolsStreaming` |
| C | Stop hook 阻断 + 续接 nudge | `handleStopHooks` (q.ts:2071) + `analyzeContinuationIntent` + 20 次 nudge | ❌ Hook 不阻断 + 无 nudge |
| D | Mid-turn attachment + memory prefetch | `getAttachmentMessages` + `pendingMemoryPrefetch` | ❌ 不接入 |
| E | Agent step limit + tool summary | `agentStepLimit` + `generateToolUseSummary` (q.ts:2536) | ❌ `maxTurns` 默认无上限 |

**后果**:zai 用户在长会话(>200k)、偶发 413、网络抖、断流等场景下,**无自愈能力**,任何错误都会立即传到前端,只能靠用户手动 /compact 或新建会话。

### 1.2 目标

让 zai 主对话路径在以下 5 类场景具备与 OpenCC 上游相当的鲁棒性:

1. **可重试错误自动恢复**:429 / 5xx / max_output_tokens / 网络抖动
2. **长 tool 流并行化**:模型 stream 期间并行跑已闭合 tool_use,降低端到端延迟
3. **Hook 主动阻断 + 模型停摆 nudge**:可观测的 loop 行为
4. **Mid-turn 附件合并**:后台 / agent / 技能 prefetch 成果可注入下一轮
5. **可配置 step 上限**:防止失控工具串联死循环

### 1.3 不在范围

- **F. Stage 2-4 compaction**:已有 `2026-07-19-zai-session-compaction-design.md`,本次不动。
- 多 provider 适配、CLI REPL、前端 SSE 透传层改动、prompt cache 复用、PTL 自愈、api microcompact(`context_management.edits`)、tool_result 历史截断 — 均已在上游既有 spec 或决策中排除。

## 2. 关键决策

| 决策项 | 决定 |
|---|---|
| 交付形式 | 1 个 umbrella + 5 个独立 sub-spec |
| Spec 粒度 | Contract-level:锁定函数签名 + 行为 + 测试点 + 边界,**实现细节由 Agent 自由** |
| 实现路径 | 每个子项目只动自己目录下的新文件;**不修改 `queryLoop.ts`** |
| Wire-in 集成 | 由 orchestrator 在 5 个 PR 完成后做一次性 < 50 行集成,**不属于 5 Agent 范围** |
| 并发调度 | 一次性并行启动 5 个 Agent,互不通讯;verify gate 后合 5 PR |
| 数据 / 事件契约 | 不引入新 `RuntimeEvent` 类型;允许在既有事件 payload 增加字段 |
| 配置键 | 集中在本 spec §4 冻结,5 sub-spec 引用,**新增必须回本 spec 复议** |
| Verify gate | `pnpm --filter @zn-ai/zai-agent-core typecheck && pnpm --filter @zn-ai/zai-agent-core test` |
| 存量保护 | 现有测试,尤其 `auto-compact-turn-loop.test.ts`,不得退化 |
| 与 OpenCC 上游关系 | 新增模块不进 `opencc-internals/`,仅放 `src/runtime/{errors,streaming,nudge,attachment,summary}/` |
| 失败行为 | 任一 Agent verify 失败 → 集成阶段阻塞,不影响其它子项目单独 PR |

## 3. 架构

### 3.1 系统全图

```
┌─────────────────────────────────────────────────────────────────────────┐
│           runtime/queryLoop.ts (本次零修改)                             │
│                                                                           │
│   ┌──────────────────────── turn loop ─────────────────────────────┐  │
│   │ while (turn < maxTurns) {                                       │  │
│   │                                                                  │  │
│   │   ── D ── getAttachmentMessages(sessionId)  ← mid-turn attachment│  │
│   │   ── D ── startRelevantMemoryPrefetch(sessionId, signal)  ← prefetch│  │
│   │                                                                  │  │
│   │   for-await modelCaller({...})                                  │  │
│   │     │  ── A ── 流式错误 classification(命中 withheld 不 yield)   │  │
│   │     │  ── B ── 闭合 tool_use 一路 推给 StreamingToolExecutor   │  │
│   │     └─ accumulate text / thinking / tool_use                    │  │
│   │                                                                  │  │
│   │   ── C ── analyzeContinuationIntent(text, lastBlock)            │  │
│   │   ── E ── step counter: if (turn > stepLimit) force-summary msg │  │
│   │                                                                  │  │
│   │   ── A ── tryRecoverMaxOutputTokens / reactive compact          │  │
│   │   ── A ── detectToolFailureLoop(toolId)  ← break if looped      │  │
│   │                                                                  │  │
│   │   ── C ── HookRunner.run('Stop', ..., blocking: true)           │  │
│   │   └─ break / continue via Stop hook decision                    │  │
│   │                                                                  │  │
│   │   ── B ── StreamingToolExecutor.drain()  ← 并行 tool_result    │  │
│   │   ── E ── generateToolUseSummary(toolResult)  ← fire-forget     │  │
│   │                                                                  │  │
│   │   ── C ── if analyzeContinuationIntent == needs-tool            │  │
│   │        injectContinuationNudge(events)  ← 强制下一轮            │  │
│   │                                                                  │  │
│   │   toolExecution.ts 内部:                                       │  │
│   │     └─ B ── StreamingToolExecutor.submit() 替代串行调度        │  │
│   │                                                                  │  │
│   │ }                                                                 │  │
│   └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌──── 新增目录(每个子项目独占) ────┐
│  runtime/errors/         ← A    │
│    classification.ts             │
│    maxOutputTokens.ts            │
│    loopGuard.ts                  │
│    reactiveCompact.ts            │
│  runtime/streaming/       ← B    │
│    streamingToolExecutor.ts      │
│    types.ts                      │
│  runtime/nudge/           ← C    │
│    analyze.ts                    │
│    inject.ts                     │
│  runtime/attachment/      ← D    │
│    get.ts                        │
│    prefetchMemory.ts             │
│  runtime/summary/         ← E    │
│    stepCounter.ts                │
│    toolUseSummary.ts             │
└────────────────────────────────────┘

┌──── 改动的现有文件(契约冻结后,各 Agent 仅改这一行边界内) ────┐
│  plugins/HookRunner.ts  ← C (扩展 Stop-hook 阻断字段)        │
│  runtime/toolExecution.ts  ← B (替换串行为 streaming 调度)  │
│  tools/BashTracker  ← D (AttachmentMessages 入口可能复用)    │
│  tools/Tasks/TaskListStore  ← E (step counter 持久化)        │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 Wire-in 三步法(集成 PR 阶段,不在 5 Agent 范围)

| 步骤 | 介入方 | 变更 |
|---|---|---|
| 1. **签名冻结 PR** | 5 Agent 落地前 | umbrella + 5 spec 合并到主干;`RuntimeEvent` / `HookRunner` / `toolExecution` 公共签名如有任何变动 — 不允许(契约冻结) |
| 2. **5 Agent 落地 PR** | 5 sub-spec Agent | 各自按 spec 实现,**互不依赖、不交叉 review**。Verify gate 自验,产出 PR |
| 3. **集成 PR**(单独发) | 主 orchestrator(人) | 在 `queryLoop.ts` / `toolExecution.ts` 顶端加 < 50 行的 wire-in 调用序列,串 5 个模块 |

> 关键:spec 内必须明确写出 wire-in 接线点位置、调用顺序、错误吞咽 / 异常向上路径;集成 PR 不需要重新设计,直接照 spec 接线即可。

### 3.3 共享 RuntimeConfig 键(一次性在 umbrella 冻结)

| 配置键 | 类型 | 默认 | 读方 |
|---|---|---|---|
| `config.runtime.maxOutputTokensRecoveryAttempts` | number | 3 | A |
| `config.runtime.toolFailureLoopMaxConsecutive` | number | 3 | A |
| `config.runtime.streamingToolExecution` | `'on' \| 'off'` | `'on'` | B |
| `config.runtime.continuationNudgeMax` | number | 20 | C |
| `config.runtime.continuationNudgeEnabled` | boolean | true | C |
| `config.runtime.agentStepLimit` | number \| undefined | undefined | E |
| `config.runtime.attachmentPrefetchEnabled` | boolean | true | D |
| `config.runtime.memoryPrefetchWindow` | number(ms) | 1500 | D |
| `config.runtime.toolUseSummaryEnabled` | boolean | true | E |

**契约**:5 sub-spec 各自的配置键由本 spec 一次性定义并冻结。sub-spec 在 §X 配置小节引用,**不得新增未在本 spec 列出的新 key**。如确需新增 → 回本 spec 复议。

### 3.4 数据/事件契约(冻结)

- 不引入新 `RuntimeEvent` 类型:5 个子项目全部沿用 `runtime.error` / `runtime.delta` / `runtime.tool_call` / `runtime.tool_result` / `runtime.done` / `runtime.aborted` 现有 union。
- 可补充字段(允许):
  - 在现有 `runtime.error` payload 增加 `kind: ErrorKind` 字段(由 A 引入,sub-spec A 详)
  - 在现有 `runtime.tool_call` payload 增加 `parallel: boolean`(由 B 引入)
- 不修改 `RuntimeEvent` 联合类型本身(zod discriminatedUnion 头不变,前端 `useAgentStore` 的 `applyRuntimeEvent` 不需改)。

## 4. 错误处理原则

| 错误类别 | 在哪里吞咽 | 在哪里抛 |
|---|---|---|
| **可重试错误**(rate_limit, retry-able 5xx, max_output_tokens) | A 集内部 | wire-in 套外层(A → `runtime.error` w/ `recovered:true`) |
| **不可重试错误**(auth, validation, prompt_too_long via context_overflow) | wire-in 不吞,转 `runtime.error` w/ `kind:<x>` | 由前端 toast 展示 |
| **Hook 阻断**(C 的 Stop-hook blocking) | hook 抛 `HookBlockedError`(见 [C §2.1](./2026-07-19-zai-loop-resilience-c-nudge-design.md)) | wire-in 捕获 → yield `runtime.error` w/ `kind:'hook_blocked'` + 跳出 loop |
| **模型流式错误**(stream chunk 后 fatal) | A 集 internal `withheld` 收集 | 流结束后 → reactive path 分发 |
| **Continuation nudge 注入失败**(C) | log warn,不抛 | 跳过本轮 nudge,继续 loop |
| **Tool execution 抛出未捕获** | A.detectToolFailureLoop 计数 | 超出 max → 强制 `runtime.error` + break |

## 5. 测试策略

测试位置约定:

```
packages/zai-agent-core/test/integration/agent/resilience/
├── a-error-classification.test.ts        ← A
├── a-max-output-tokens-recovery.test.ts   ← A
├── a-tool-failure-loop-guard.test.ts      ← A
├── b-streaming-tool-execution.test.ts     ← B
├── c-continuation-nudge.test.ts           ← C
├── c-stop-hook-blocking.test.ts           ← C
├── d-attachment-messages.test.ts          ← D
├── d-memory-prefetch.test.ts              ← D
├── e-agent-step-limit.test.ts             ← E
└── e-tool-use-summary.test.ts             ← E
```

- 每个 test 用 stub modelCaller / fake runtimeEvent stream(参考 `auto-compact-turn-loop.test.ts` 的 fakeStream 写法)。
- 每个 test 最大 100 行,覆盖 spec 中列出的测试点(每个测试点至少一个 test)。
- 不动存量测试。

## 6. Verify gate(冻结)

按以下顺序执行,**全部通过才视为集成完成**:

1. `pnpm --filter @zn-ai/zai-agent-core typecheck` — 严格 0 错
2. `pnpm --filter @zn-ai/zai-agent-core test` — 全量 vitest 通过,无 skipped(recovery 类用例除外)
3. 5 sub-spec 各自新加的 test 文件 100% 通过
4. 手工 wire-in 集成 PR 后,所有现存 e2e / 集成测试不退

## 7. Agent 调度(orchestrator 实施阶段)

5 Agent 在 sub-spec 锁定后由主 session dispatch:

| 任务 | 工作目录 | 文件 |
|---|---|---|
| **A. error classification + recovery + loop guard** | `packages/zai-agent-core/src/runtime/errors/` + `test/integration/agent/resilience/a-*` | §3 §4 (sub-spec A) |
| **B. streaming tool executor** | `runtime/streaming/` + `test/.../b-*` | §3 §4 (sub-spec B) |
| **C. continuation nudge + Stop-hook blocking** | `runtime/nudge/` + `test/.../c-*` | §3 §4 (sub-spec C) |
| **D. mid-turn attachment + memory prefetch** | `runtime/attachment/` + `test/.../d-*` | §3 §4 (sub-spec D) |
| **E. agent step limit + tool use summary** | `runtime/summary/` + `test/.../e-*` | §3 §4 (sub-spec E) |

调度约定:

- 每 Agent 配 sonnet/opus;`run_in_background:true`(默认)
- 5 Agent 同时起动,**互不通讯**
- 每个 Agent prompt = "读对应 sub-spec,按 contract 实现 + 写测试 + 自跑 verify gate"
- 主 session 收齐 5 result 后再起集成 PR

## 8. 与 OpenCC 上游 sync-from-opencc 的关系

- 5 个新增子项目**不进 `opencc-internals/`**,仅放 `src/runtime/{errors,streaming,nudge,attachment,summary}/`(直接 zai 内部干净实现,不 vendor opencc)
- `opencc-internals/foldTopLevelToolUses.ts` 等已 vendor 的不动
- 下次 sync-from-opencc 同步上游 opencc 时,如果上游引入同能力,由 sync-from-opencc 维护者决定是否替换;**本次不强制**

## 9. 风险与边界

1. **wire-in 阶段冲突**:5 Agent 都不改 queryLoop.ts,集成 PR 由人统一改;若某个 Agent 提前不小心改了 → 该 PR 单独 reject。
2. **Stage 1 不可用**:A 集 reactive compact 部分允许 stub(`kind:'unimplemented'`),集成 PR 阶段说明何时接。
3. **`Anthropic.APIError` SDK 字段名差异**:sub-spec A 需用 duck typing(`typeof err.status === 'number'`)。
4. **streaming tool 并发上限**:sub-spec B 需定义 max parallel(默认 4,config 可调)。
5. **Stop hook 阻断语义**:sub-spec C 需明确"阻断 = 当前 turn 不再送 model,直接 yield error" 与 OpenCC 一致。

## 10. 不锁定(实现细节由 Agent 决定)

| 项 | 备注 |
|---|---|
| 文件命名 / 内部模块拆分 | Agent 决定,只要 export 符合 contract |
| 实现用 class vs function | 自由 |
| 并发模型(promise / queue / scheduler) | 自由 |
| 测试用 stub / mock / fake | 自由 |
| 错误码到字符串映射 | 自由(只要 export 符合 schema) |

## 11. 子 spec 索引

| ID | 文档 | 主要问题 |
|---|---|---|
| A | [zai-loop-resilience-a-errors-design](./2026-07-19-zai-loop-resilience-a-errors-design.md) | 错误分类 + max_output_tokens 自愈 + tool 死循环防护 |
| B | [zai-loop-resilience-b-streaming-tools-design](./2026-07-19-zai-loop-resilience-b-streaming-tools-design.md) | Streaming tool execution |
| C | [zai-loop-resilience-c-nudge-design](./2026-07-19-zai-loop-resilience-c-nudge-design.md) | Stop hook 阻断 + continuation nudge |
| D | [zai-loop-resilience-d-attachment-design](./2026-07-19-zai-loop-resilience-d-attachment-design.md) | Mid-turn attachment + memory prefetch |
| E | [zai-loop-resilience-e-step-limit-design](./2026-07-19-zai-loop-resilience-e-step-limit-design.md) | Agent step limit + tool use summary |
