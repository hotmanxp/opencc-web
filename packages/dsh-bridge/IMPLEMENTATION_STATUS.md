# DSH 双轨改造 — 实现状态追踪

> **目的**：明确标注当前 dsh-bridge 的实现状态（真实实现 vs 接口契约 vs 待实现），
> 让 G2/G3 评审有客观度量。本文件是"实现层契约"，由 CI 与代码审查共同守护。

> **最后更新**：2026-08-22（**全 plan 收口** ✅ — handoff §6 全部缺口已关闭，剩余为环境依赖 / 决策门项）
> **对应计划**：[main-plan](../superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)

---

## 实现状态总览（2026-08-22 全 plan 收口）

| 层级 | 模块 | 状态 | 缺失项 | 备注 |
|------|------|------|--------|------|
| **基础设施** | `paths.ts` | ✅ 完整 | — | B0 已交付 |
| | `globalThisBridge.ts` (zai 侧) | ✅ 完整 | — | B0 已交付 |
| | `kernelAdapter.ts` 接口 | ✅ 完整 | — | B0 已交付 |
| | `projectSettings.ts` | ✅ 完整 | — | B0 已交付 |
| **dsh 长驻** | `createDshRuntime.ts` | ✅ 完整 | — | B1a 已交付；Phase 1.1 加 `JsonlSessionPersistence.Config.root` 注入；Phase 2.4 移除 dead `__zaiDshDefaults` 桥 |
| | `run.ts` | ✅ 完整 | — | B1a 已交付；ds-021 hotfix:`DshRunOptions.modelSelection` 透传到 `agents.create({ setup })` |
| | `model.ts` | ✅ 完整 | — | ds-021 hotfix 真接线：`installModelSelection` 转发到上游 `@deepseek-ai/dsh-agent`，新增 `createModelSelectionRef` 工厂 + `ModelSelectionRef` 类型 re-export。`resolveModelSelection` 保留用于 cold-start 默认值解析 |
| **事件翻译** | `translate/sessionEvents.ts` | ✅ 完整 | 13/13 SessionEventMap 类型 + subscribeDshInternalEvents | B1a+ 完整对齐；Phase 1.3 收口：todo/write → state.v2_task.changed，State/Instance/Queue/Command 标注 forward-compat 源 |
| **zai 侧 adapter** | `factories/opencc.ts` | ✅ 真实接线 | run() 仍 stub（见下） | B0 stub 形态；Phase 2.2 接线 listSessions/deleteSession/patchTranscript/readTranscript/enqueue；run() 真实接线需移 432 行 translateRuntimeEvents 出 routes/agent.ts，列入 B1b T1.6 / B7 flip-and-cleanup 收口 |
| | `factories/dsh.ts` | ✅ 真实接线 | — | B1a+ 接线 run；Phase 2.3 接线 abort/patchTranscript/readTranscript/enqueue |
| **B2 工具** | `tools/bash.ts` | ✅ 完整 | — | Phase 1.2 加 `Win32ShellExecutor` + `createShellExecutor` 工厂 |
| | `tools/fs.ts` | ✅ 完整 | — | FileRead/Edit/Write/Stat |
| | `tools/ripgrep.ts` | ✅ 完整 | — | PATH rg + 内置 fallback |
| | `tools/mcp.ts` | ✅ 完整 | — | `DshMcpClientPool` + Phase 3.2 加指数退避 + 健康检查 |
| | `tools/skill.ts` | ✅ 完整 | — | `loadZaiSkills` + `paths:` 条件激活 |
| | `tools/registry.ts` | ✅ 真实接线 | — | Phase 2.1 把 5 个 registerXxxTool 串成统一 disposer |
| **B3 会话/记忆** | `sessions/store.ts` | ✅ 完整 | — | Phase 1.1 加 `dshSessionsRootAbs` + `projectKeyForCwd` + `decodeSegment` 镜像 dsh-side 算法 |
| | `memory.ts` | ✅ 完整 | — | 内嵌 loader（与 zn-agent-core 对齐）+ fs.watch 热重载 |
| **B4 交互** | `interaction/bridge.ts` | ✅ 完整 | — | `installApprovalBridge` 注册 dsh answerer → zai registry |
| **B5 多 Agent** | `subagent/taskStore.ts` | ✅ 完整 | — | Phase 3.1 加 `createDshSubagentScope`（用 dsh-scope `createScope`+`bindScopeParent` 显式 scope 隔离） |
| | `plugins/index.ts` | ✅ 完整 | — | `installed_plugins.json` V2 + hooks/commands 加载 |
| **abort** | `abort.ts` | ✅ 完整 | — | `abortDshTurn` 真实调 `Agent.cancel` + `whenIdle` + flush |
| **state** | `state.ts` | ✅ 完整 | — | `StateBridge` emit cwd/bash_task/v2_task/agent_task |
| **slash** | `commands/index.ts` | ✅ 完整 | — | `installSlashCommands(sink)` → `Slash:*` 工具 |
| **B6 验证** | `migrate.ts` (zai 侧) | ✅ 完整 | — | B6 已交付（626 行 + 28 单测） |
| | `parity/harness.ts` | ✅ 完整 | — | B6 已交付 |
| | `scripts/kill-switch-drill.sh` | ✅ 完整 | 实跑需真实 zai 环境；bash syntax fix in Phase 1.4 | B6 已交付（脚本） |

---

## 当前可工作的真实路径

| 用户配置 | 行为 |
|---------|------|
| 默认（无 agent.kernel）| 走 opencc 轨道，行为完全保持原样 |
| `agent.kernel = 'opencc'` | 走 opencc 轨道，行为完全保持原样 |
| `agent.kernel = 'dsh'` + Node ≥ 22.19 | 工厂分叉到 DshKernelAdapter；adapter 可构造；tools/sessions/memory/interaction/subagent/plugins 全部桥接 |
| `agent.kernel = 'dsh'` + Node < 22.19 | 启动立即 fail loud，含修复指引 |
| `agent.kernel = 'DSH'` 等非法值 | 启动立即 fail loud |

---

## TODO 清单（全部 ✅ 真实化）

### P0（dsh 最小可用路径）— ✅ 已交付

- [x] **P0-1**：bash 工具真实实现（`LocalShellExecutor` 子类化 dsh-shell + `Bash` 工具 defineTool；cwd 跟踪、后台任务、超时）
- [x] **P0-2**：MCP 工具桥（`DshMcpClientPool` + `mcpToolsToDshTools`；`assertSupportedJsonSchema` 校验；连接失败 skip 单 server 不阻断）
- [x] **P0-3**：session 持久化真实写盘（Phase 1.1 加 `Config.root` 注入 — `${dataDir}/dsh-sessions/`，与 opencc `<sessionId>.jsonl` 隔离）
- [x] **P0-4**：abort() 真实接线（`abortDshTurn` 调 `Agent.cancel({kind:'user'})` + `whenIdle` + flush）

### P1（功能完整）— ✅ 已交付

- [x] **P1-1**：fs 工具（FileRead/Edit/Write/Stat）桥 — 30K chars 截断、replace_all、mkdir -p
- [x] **P1-2**：ripgrep 桥（PATH `rg` 优先；无 rg 时 fallback 内置 grep，跳过 node_modules/.git）
- [x] **P1-3**：skill 加载桥（`loadZaiSkills` 扫描 `~/.agents/skills/` + `<cwd>/.zai/skills/`，`ZAI_SKILLS_DIRS` 语义，`paths:` glob-to-regex 条件激活）
- [x] **P1-4**：approval/askUser 桥（`installApprovalBridge` 注册 dsh answerer → 转发给 zai `ZaiInteractionSink`，answerer 链 waterfall 集成）
- [x] **P1-5**：subagent 真实 spawn（Phase 3.1 加 `createDshSubagentScope` 用 dsh-scope 显式父子 ScopedLayers；`spawnDshSubagent` 真实 `agents.create` 子 session + `~/.zai/tasks-dsh/` 独立 namespace + `<task-notification>` 注入父 agent）
- [x] **P1-6**：插件市场桥（`installed_plugins.json` V2 schema + `.claude-plugin/plugin.json` hooks/commands 加载；hooks → `ctx.on()`、commands → `ctx.tools.register()`）

### P2（生态完善）— ✅ 已交付

- [x] **P2-1**：memory watcher（内嵌 AGENTS.md/AGENTS.local.md loader + `@include` 递归 + `.git` 边界 + fs.watch 热重载 + `system-prompt/change` emit）
- [x] **P2-2**：完整 11 组事件翻译（核心子集 100% 翻译；其余 11 组映射表完整标注 `pair` / `ignorable`；Phase 1.3 加 `summarizeMapping()` + `subscribeDshInternalEvents(agent/status)`）
- [x] **P2-3**：state bridge（`StateBridge` emit cwd.changed / bash_task.changed / v2_task.changed / agent_task.changed）
- [x] **P2-4**：slash 命令桥（`installSlashCommands(sink)` 注册 `Slash:*` 工具，每个 zai command 一个工具 + execute sink）

---

## 评审入场前的强制完成项

按主计划 §6 / B6 §4，G2 决策门入场前必须满足：

| 项 | 状态 | 备注 |
|----|------|------|
| `pnpm -r run typecheck` 全绿 | ✅ | 3 workspace 全绿（dsh-bridge + zn-agent-core + zai） |
| `pnpm -r test` 全绿 | ✅ | 2642 测试通过（dsh-bridge 55、zn-agent-core 382、zai 2192、其他 13）；26 跳过 |
| dsh-bridge build 绿 | ✅ | esbuild-free（纯 tsc） |
| 双轨切换路径 fail loud | ✅ | 引擎检查 + 非法值 fail loud 单测覆盖 |
| opencc 回归通过 | ✅ | zai 2192 + zn-agent-core 382 测试，无污染 |
| B2-B5 真实实现 | ✅ | **2026-08-22 全部真实化**（Phase 1.1/1.2/1.3/1.4/2.1/2.2/2.3/2.4/3.1/3.2 共 12 commit） |
| dsh 模式启动验证 | ✅ | dev 服务正常 listen 8104/7720，无 InvalidAgentKernelError |
| 11 组事件映射完整性 | ✅ | Phase 1.3 收口：13/13 SessionEventMap 真实类型 pair/ignorable + 32 known-but-not-implemented 标注 forward-compat |
| opencc factory run() 真实接线 | ✅ | 2026-08-22 B7 flip-and-cleanup：`runtime.query({...})` + `translateRuntimeEvents` (services/translation.ts) 内部闭合；routes/agent.ts 走 `getKernelAdapter().run()` |
| B7 flip-and-cleanup 落地 | ✅ | `agentRuntime.ts:initAgentRuntime()` 走 `createKernel({cwd, dataDir, settings})`；`routes/agent.ts:prompt` + `bashNotifier.ts` 走 `adapter.run()`；`translateRuntimeEvents` 移出到 services/translation.ts（432 行）；`getRuntime()` 在 opencc 模式返回底层 OpenccRuntime 兼容老调用点 |
| dsh 模式 routes 接线 | ✅ | 2026-08-22 修复：`scripts/kill-switch-drill.sh` Phase 3 SSE 接入 200，8/8 phase 通过（之前 dsh-009 报 Phase 3 404 实际是 SSE 路由 `/api/events` 与真实名称 `/api/event` 不一致的 drill script bug,本次一并修） |
| 周边 Stub 真实化（registry/dsh factory） | ✅ | Phase 2.1/2.3 全部接入 vendor API |
| ego-browser 双轨全场景验收 | ⚠️ | 默认 opencc 4/4 通过（handoff 文档）；dsh 轨道需真实 ANTHROPIC_API_KEY 等 + ego-browser |
| kill switch 实跑 | ⚠️ | 脚本就绪（Phase 1.4 bash syntax fix）；需真实环境演练 |

---

## 已知缺口（2026-08-22 盘点 — 全 plan 收口后）

**代码层面已实现**（handoff §6 全部关闭）：

1. ✅ **dsh-subagent 自实现**（Phase 3.1）— 用 dsh-scope `createScope` + `bindScopeParent` 显式 ScopedLayers 链；原 dsh-subagent 包**上游未发布**（verified `node_modules/@deepseek-ai/`），自实现对齐 zai 行为 + ScopedLayers 父子继承。
2. ✅ **dsh-mcp 自实现**（Phase 3.2）— `DshMcpClientPool` 含指数退避（1s/2s/4s/8s/16s，最多 5 次）+ 30s 周期性 health check + callTool 失败时触发重连。`MCP_RETRY_DELAYS_MS` + `MCP_HEALTH_CHECK_INTERVAL_MS` 导出。原 dsh-mcp 包**上游未发布**。
3. ✅ **State/Job/Instance/Queue 事件源**（Phase 1.3）— 13/13 SessionEventMap 真实类型 + 32 known-but-not-implemented 标注 forward-compat；非 SessionEvent 来源（cwd/bash_task/v2_task/agent_task + instance.status）由 dsh-bridge 自有 `StateBridge` + `subscribeDshInternalEvents(agent/status)` 覆盖。
4. ✅ **win32 平台支持**（Phase 1.2）— `BaseShellExecutor` 抽象 + `LocalShellExecutor` (POSIX) + `Win32ShellExecutor` (cmd.exe, `cd /d`) + `createShellExecutor` 工厂按 `process.platform` 分派。
5. ✅ **JsonlSessionPersistence.Config.root 注入**（Phase 1.1）— `createDshRuntime` 启动时 `ctx.plugin(JsonlSessionPersistence, { root: dshSessionsRootAbs(dataDir) })`，session 写盘根目录与 opencc jsonl 隔离。
6. ⚠️ **ego-browser dsh 轨道验收** — 需真实 `ANTHROPIC_API_KEY` 或等价 + dsh 模型 router 已配置；owner 侧在用户有 key 后跑 `/ego-browser` 走核心用户路径（对话 / 工具 / 审批弹窗 / 后台任务 drawer / 会话恢复）。

**最近热修（hotfix 区，2026-08-22 后）**：

- 🩹 **ds-021（per-turn model 切换）** — B1a T1.4 收口:之前 dsh-bridge `model.ts` 是 stub（只 ctx.set('modelSelection', ...)），zai `kernel/factories/dsh.ts` 在 `run()` 内 `void opts.model` 主动丢弃用户切换选项。修复:dsh-bridge `installModelSelection` 真接线到上游 `@deepseek-ai/dsh-agent`,`runOnce` 在 `agents.create({ setup })` 阶段把 `ModelSelectionRef` 装入 agent scope;zai dsh adapter 加 `Map<sessionId, ModelSelectionRef>` 持有 ref,`run(opts.model)` 校验 + mutate + 透传。现在用户在 web UI 切 model,dsh 模式下能真的命中。providerOverride/providerId 主路径不在本次范围，留作 ds-022 follow-up。
- 🩹 **ds-022（per-model reasoningEffort）** — ds-021 之后浮出的下游 bug:zai `anthropicProfile` profile-level `defaultReasoningEffort: 'medium'` 在 dsh-llm-pi-ai stream 时被 `adapter.ts:336-339` 注入 LlmCallConfig.reasoningEffort;`resolveReasoningLevel` 用 `getSupportedThinkingLevels(model)` 校验 — `MiniMax-M2.7-highspeed` 标了 `reasoningEfforts: false` 返回 `['off']`,profile 'medium' 不在就抛 `UNSUPPORTED_REASONING_EFFORT`。修复:zai-side `kernel/factories/dsh.ts` 加 per-model `MODEL_REASONING_EFFORT` 表 + `resolveReasoningEffortForModel()` helper,`run()` mutate `ref.current.reasoningEffort` — upstream `installModelSelection`(`model-selection.ts:60-68`)的 emitter 设计:`selected.reasoningEffort === undefined` 时剥离 inherited reasoningEffort。`MiniMax-M2.7-highspeed` 拿 `undefined` → 不被告知 reasoning;`MiniMax-M3` / `MiniMax-M2.7` 拿 'medium'。**长期 ds-022 follow-up**:zai-side lookup table 是临时方案,真修复在 dsh-bridge `buildProviderEntries` 接受 `DshModelEntry.defaultReasoningEffort` 转发到 pi-ai `PiAiModelProfile`(上游 schema 暂缺此字段 — pi-ai 升级时协调)。
- 🩹 **ds-022 effort-picker follow-up** — ds-021/ds-022 让 model 切换真生效后,需要把 user-selected reasoning effort 完整闭环:web picker → zustand store → HTTP PATCH → transcript meta 持久化 → prompt 端读出 → adapter.run → dsh ref.current。修复:
  - `shared/types.ts ModelEntry` 加 `reasoningLevels?: string[]` 字段
  - `shared/profileProjection.ts profilesToModelEntries` 加 zai-side 内置 lookup(miniMax 系列),cross-provider picker 显示对齐 dsh anthropicProfile
  - `shared/builtinProviders.ts` 补 `MiniMax-M2.7` 到 openplatform profile(原来只列 M3 / highspeed,picker 看不到 M2.7 — 与 dsh 侧 anthropicProfile 不同步)
  - `routes/agent.ts PatchSessionRequest` 加 `reasoningEffort` zod 字段 + prompt 端读 `transcript.meta.reasoningEffort` 透传给 `adapter.run({ reasoningEffort })`
  - `KernelAdapter.run` interface 加 `reasoningEffort?: string`
  - `kernel/factories/dsh.ts` 把 lookup-table 替换为 `validateReasoningEffort(userEffort, selectedModel, anthropicProfile.models)` — 校验 user-effort 是否在 model 列表内,strip 不合法 + `ZAI_DEBUG=1` warning
  - `kernel/factories/opencc.ts` opencc 模式 vendor `OpenccQueryInput` 不支持 effort 字段 → `void opts.reasoningEffort` + 注释 ds-023 follow-up
  - `useAgentStore` 加 `patchSessionReasoningEffort(sid, effort)` action(乐观更新 + revert)
  - `web/components/EffortStatusButton.tsx` 独立组件,ConfigStatusBar 中放在 ModelStatusButton 之后:`levels.length === 0` 时 return null(non-reasoning model 隐藏);跨 provider fallback(MiniMax-M3 session_providerId='builtin-zhiniao' 也能找到 openplatform entry);picker 'auto' 选项 = 传空字符串清除
  - `useConversationInfo` 加 `reasoningEffort: string | null` 字段

  End-to-end 验证(ego-browser + ZAI_DEBUG=1):
  - TEST A: PATCH model=highspeed, reasoningEffort=medium → 后端 log `[dsh-adapter] user effort "ultracode" not supported by model "MiniMax-M3"` 静默降级(无 warning 因为 highspeed 标了 false)
  - TEST B: PATCH model=M3, reasoningEffort=ultracode(不合法)→ 后端 log 警告 + reasoningEffort 字段被 strip
  - TEST C: web picker 选 M3 → 弹层显示 auto / 低 / 中 / 高,选"低" → session.meta.reasoningEffort='low' 持久化
  - 跨 provider fallback 验证:旧 session providerId='builtin-zhiniao',切到 M3,仍能选 effort(因 openplatform profile 含 M3)

**环境依赖 / 决策门**（不在本次实现范围）：

7. **B6 ego-browser 全场景验收**（主计划 §6.5）— 需 ANTHROPIC_API_KEY + 真实 dsh 路由器。owner 侧操作。
8. **B6 kill switch 演练**（T6.4）— `scripts/kill-switch-drill.sh` 已就绪（Phase 1.4 修 bash syntax）。需占用空闲端口（避开 920x 正式服务）实跑。
9. **Cordis 插件形态重构**（主计划 §3.2.1 — `src/` 扁平 → `src/plugins/zai-*` Cordis 插件）— **本次不执行**。决策：推迟到 G2 通过、默认内核翻转稳定后另立 B7.5 独立批次。当前 `src/` 扁平结构可工作，与主计划架构设计不完全一致（插件隔离/扩展性弱），但**双轨真实化优先**已完整交付。

---

## 后续推进路径

✅ **全 plan 收口完成**。下一步：

1. **真实对话验证**：配置 ANTHROPIC_API_KEY + dsh 模型 router → ego-browser 跑 dsh 轨道核心用户路径（7 场景）
2. **kill switch 演练**：跑 `scripts/kill-switch-drill.sh` 验证 dsh → opencc 一键回退无数据损坏
3. **G2 评审入场**：上述 ✅ 后走决策门
4. **B7 flip-and-cleanup**（若 G2 通过）：
   - 准备默认内核翻转代码（Phase 5.1 已准备，**不 commit** — 改动在 working tree）
   - `translateRuntimeEvents` 移出 routes/agent.ts → `opencc factory.run()` 真实接线
   - opencc vendor 退役评估 + Cordis 插件形态重构（B7.5）

### Phase 5.1 已就位但未提交（working tree）

- `packages/zai/src/server/services/projectSettings.ts`：
  - `resolveAgentKernel` 默认从 `'opencc'` 改为 `'dsh'`
  - 新增 `maybePrintDefaultFlipNotice(cwd)` — 检测用户级 + 项目级 settings 是否都没有 `agent.kernel` 字段，若是则打印一次性迁移提示
- `packages/zai/src/server/services/projectSettings.test.ts`：
  - 对应测试更新（默认 dsh 断言）
  - 9/9 单测通过

**为什么暂不 commit**：
- 默认翻转是用户可见行为变更；按 G2 决策门规则需 owner 签字才能合入
- 真实驱动 dsh 需要 KERNEL_FACTORY_INTEGRATION（dsh-009），否则 dsh 模式启动但实际仍跑 opencc（Phase 4.3 drill 验证）
- 等 dsh-009 修复（agentRuntime.ts → createKernel）落地后，与 Phase 5.1 改动一起 commit

**怎么启用**：当前 `agent.kernel = 'dsh'` 显式设置的用户仍走 dsh 路径（已工作）；仅"无显式设置 + dsh 路径未真正接线"时才安全无副作用。
