# Plan — Agent 工具同步 DSH `tool-subagent` / `tool-subagent-control` / `tool-subagent-report` 的 model-facing surface

**Status**: Draft
**Date**: 2026-08-30
**Trigger**: deepseek-harness 0.1.2-alpha.2 上游同步后,subagent 重构为 6 provider + 3 tools 的能力栈;zai 当前 model-facing 工具的 surface 与上游 tool-subagent / tool-subagent-control / tool-subagent-report 存在差距
**目标**: 把 DSH 三个 model-facing subagent 工具的 capability / description / schema / output / attribution / delivery 语义同步到 zai 的 AgentTool / subagentControl / subagentReport
**不涉及**: 底层 SubagentProvider 接口升级、provider 实现(codex/claude-code 等)、kernel swap 改造、continuation manager

---

## 1. 现状对照

### 1.1 AgentTool — model-facing surface 差距最大

| 维度 | DSH `tool-subagent` | zai 当前 AgentTool (vendor) |
|------|---------------------|------------------------------|
| `description` | 根据 `inheritsParentContext` 动态切换(fork 看见历史 / spawn 不看见)+ 3 种 background 行为说明 | vendor 固定文案(`packages/zn-agent-core/src/opencc-src/tools/AgentTool/prompt.ts`),zai 仅扩展 `formatSubagentProviderSection`(compat/subagents/promptSection.ts) |
| `parameters.description` | `'A short (3-5 word) description of the delegated task, for display.'` | 同样(`AgentTool.tsx:93`) |
| `parameters.prompt` | 跟随 `inheritsParentContext` 切换(看见历史: `'...build on them freely and state only what is new.'`;不看见: `'...include everything it needs.'`) | vendor 固定文案,无视 inheritsParentContext |
| `parameters.provider / model / reasoning_effort` | 可选,modelSelection 模式下出现 | vendor 无 |
| `parameters.run_in_background` | 可选,根据 `enableRunInBackground` / `backgroundMode(continuable/one-shot)` 切换 description | vendor `run_in_background: z.boolean().optional()`(`AgentTool.tsx:97`) |
| `output schema` | discriminatedUnion:`{ kind: 'foreground', runId, output }` / `{ kind: 'background', jobId }` / `{ kind: 'continuable', subagentId }` | vendor `Output` union(已含 `status: 'completed'`,但 3 种模式混在一个 union 里,不区分) |
| `output render` | 3 种 kind 对应不同文本 | vendor 单一 render |
| `capability 校验` | mount 时校验 5 flags + `prepareContinuable` presence | 无(`{ noStartCapabilities: true }` placeholder) |
| 配置 | `provider` / `toolName` / `enableRunInBackground` / `backgroundMode` / `agentOptions` / `persona` / `toolFilter` / `maxDepth` / `modelSelectionSettings` | vendor 硬编码 |

**对齐上游**: `packages/subagent/tool-subagent/src/index.ts:48-130,251-276,307-697`

### 1.2 subagentControl — 已对齐大部分,缺 attribution/authority

| 维度 | DSH `tool-subagent-control` | zai 当前 `compat/tools/opencc/subagentControl.ts` |
|------|----------------------------|--------------------------------------------------|
| 工具拆分 | `send_message` + `interrupt_agent` 两个工具 | 一个 `subagent_control` 工具(`action` enum 区分) |
| `send_message` description | 强调「becomes the subagent's next turn」「returns no answer」 | 简单「投递指令到子 agent 下一轮 turn 消费」 |
| `interrupt_agent` description | 强调「Only the current turn stops」「messages already queued stay parked」「the agent itself stays available」 | 简单「中止子 agent 当前 turn(幂等)」 |
| attribution | `source: { kind: 'coordinator', form: 'relay', senderSessionId }` | 无 source 字段 |
| authority check | interrupt 需 `kind: 'ancestor', agent: caller`,seam 校验 live Agent lineage | 无 authority check,直接 `bg.cancel(task_id)` |
| message source 接收方 | durable attribution 保留在 delivered message | 无 |

**对齐上游**: `packages/subagent/tool-subagent-control/src/index.ts:27-122`,authority 在 `packages/subagent/subagent/src/continuation.ts:558-598`

### 1.3 subagentReport — 已有基础,缺 delivery 命名 + attribution

| 维度 | DSH `tool-subagent-report` | zai 当前 `compat/tools/opencc/subagentReport.ts` |
|------|---------------------------|--------------------------------------------------|
| 安装位置 | child-scoped `ctx.subagents.registerContinuableSetup`(`installReportTool`) | 主对话工具集(`compat/tools/index.ts:buildDefaultTools`) — 不在 child scope |
| delivery policy | `'next-step'`(wake parent) / `'quiet'`(merge 不 wake) | `'wakeup'`(父空闲则开新 turn) / `'quiet'`(合并到下一次交互) |
| description | 强调「does not end your turn」「only your direct parent receives it」「A failed call may still have arrived, so do not blindly repeat it」 | 简单「报告当前子任务的进度或移交结果给父 agent」 |
| attribution | `source: { kind: 'subagent-report', form: 'relay', senderSessionId }` | `source: { kind: 'subagent', form: 'report' }` |
| delivery 触发 | `next-step` → `parent.steer(message)`;`quiet` → `parent.inject(message)` | 走 `deliverInboxMessage`,内部 followup/inject |
| tool 名 | `report`(简洁) | `subagent_report`(与 opencc 既有 `report` 工具命名区分) |

**对齐上游**: `packages/subagent/tool-subagent-report/src/index.ts:25-141`

---

## 2. 设计目标

### 2.1 AgentTool zai-native wrapper

zai 当前的 AgentTool 是 Claude Code 0.20.0 vendor 内嵌(`// @ts-nocheck` + `bun:bundle`),不能改源码。沿用 `wrapAsOpenccTool` 模式(参考 `AskUserQuestionTool.ts` / `SkillTool.ts`):

- **zai-native 实现**:`packages/zn-agent-core/src/compat/tools/opencc/AgentTool.ts`(新)
  - 用 zod/v4 schema(对齐 vendor 的 tool schema)
  - `description` 动态合成:`base description + inheritsParentContext switching + 3 种 background 行为 + registered providers list`
  - `parameters.prompt` 跟随 inheritsParentContext 切换文案
  - `parameters.run_in_background` 跟随 `enableRunInBackground` + `backgroundMode` 切换 description
  - 3 种输出模式:`foreground` / `background` / `continuable`,用 `discriminatedUnion`
  - `output render` 3 种 kind 对应不同文本
- **wrap 替换 vendor**:在 `builtin.ts:getOpenccBuiltinTools()` 中,移除 vendor `AgentTool`,用 `wrapAgentToolAsOpencc()` 包装的版本替换

### 2.2 subagentControl attribution + authority

保持现有 `subagent_control` 单工具(action enum 区分)结构,补:

- `send_message` 路径新增 attribution 字段(若 BackgroundRuntime 接受)
- `interrupt_agent` 路径新增 authority check(若 BackgroundRuntime 接受)
- description 文案对齐上游更精确的语义

### 2.3 subagentReport delivery 命名 + attribution

- 兼容保留 `wakeup`(现有用户已用),但内部映射到上游的 `next-step` 语义
- 补 `next-step` 作为 `wakeup` 的别名(模型可任选)
- attribution `kind: 'subagent'` → 内部桥接对齐 `kind: 'subagent-report'`,但保留 `kind: 'subagent'` 接受向后兼容

### 2.4 不做的改动

- ❌ 不实现 `SubagentProvider` 接口升级(5 flags → 维持 placeholder)
- ❌ 不实现 provider(claude-code / codex / spawn / fork / acp / dsh-sdk)
- ❌ 不改造 `kernel.getSeam('subagent')` swap(已有架构不变)
- ❌ 不动 `compat/subagents/{registry,claude-code,codex}`
- ❌ 不动 vendor `AgentTool.tsx`

---

## 3. 分阶段实施路径

### Phase 1: AgentTool zai-native wrapper(2 PR)

**目标**: 用 `wrapAsOpenccTool` 模式提供 zai-native AgentTool,替换 vendor AgentTool;model-facing surface 对齐 DSH `tool-subagent`

| Task | 文件 | 描述 |
|------|------|------|
| P1.1 zai-native AgentTool schema | `packages/zn-agent-core/src/compat/tools/opencc/AgentTool.ts`(新) | zod/v4 schema:base + `prompt` 跟随 inheritsParentContext 切换 + `provider/model/reasoning_effort`(modelSelection 模式) + `run_in_background`(enableRunInBackground/backgroundMode 切换 description) |
| P1.2 description 动态合成 | `AgentTool.ts` | base + inheritsParentContext wording + backgroundMode wording + choiceDescription(modelSelection) + registeredProvidersSection(`formatSubagentProviderSection`) |
| P1.3 3 种输出 schema | `AgentTool.ts` | discriminatedUnion:`{ kind: 'foreground', runId, output }` / `{ kind: 'background', jobId }` / `{ kind: 'continuable', subagentId }` |
| P1.4 output render | `AgentTool.ts` | 3 种 kind 对应不同文本(对齐上游 `tool-subagent/src/index.ts:454-460`) |
| P1.5 execute 路由 | `AgentTool.ts` | 路由到 `subagentProviderBridge.runSubagentProvider`(foreground)或 `BackgroundRuntime.start`(background) |
| P1.6 inheritsParentContext 接入 | `AgentTool.ts` | 从 `getSubagentRegistry().getProvider(name)?.inheritsParentContext` 读取(provider 不可用时默认 false) |
| P1.7 wrap 替换 vendor | `compat/tools/opencc/builtin.ts` | `cachedTools` 移除 vendor `AgentTool`,加入 `wrapAgentToolAsOpencc()` |
| P1.8 测试 | `packages/zn-agent-core/test/unit/compat/AgentTool.test.ts`(新) | description 切换 / schema 验证 / 3 种输出 / wrap 形态对齐 vendor |

**对齐上游**:
- `tool-subagent/src/index.ts:48-130`(config schema)
- `tool-subagent/src/index.ts:251-276`(providerWording)
- `tool-subagent/src/index.ts:307-697`(apply + mount + lifecycle)
- `tool-subagent/src/index.ts:373-462`(tool definition + output schema + render)

**验收**: `pnpm --filter @zn-ai/zn-agent-core test src/compat/tools/opencc/AgentTool.test.ts` 全绿;AgentTool model-facing description 在 opencc 当前 subagent registry 下与 vendor 文案兼容(不破坏现有模型调用)

---

### Phase 2: subagentControl attribution + authority(1 PR)

**目标**: 对齐 DSH `tool-subagent-control` 的 attribution 与 authority 语义

| Task | 文件 | 描述 |
|------|------|------|
| P2.1 description 文案对齐 | `compat/tools/opencc/subagentControl.ts:208-228` | 三个 action 的 description 都按上游更精确的语义重写(send_message 强调「returns no answer」;interrupt_agent 强调「Only the current turn stops」) |
| P2.2 source attribution | `subagentControl.ts:151-159` | `bg.sendMessageToTask` 调用前构造 `messageSource = { kind: 'coordinator', form: 'relay', senderSessionId: getCurrentSessionId() }`(若 BackgroundRuntime 支持) |
| P2.3 authority check stub | `subagentControl.ts:163-171` | `bg.cancel` 调用前校验 caller 是当前 session 的 live agent(`__zaiCurrentSessionId`);不通过返回 `{ ok: false, error: 'UNAUTHORIZED' }`(对齐上游 `SubagentError` 代码) |
| P2.4 测试 | `test/unit/compat/subagentControl.test.ts` | attribution + authority 拒绝场景测试 |

**对齐上游**:
- `tool-subagent-control/src/index.ts:60-78`(send_message attribution)
- `tool-subagent-control/src/index.ts:108-119`(interrupt_agent authority)
- `subagent/src/continuation.ts:558-598`(authority 校验语义)

**验收**: `pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/subagentControl.test.ts` 全绿;description 文本快照对齐上游

---

### Phase 3: subagentReport delivery 命名 + attribution(1 PR)

**目标**: 对齐 DSH `tool-subagent-report` 的 delivery policy 与 attribution

| Task | 文件 | 描述 |
|------|------|------|
| P3.1 delivery 命名扩展 | `compat/tools/opencc/subagentReport.ts:13-19` | schema 接受 `'wakeup' \| 'next-step' \| 'quiet'`(前两个等价,后一个等价);保留向后兼容 `wakeup` |
| P3.2 description 文案对齐 | `subagentReport.ts:11-12` | 重写为上游更精确的语义(强调「does not end your turn」「only your direct parent receives it」) |
| P3.3 attribution 字段 | `subagentReport.ts:34-37` | `deliverInboxMessage` 调用时传 `source: { kind: 'subagent-report', form: 'relay', senderSessionId }`;同时接受旧 `kind: 'subagent', form: 'report'` 做向后兼容 |
| P3.4 测试 | `test/unit/compat/subagentReport.test.ts` | delivery 命名扩展测试 + attribution 测试 |

**对齐上游**:
- `tool-subagent-report/src/index.ts:60-74`(description)
- `tool-subagent-report/src/index.ts:65-69`(parameters.description)
- `subagent/src/continuation.ts:659-723`(delivery policy:next-step → steer;quiet → inject)

**验收**: `pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/subagentReport.test.ts` 全绿

---

### Phase 4: 回归 + ego-browser 验证(1 PR)

**目标**: 三工具表面改动不破坏现有路径,真实浏览器走通

| Task | 路径 | 描述 |
|------|------|------|
| P4.1 单测全量回归 | — | `pnpm --filter @zn-ai/zn-agent-core test src/compat`(直接相关);Phase 0 baseline 无新失败 |
| P4.2 启动 zai dev | — | `pnpm --filter @zn-ai/zai dev -- --port 8103 --api-port 7716` |
| P4.3 AgentTool 验证 | `/agent` | zai-native AgentTool:subagent_type='general-purpose' 调用,description 显示 provider 列表 + background 行为 |
| P4.4 subagent_control 验证 | `/agent` | send_message 投递后续消息,interrupt_agent 中断 turn;description 文案与上游对齐 |
| P4.5 subagent_report 验证 | `/agent` | 子 agent 主动 `subagent_report({output, delivery: 'wakeup'})` 给父;确认 parent 收到并续传 |
| P4.6 移动端验证 | `/m` | 移动端三工具 model-facing surface + 续传语义 |

**验收**: 6 路径全部通过;截图归档到 `docs/superpowers/screenshots/2026-08-30-agent-tool-dsh-sync/`

---

## 4. 时间线与依赖

```
Phase 1 (AgentTool wrapper)  ──▶  Phase 2 (Control attribution)  ──▶  Phase 3 (Report delivery)  ──▶  Phase 4 (ego-browser)
       [2 PR]                          [1 PR]                          [1 PR]                        [1 PR]
```

**预计 5 PR,2-3 周**。三个 Phase 内部独立可并行(P2/P3 顺序无关,P1 必须先因为 wrapper 影响最大)。

---

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| vendor AgentTool 替换为 zai-native 后,某些 vendor 内部 path 仍引用 vendor AgentTool identity | `wrapAsOpenccTool` 保留 vendor 表面(name / inputSchema / call);仅 description 与 output schema 增强,下游消费方不受影响 |
| description 文案大改,模型行为变化 | 保持原 vendor 文案作为 base + 仅追加(DSH 新能力);description 加 `formatSubagentProviderSection` 已在 zai 现有路径里工作 |
| 3 种输出模式 discriminatedUnion 与 vendor `Output` 不兼容 | zai-native AgentTool 不复用 vendor Output,自己定义 discriminatedUnion;通过 `as unknown as { data: Output }` cast 保持 vendor `Output` 形状(对齐 `subagentProviderBridge.ts:86-91`) |
| subagentControl attribution 字段 BackgroundRuntime 不接受 | 退化为只在新 seam(dsh)启用 attribution;opencc 路径维持现状 |
| subagentReport delivery 命名扩展破坏旧调用 | `wakeup` / `next-step` 都接受,内部映射;旧调用无破坏 |
| wrapAsOpenccTool 适配器本身有问题(参见 AskUserQuestionTool zod/v4 与 v3 差异) | 参考 `AskUserQuestionTool.ts:50-80` zod/v4 mirror 模式;AgentTool 全部用 zod/v4 直接写,避免 v3/v4 混用 |

---

## 6. 测试策略

### 单测

- Phase 1: `test/unit/compat/AgentTool.test.ts`(新)— description 切换 / 3 种输出 schema / wrap 形态 / inheritsParentContext 文案
- Phase 2: `test/unit/compat/subagentControl.test.ts`(已存在)— attribution / authority 拒绝场景测试
- Phase 3: `test/unit/compat/subagentReport.test.ts`(已存在)— delivery 命名扩展 / attribution 测试

### 快照

- Phase 1 + 2 + 3 的 description 文本,作为 snapshot test 锁定上游对齐(类似 `subagentReport.test.ts` 现有 snapshot 模式)

### 集成

- Phase 4 不新增集成测试,直接走 ego-browser

### 回归

- 每 Phase 后跑直接相关测试
- Phase 4 全量回归 `pnpm --filter @zn-ai/zn-agent-core test`(对比 baseline)

### ego-browser(强制)

- Phase 4 三工具真实浏览器验证 + 移动端
- 验证前**必须**先 `pnpm run build:core`(AGENTS.md §52 强制)
- 端口避开 920x / 8101 / 8102,显式空闲端口

---

## 7. 不涉及的范围(明确归档)

实施完成后,在 `docs/superpowers/specs/<date>-zai-agent-tool-dsh-sync-deltas.md` 记录:

1. **SubagentProvider interface 未升级**: 维持 `{ noStartCapabilities: boolean }` placeholder;5 flags 升级是独立 PR(超出本次 sync 范围)
2. **provider 实现未跟进**: claude-code / codex / spawn / fork / acp / dsh-sdk 等不实现
3. **kernel swap 未改造**: `kernel.getSeam('subagent')` 维持现有架构;dsh kernel 接入是独立工作
4. **continuation manager 不动**: `startContinuable` / `followup` / `interrupt` / `reportFrom` 内部实现不重构
5. **vendor AgentTool.tsx 不动**: zai-native wrapper 是替换品,不是 patch vendor

---

## 8. 关联文档

- 上游 tool-subagent: [`packages/subagent/tool-subagent/src/index.ts`](../../../deepseek-harness/packages/subagent/tool-subagent/src/index.ts)
- 上游 tool-subagent-control: [`packages/subagent/tool-subagent-control/src/index.ts`](../../../deepseek-harness/packages/subagent/tool-subagent-control/src/index.ts)
- 上游 tool-subagent-report: [`packages/subagent/tool-subagent-report/src/index.ts`](../../../deepseek-harness/packages/subagent/tool-subagent-report/src/index.ts)
- 上游 continuation: [`packages/subagent/subagent/src/continuation.ts`](../../../deepseek-harness/packages/subagent/subagent/src/continuation.ts)
- zai AgentTool 现状: `packages/zn-agent-core/src/opencc-src/tools/AgentTool/AgentTool.tsx`
- zai subagentControl: `packages/zn-agent-core/src/compat/tools/opencc/subagentControl.ts`
- zai subagentReport: `packages/zn-agent-core/src/compat/tools/opencc/subagentReport.ts`
- wrap 模式参考: `packages/zn-agent-core/src/compat/tools/opencc/AskUserQuestionTool.ts`

---

<!-- status: draft, 4 phases, 5 PRs, 2-3 weeks, no provider impl, no kernel swap, no SubagentProvider upgrade -->
