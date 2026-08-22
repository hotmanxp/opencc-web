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

（暂无）