# Batch 1 — dsh 运行时适配（**B1a 生命周期/模型 + B1b 事件/SSE**）

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> **状态**：✅ 已合入（commit `2191b48e`，2026-08-17）— G1 决策门验证通过（B1a + B1b 全部落地）
> 目标：dsh 轨道跑通**最小对话闭环**。**内部分 B1a（生命周期/装配/模型桥）与 B1b（事件翻译/SSE 接线）—— B1b 不阻塞 B2/B3/B4**，可延后合入。工具能力本批只放最小集（无权限副作用）。

---

## 1. 目标

- `agent.kernel='dsh'` 时，zai 能完成一次流式对话：输入 prompt → dsh Agent 运行 → 文本增量流回 SSE → 会话事件落盘。
- 事件翻译器 `SessionEventMap → KernelEvent` 建立**全量映射清单**（主计划 G2 修正：ServerEvent 实际 11 组，非 6 组）；B1b 需覆盖全部 11 组（核心子集先在 B1a 合入时交付，剩余可在 B1b 并入）。
- 模型选择桥接：zai 的 provider/model 配置能传导到 dsh 的 `installModelSelection`。
- 长驻 Cordis ctx 的 `shutdown()` 走 B-1 验证的 drain 顺序。

## 2. 前置条件

- B0（配置、KernelAdapter、dsh-bridge 骨架、createKernel 分叉 + 引擎检查）。
- B-1 尖峰已通过：长驻 Cordis teardown 实测，drain 顺序文档化。
- 盘点 dsh `SessionEventMap` 全量事件（`packages/core/session/src/known-event-types.ts` + agent-loop 事件），产出**11 组映射表初稿**（B1b 完成的输入）。

## 3. 任务清单（**B1a：生命周期/模型 — 主路径**）

### T1.1 dsh 长驻装配 createDshRuntime

- **做什么**：在 dsh-bridge 实现 `createDshRuntime({ dataDir, defaultCwd, defaultModel })`：
  - 用 Cordis `Context` 装载 headless 所需插件集（`dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-session-persistence-jsonl`、`dsh-tools`、`dsh-scope`、`dsh-agent-default-model`、`dsh-system-prompt`），**不**装载 Host/HTTP/浏览器插件（对齐 `dsh-headless` 的 bundle patch 思路）。
  - 通过 loader 或 `ctx.plugin()` 装配；**长驻**（不随单轮结束退出，替代 headless 的「run 完 exit」语义）。
  - 实现 `start()` / `shutdown()` 生命周期。`shutdown()` 走 B-1 验证的 drain 顺序（拒绝新请求 → flush 当前 turn → dispose Cordis ctx → 清 globalThis 桥）。
- **文件**：`packages/dsh-bridge/src/createDshRuntime.ts`、`src/plugins/`。
- **验收**：单测可启动/关闭 Cordis ctx；`sessions.flush` 能写盘；shutdown 显式清 globalThis 桥。

### T1.2 单轮驱动封装 run()（核心子集）

- **做什么**：KernelAdapter.run 的 dsh 实现：`agents.create({ sessionId, meta:{cwd}, agentOptions, setup })` → **首次 `await agent.whenIdle()`**（loader await）→ 记 `firstSeq = agent.session.seq` → `agent.followup(createUserMessage(...))` → `await agent.whenIdle()` → `sessions.flush`；把 `agent.session.events`（从起始 seq 起）产出为 `AsyncIterable<KernelEvent>`。
- **文件**：`packages/dsh-bridge/src/run.ts`。
- **验收**：headless 单测用例（参考 `packages/bundle/headless/tests/headless.spec.ts`）在长驻模式下等价通过；包含**首次 `whenIdle()`**（审查修正）。

### T1.3 事件翻译 sessionEvents.ts（核心子集 + 11 组映射表初稿）

- **做什么**：
  1. **核心子集映射**（B1a 必备）：
     - `turn/start` → `runtime.started`；`assistant/message`(text) → `runtime.delta`；`turn/end(reason.completed)` → `runtime.done`；`turn/end(reason.error)` → `runtime.error`。
  2. **11 组映射表初稿**：盘点 `SessionEventMap` 全量事件（含 `agent/tool-call`、`agent/tool-result`、`session/start`、`session/end`、`queue/*`、`projection/*` 等），逐项标注：映射到 `ServerEvent` 哪一组 / 是否透传 / 是否 `ignorable`。**未映射事件不得静默吞掉**——显式记录到忽略清单。
  3. tool 类事件（`agent/tool-call` / `agent/tool-result`）→ `runtime.tool_call` / `runtime.tool_result`（核心子集先做；完整映射留 B1b）。
- **文件**：`packages/dsh-bridge/src/translate/sessionEvents.ts` + `docs/events-map.md`（11 组映射表文档，**必填**）。
- **验收**：核心子集单测通过；11 组映射表文档化；未映射事件有显式清单。

### T1.4 模型选择桥接

- **做什么**：把 zai 的 provider/model 解析结果（`defaultModel`、`ANTHROPIC_*` env 语义、provider/model route overrides）映射到 dsh 的 `installModelSelection` + `agentOptions.provider/model`。
- **文件**：`packages/dsh-bridge/src/model.ts`。
- **验收**：dsh 轨道对话实际命中配置的 provider/model（测试中用可观测的模型名断言）。

## 3b. 任务清单（B1b：事件/SSE 接线 — 可后并入，**不阻塞 B2/B3/B4**）

> B1b 在 B1a 通过后启动，可与 B2/B3/B4 并行合入。

### T1.5 完整 11 组事件翻译 + KernelEvent 投射

- **做什么**：
  1. 完善 `translate/sessionEvents.ts`，按 11 组映射表补齐**所有非 `ignorable` 事件**的翻译（Runtime / Session / Job / Prompt / System / State / Instance / Queue / Command / StreamError / Projection）。
  2. **`patchTranscript` / `readTranscript`**（KernelAdapter）实现：替代现有 `compat/transcript/persistence.ts` 入口，从 dsh session log 重建。
  3. **`subscribeState` / `metrics`**（KernelAdapter）实现。
- **文件**：`packages/dsh-bridge/src/translate/`、`packages/dsh-bridge/src/transcript/`。
- **验收**：每组事件类型至少一个单测覆盖；`patchTranscript` / `readTranscript` 单测。

### T1.6 KernelAdapter.run 接线（含 abort）

- **做什么**：
  1. zai 侧 `routes/agent.ts` 的 prompt 路径在 `'dsh'` 模式下改走 `adapter.run()`，`translateRuntimeEvents` 仅用于 opencc 轨道；SSE 输出层复用。
  2. **abort 接线**（B1b 必需）：SSE 中断 / 客户端 disconnect 时调用 `adapter.abort()`（`agentRuntime.ts:260-267, 434-480` 现有 abort 路径需双轨覆盖）。
- **文件**：`packages/zai/src/server/routes/agent.ts`、`services/kernel/`。
- **验收**：`agent.kernel='dsh'` 下发起一次对话，前端可见流式输出；abort 触发后 dsh 侧 Agent 停止当前 turn（不残留 turn in-progress）。

### T1.7 会话元信息与列表

- **做什么**：`createSession` / `listSessions` 的 dsh 实现：dsh 会话元信息从隔离目录（`dsh-sessions/`）读取，映射为 `SessionMeta`（title/createdAt 等）。
- **文件**：`packages/dsh-bridge/src/sessions.ts`。
- **验收**：`/api/sessions` 在 dsh 轨道返回 dsh 会话列表。

## 4. 验收标准（G1 决策门）

1. **B1a**：`agent.kernel='dsh'`：输入一条 prompt，SSE 收到 `runtime.started → runtime.delta* → runtime.done`，文本落盘（核心子集）。
2. **B1b**：11 组事件翻译全部到位；abort 路径双轨覆盖；transcript 读/写通过。
3. opencc 轨道：`pnpm -r test` 相关用例绿，行为无变化。
4. 事件映射表文档存在（11 组全），未映射事件有显式清单。
5. dsh-bridge 单测覆盖装配/翻译/驱动/abort 四条路径。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh 长驻模式下 loader `await()` 语义与 headless 不同 | 参考 `dsh-headless` 的 `ctx.get('loader')?.await()`（headless/src/index.ts:99）；首次 `whenIdle()` 必加 |
| `SessionEventMap` 与 zai 事件命名差异大（11 组不是 6 组） | B1a 11 组映射表初稿先行文档化；B1b 完整对齐；B6 parity 必跑全 11 组 |
| `agents.create` 的 model selection 装配点（setup 回调）理解偏差 | 以 `dsh-headless` 的 `installModelSelection` 用法为模板（headless/src/index.ts:115-118） |
| shutdown 不显式 drain 导致 globalThis 残留 | B-1 尖峰定义 drain 顺序；T1.1 严格走该顺序；B0 T0.8 清理协议覆盖 |

## 6. 测试策略

- 单测：`packages/dsh-bridge/tests/`（装配、翻译映射（含 11 组）、run 闭环、abort、shutdown drain）。
- 集成：dsh 轨道真实对话一次（curl SSE / 本地 dev），人工确认流式输出。
- 回归：opencc 轨道 `routes/agent.ts` 相关单测（改动的接线处）。
- ego-browser：B1a 仅验证「dsh 轨道发起对话并看到回复」一条路径；B1b 补 abort / transcript 续读路径；其余场景 B6 全量。
