# dsh 已知差异清单 — B6 T6.5

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](./superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)
> 所属批次：[2026-08-17-dsh-kernel-batch-06-parity-acceptance.md](./superpowers/plans/2026-08-17-dsh-kernel-batch-06-parity-acceptance.md) § T6.5
> 状态：G2 决策门输入（**每条差异必须带处置结论**）

本文汇总 B1a-B5 各批识别的「dsh 与 opencc 行为不一致」条目，每条标注来源批次 / 影响 / 可接受性 / 处置。G2 评审逐条过。任何新发现的差异必须登记到本表后再标记为「known」（与 `packages/zai/test/kernel/parity/harness.ts` 的 `KNOWN_DIFFERENCES` 双向引用）。

---

## 差异 ID 索引

| ID | 类别 | 影响事件类型 | 来源批次 | 处置 |
|----|------|-------------|---------|------|
| [dsh-001](#dsh-001-工具-schema-差异) | 工具 schema | `runtime.tool_call` / `runtime.tool_result` | B2 | 文档化 + 补丁 |
| [dsh-002](#dsh-002-事件时序差异) | 事件时序 | `runtime.started` / `runtime.done` | B1b | 文档化 |
| [dsh-003](#dsh-003-压缩差异) | 压缩 | `runtime.compacted` | B3 | 文档化 + dsh 上游跟踪 |
| [dsh-004](#dsh-004-嵌套子-agent-差异) | 嵌套子 agent | `runtime.delta` | B5 | 文档化 |
| [dsh-005](#dsh-005-插件兼容性差异) | 插件兼容 | `app.update.*` | B5 | 待 dsh 上游 |
| [dsh-006](#dsh-006-dsh-版本兼容性差异) | dsh 版本 | `server.connected` | B0 | 版本绑定 |
| [dsh-007](#dsh-007-stream-error-差异) | 流错误 | `stream/error` | B1b | 文档化 |
| [dsh-008](#dsh-008-projection-watermark-差异) | 派生投影 | `session/projection` | B3 | 文档化 |
| [dsh-009](#dsh-009-双轨接口未接线) | 集成缺口 | 全部 opencc 路由 | Phase 4.3 drill | B7 flip-and-cleanup |
| [dsh-010](#dsh-010-事件翻译-run-未真实) | 事件翻译 | `ServerEvent` 全 11 组 | Phase 2.2 | B7 flip-and-cleanup |
| [dsh-011](#dsh-011-子代理能力接缝替代) | 子 agent | subagent 行为 | Phase 3.1 | dsh-subagent 上游发布后切换 |
| [dsh-012](#dsh-012-cordis-插件形态未重构) | 架构 | 全部 | 主计划 §3.2.1 | 推迟到 B7.5 |

---

## dsh-001 工具 schema 差异

**类别**：工具 schema  
**影响事件类型**：`runtime.tool_call` / `runtime.tool_result`  
**来源批次**：B2（工具与 MCP 桥）

**描述**：dsh 对 tool 输入做严格 JSON Schema 校验（基于 `@deepseek-ai/dsh-tools` 的 zod schema）；opencc 侧校验宽松，对缺失字段 / 类型不匹配 fallback 到原始字符串输入。

**实际影响**：
- 同一 prompt 在两轨道可能得到不同 tool_result：dsh 因 schema 校验失败返回 `runtime.error`（带 `toolUseId`），opencc 拿到部分字段仍执行。
- 前端 ToolCallBlock 在 dsh 侧更频繁进入 error 态。

**可接受性**：✅ 可接受。严格校验是更好的默认行为（避免 silent corruption）；error 事件已带 `toolUseId`，UI 可正常显示。

**处置**：
- 文档化（本文 + `packages/zn-agent-core/src/opencc-src/tools/` 注释）
- 计划补丁：在 opencc 侧补 zod schema 校验（与 dsh 对齐）— 独立批次，不在 B6 混

---

## dsh-002 事件时序差异

**类别**：事件时序  
**影响事件类型**：`runtime.started` / `runtime.done`  
**来源批次**：B1b（11 组事件翻译）

**描述**：dsh 的 `runtime.started` 在 `turn/start` 事件抵达时立即 emit；opencc 的 `runtime.started` 在 LLM 第一次 chunk 抵达时才 emit。`runtime.done` 时序同理 — dsh 在 `turn/end` 触发，opencc 在 LLM SSE 流末尾触发。

**实际影响**：
- 前端 `setStatus('thinking')` 状态切换：dsh 更快但 `runtime.delta` 之前的「等待」窗口可能更短。
- metrics 计数（`apiRequestCount` / `contextTokens`）：opencc 在 `runtime.done` 一次刷新；dsh 在 `runtime.started` 就推送 — 已在 B1b 注释中标注（zai patch 2026-08-09）。

**可接受性**：✅ 可接受。`runtime.started` 推送提前让前端更快显示「已接收」状态；差异在 UI 上不感知。

**处置**：文档化（注释 + 本文）。无补丁。

---

## dsh-003 压缩差异

**类别**：压缩  
**影响事件类型**：`runtime.compacted`  
**来源批次**：B3（会话与记忆）

**描述**：dsh 走 `compaction` capability（`@deepseek-ai/dsh-session` 内置），参数化 `preTokens / postTokens / savedTokens`。opencc 走 vendor 的 compaction bridge（`compat/runtime/compactionBridge.ts`），`trigger: 'auto' | 'manual'` 与 dsh capability 触发条件不完全对齐。

**实际影响**：
- dsh 自动压缩阈值更激进（默认 60% context 占满即触发），opencc 默认 80%。
- 压缩后 turn 数计法：dsh 按 `session/events` log 长度；opencc 按 transcript jsonl 行数。

**可接受性**：⚠️ 部分可接受。阈值差异导致用户感知「dsh 更频繁压缩」；需文档化但不强制对齐（dsh 上游不接受 patch）。

**处置**：
- 文档化（本文 + `packages/dsh-bridge/src/sessions/` 注释）
- dsh 上游跟踪：https://github.com/deepseek-ai/dsh（capability 调优）
- zai 配置项：`session.compactionThreshold`（未来批次）

---

## dsh-004 嵌套子 agent 差异

**类别**：嵌套子 agent  
**影响事件类型**：`runtime.delta`  
**来源批次**：B5（多 Agent 与插件）

**描述**：dsh 嵌套子 agent 文本流回声：父 session 的 `runtime.delta` 在子 agent 输出时会附带前缀（如 `[subagent: foo]`）；opencc 不做前缀。

**实际影响**：
- 前端 `MessageBubble` 渲染时 dsh 多显示前缀文本。
- transcript jsonl 中：opencc 一行 `assistant` 一段文本；dsh 一行 `assistant.message` 含 prefix。

**可接受性**：✅ 可接受。前缀是有用上下文（用户能看出「这是子 agent 说的」）。

**处置**：文档化（本文）。无补丁。

---

## dsh-005 插件兼容性差异

**类别**：插件兼容  
**影响事件类型**：`app.update.*`（plugin 检查 / 安装流程）  
**来源批次**：B5

**描述**：dsh 不支持 zai 自定义 plugin 命令生命周期事件（`command.run` / `command.done` 对 dsh plugin 命令可能不触发，因为 dsh 走自身 plugin runtime，不走 `/api/agent/command`）。`app.update.*` 流程由 zai 自身处理，与 dsh 无关 — 但 dsh 模式下 plugin 元数据扫描时机与 opencc 不同。

**实际影响**：
- 第三方 plugin（含 chrome-devtools-mcp 等 LSP/MCP 类）的 `command.run` 埋点在 dsh 模式下可能不触发。
- `app.update.checking` 在 dsh 模式仍触发，但 plugin 自身的 update 检测依赖其内部 scheduler。

**可接受性**：⚠️ 部分可接受。plugin 兼容性需在 B7 决策门评估「哪些 plugin 必须 dsh 兼容」。

**处置**：
- 待 dsh 上游（plugin host 集成）
- zai 内部：保留 plugin manifest 兼容层（`packages/dsh-bridge/src/plugins/`）

---

## dsh-006 dsh 版本兼容性差异

**类别**：dsh 版本  
**影响事件类型**：`server.connected`  
**来源批次**：B0（基线）+ B6（锁定）

**描述**：dsh 版本固定为 `0.1.0-rc.7`（通过 `save-exact` 锁定，`@zn-ai/dsh-bridge.DSH_VERSION = '0.1.0-rc.7'`）。升级前不提供兼容性承诺 — 不同版本的 `SESSION_FORMAT_VERSION=0`（实际值）可能产生不兼容 log。

**实际影响**：
- 迁移工具（T6.3）必须绑定版本：迁移前校验 `targetDshVersion === installed('@zn-ai/dsh-bridge').DSH_VERSION`，不一致报错。
- 升级走独立批次；不在 B6 混。

**可接受性**：✅ 当前可接受。dsh 0.1.0-rc.7 是当前唯一稳定版本；锁定避免破坏 log。

**处置**：
- `save-exact` 锁定版本（已在 B0 实施）
- 升级走独立批次流程：测试 → 评估 dsh 上游变更 → 升级 dsh-bridge → 重新跑迁移工具单测

---

## dsh-007 stream/error 差异

**类别**：流错误  
**影响事件类型**：`stream/error`  
**来源批次**：B1b

**描述**：dsh 在 transient 错误（529 / 5xx）时倾向 retry 而非关闭 stream；opencc 在某些场景会立即 emit `stream/error` 并断连。`RpcErrorCode` 枚举对齐，但 dsh 主动 emit 频次更低。

**实际影响**：
- 前端 SSE 客户端：dsh 重连次数更少（更稳）。
- 错误处理：dsh 把 recoverable error 推 `runtime.retrying` 而不是 `stream/error`。

**可接受性**：✅ 可接受。retry 优先是更好的默认。

**处置**：文档化。无补丁。

---

## dsh-008 projection watermark 差异

**类别**：派生投影  
**影响事件类型**：`session/projection`  
**来源批次**：B3（会话与记忆）

**描述**：dsh 派生事件（projection）推送频率更高 — dsh session 的派生事件按 turn 推送；opencc 按 SSE 写时机推送。`seq` 仍 higher-seq-wins 合并。

**实际影响**：
- 前端 `useAgentStore` 接收 projection 事件频率高 — UI 抖动可能略增（已用 React.memo 隔离）。

**可接受性**：✅ 可接受。频率高但 watermark 正确，UI 抖动已被 React 渲染层处理。

**处置**：文档化。无补丁。

---

## 附录 A — 与 parity harness 双向引用

`packages/zai/test/kernel/parity/harness.ts` 的 `KNOWN_DIFFERENCES` 常量与本文 ID 一一对应：

```ts
export const KNOWN_DIFFERENCES = {
  'dsh-001-tool-schema': { ... },
  'dsh-002-event-timing': { ... },
  'dsh-003-compaction': { ... },
  'dsh-004-nested-subagent': { ... },
  'dsh-005-plugin-compat': { ... },
  'dsh-006-version-compat': { ... },
  'dsh-007-stream-error': { ... },
  'dsh-008-projection-watermark': { ... },
}
```

新增差异时：
1. 在本文添加条目
2. 同步 `KNOWN_DIFFERENCES` 常量
3. 在 parity harness 添加对应 scenario（如需）

---

## 附录 B — 升级 / 新增差异处理流程

发现新差异时：
1. **记录**：在本文「附录 C 候选差异」追加草稿条目
2. **复现**：写最小 parity scenario 复现双轨差异
3. **判定**：
   - 「可接受」+ 「文档化」→ 直接落到本文正式条目
   - 「不可接受」+ 「补丁」→ 写补丁进入对应批次
   - 「不可接受」+ 「上游」→ dsh 上游 issue + 状态标注
4. **回归**：跑 `pnpm --filter @zn-ai/zai test test/kernel/parity/parity.test.ts` 验证

---

## 附录 C — 候选差异

> 待评估 / 待上游反馈的差异。

### dsh-009 双轨接口未接线（KERNEL_FACTORY_INTEGRATION 缺口）

**类别**：集成缺口
**影响事件类型**：全部 opencc 路由（`/api/agent/:id/run`、`/api/event`）
**来源批次**：Phase 4.3 kill switch drill 第四轮
**影响**：dsh 模式启动但 routes/agent.ts 仍走 opencc 的 `getRuntime().query()`；`agentRuntime.ts:initAgentRuntime()` 仍调 `createOpenccRuntime()` 而非 `createKernel(cfg)`。
**可接受性**：**不可接受**（双轨未真正分叉）
**处置**：B7 flip-and-cleanup 阶段必须关闭：
1. `agentRuntime.ts:initAgentRuntime()` 改为 `createKernel({cwd, dataDir, settings})`
2. `routes/agent.ts:prompt` 路径改为 `adapter.run()`
3. `translateRuntimeEvents` 移出 routes/agent.ts 到 services/translation.ts
4. 保留 `getRuntime()` 作为 opencc adapter 的 alias（兼容既有调用点）

**单测引用**：`scripts/kill-switch-drill.sh` 跑通（Phase 1.4 修 bash syntax）后 Phase 3 SSE 仍 404 — 验证此 gap 客观存在。

**✅ RESOLVED (2026-08-22)**：B7 flip-and-cleanup 完成。
- `agentRuntime.ts:initAgentRuntime()` 改走 `createKernel({cwd, dataDir, settings})`，按 `agent.kernel` 配置分叉 opencc / dsh adapter。
- `routes/agent.ts:prompt` 改走 `getKernelAdapter().run({session, prompt, model, permissionMode, providerOverride, providerId, mainAgent, abortSignal, isMeta})`。
- `translateRuntimeEvents` 移出 routes/agent.ts 到 services/translation.ts,opencc factory.run() 内部闭合 vendor query() + 翻译。
- `getRuntime()` 保留,opencc 模式返回底层 OpenccRuntime(backgroundRuntime.ts 等 vendor-aware 调用点兼容);dsh 模式 throw 引导用 `getKernelAdapter()`。
- `backgroundRuntime.ts` dsh 模式跳过(DefaultBackgroundRuntime 走 vendor OpenccRuntime.query;dsh 子任务自实现)。
- `routes/sessionState.ts:97` 的 `getBackgroundRuntime()` 同步 throw 包成 `Promise.resolve().then(...)` 让 .catch 捕获。
- `scripts/kill-switch-drill.sh` 把 `/api/events` 修正为 `/api/event`(路由真实名称),Phase 3 SSE 接入从 404 改为 200。
- 单测 mock:`agent.test.ts` / `bashNotifier.test.ts` / `agent.queue.test.ts` / `instance-supervisor-wiring.test.ts` / `agent-runtime-server.test.ts` 改用 `getKernelAdapter()` 形态。
- typecheck 3/3 workspace 全绿;`pnpm -r test` 2629 通过 + 26 跳过(与 handoff 基线一致);kill switch drill 8/8 phase ✅ PASS。

---

### dsh-010 `opencc factory.run()` 真实接线推迟

**类别**：事件翻译
**影响事件类型**：`ServerEvent` 11 组中由 `opencc factory.run()` 产出的子集（核心 4 组：Runtime / Session / Tool / State）
**来源批次**：Phase 2.2 真实接线范围调整
**影响**：`KernelAdapter.run()` 在 opencc 轨道仍 stub；生产代码 routes/agent.ts 走 vendor `getRuntime().query()` 直连，绕过 adapter。dsh factory.run() 已用 `bridge.runOnce()` 真实接线，但与 routes/agent.ts 的集成不在本次范围。
**可接受性**：**不可接受**（双轨分叉未对齐 KernelAdapter 抽象）
**处置**：B7 flip-and-cleanup 阶段执行：
1. 把 `translateRuntimeEvents` (432 行) 移出 `routes/agent.ts` 到 `services/translation.ts`
2. `opencc factory.run()` 改为 `runtime.query({...})` + 复用 services/translation.ts
3. routes/agent.ts 改用 `adapter.run()` 统一接口
4. 双轨 prompt 路径才真正经 KernelAdapter 抽象

**单测引用**：`packages/zai/src/server/services/kernel/factories/opencc.test.ts` smoke 已就位；run() 真实接线需 flip-and-cleanup。

**✅ RESOLVED (2026-08-22)**：与 dsh-009 同步关闭,见上文 commit。
- `opencc factory.run()` 实现:`runtime.query({prompt, cwd, sessionId, abortSignal, model, permissionMode, providerOverride, providerId, mainAgent, isMeta})` → `translateRuntimeEvents()` → yield ServerEvent。
- `KernelAdapter.run()` 扩展 opts 涵盖原 vendor-aware 字段 + `isMeta`(BashNotifier 用)。
- dsh factory.run() 接受扩展 opts 但不消费(0.1.0-rc.7 仅支持 string prompt;abortSignal / permissionMode / mainAgent 留 stub)。
- routes/agent.ts 与 bashNotifier 统一走 adapter.run(),双轨 prompt 路径完全经 KernelAdapter 抽象。

---

### dsh-011 子代理能力接缝替代

**类别**：子 agent / 多 agent  
**影响事件类型**：`subagent/descriptor`、`tool-workflow/*` 派生事件  
**来源批次**：Phase 3.1 dsh-subagent 自实现  
**影响**：上游 `@deepseek-ai/dsh-subagent` 包未发布（verified via `node_modules/@deepseek-ai/`，仅 dsh-scope 可用）。当前用 `dsh-scope` 的 `createScope` + `bindScopeParent` + `ScopedLayers.effect` 自实现父子 ScopedLayers 隔离。  
**可接受性**：**有条件可接受**（行为对齐 zai BackgroundRuntime + ScopedLayers 父子继承）  
**处置**：保持自实现。dsh-subagent 上游发布后切换（独立批次），届时 `spawnDshSubagent` 改为直接调 upstream capability seam。  
**单测引用**：`packages/dsh-bridge/test/skeleton.test.ts` Phase 3.1 段覆盖 `createDshSubagentScope` 签名与 scopeKey 形态。

---

### dsh-012 Cordis 插件形态重构推迟

**类别**：架构  
**影响事件类型**：全部（plugin tree 拓扑）  
**来源批次**：主计划 §3.2.1 — 推迟到 B7.5（full-plan-realization 不执行）  
**影响**：当前 `packages/dsh-bridge/src/` 扁平结构（`tools/`、`state.ts`、`abort.ts` 等直接导出函数 + 类），与主计划 §3.2.1 描述的 `src/plugins/zai-*` Cordis 插件形态不一致。可工作但**插件隔离/扩展性弱**：所有 dsh-bridge 能力都是模块级 export，调用方显式 import；不是 Cordis `ctx.plugin(Plugin, Config)` 形态。  
**可接受性**：**可接受**（双轨真实化优先已交付，结构对齐可后续）  
**处置**：G2 通过、默认内核翻转稳定后另立 **B7.5 独立批次**：
1. 把 `src/tools/bash.ts` 的 `LocalShellExecutor`/`Win32ShellExecutor` 重构为 `zai-tools-core` Cordis plugin
2. 类似地拆 `state.ts` → `zai-state-bridge`、`abort.ts` → `zai-abort`、`commands/index.ts` → `zai-slash-commands` 等
3. 改造 createDshRuntime 走 `ctx.plugin(zaiXxx, {config})` 装载而非 import
4. opencc 工厂对齐调用方式

**单测引用**：`packages/dsh-bridge/IMPLEMENTATION_STATUS.md §3.2.1` 推迟说明 + 本文件 dsh-012。