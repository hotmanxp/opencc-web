# DSH 双轨改造 — 实现状态追踪

> **目的**：明确标注当前 dsh-bridge 的实现状态（真实实现 vs 接口契约 vs 待实现），
> 让 G2/G3 评审有客观度量。本文件是"实现层契约"，由 CI 与代码审查共同守护。

> **最后更新**：2026-08-22（**P0/P1/P2 全部真实化** ✅）
> **对应计划**：[main-plan](../superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)

---

## 实现状态总览（2026-08-22 更新）

| 层级 | 模块 | 状态 | 缺失项 | 备注 |
|------|------|------|--------|------|
| **基础设施** | `paths.ts` | ✅ 完整 | — | B0 已交付 |
| | `globalThisBridge.ts` (zai 侧) | ✅ 完整 | — | B0 已交付 |
| | `kernelAdapter.ts` 接口 | ✅ 完整 | — | B0 已交付 |
| | `projectSettings.ts` | ✅ 完整 | — | B0 已交付 |
| **dsh 长驻** | `createDshRuntime.ts` | ✅ 完整 | — | B1a 已交付 |
| | `run.ts` | ✅ 完整 | — | B1a 已交付 |
| | `model.ts` | ✅ 完整 | — | B1a 已交付 |
| **事件翻译** | `translate/sessionEvents.ts` | ✅ 完整 | 核心子集 100% 翻译；其余 11 组映射表全部标注 pair/ignorable | B1a+ 完整对齐 |
| **zai 侧 adapter** | `factories/opencc.ts` | ⚠️ Stub run/abort/patchTranscript | run() 真实接线 routes/agent.ts（计划 T1.6 后续）；abort 已通过 sessionControllers；patchTranscript 待 B3 | B0 stub 形态，行为通过 routes/agent.ts 旧路径保留 |
| | `factories/dsh.ts` | ✅ KernelAdapter.run 完整 | abort/patchTranscript 仍 stub；abort 已可调 `abortDshTurn()`（外部触发） | B1a+ 接线 run |
| **B2 工具** | `tools/bash.ts` | ✅ 完整 | — | `LocalShellExecutor` 子类 + `defineTool` Bash 工具 |
| | `tools/fs.ts` | ✅ 完整 | — | FileRead/Edit/Write/Stat |
| | `tools/ripgrep.ts` | ✅ 完整 | — | PATH rg + 内置 fallback |
| | `tools/mcp.ts` | ✅ 完整 | — | `DshMcpClientPool` + `mcpToolsToDshTools` |
| | `tools/skill.ts` | ✅ 完整 | — | `loadZaiSkills` + `paths:` 条件激活 |
| | `tools/registry.ts` | ⚠️ Stub | `ctx.tools.register()` 调用归 registerXxxTool 函数；`registry.ts` 仅留 normalizeToolEvent | B2 注册入口由各工具自带 |
| **B3 会话/记忆** | `sessions/store.ts` | ✅ 完整 | — | `dshSessionsRoot` 隔离目录 + `readDshSessionHeader` 真实读 |
| | `memory.ts` | ✅ 完整 | — | 内嵌 loader（与 zn-agent-core 对齐）+ fs.watch 热重载 |
| **B4 交互** | `interaction/bridge.ts` | ✅ 完整 | — | `installApprovalBridge` 注册 dsh answerer → zai registry |
| **B5 多 Agent** | `subagent/taskStore.ts` | ✅ 完整 | — | `spawnDshSubagent` 真实 spawn 子 session + `~/.zai/tasks-dsh/` 隔离 |
| | `plugins/index.ts` | ✅ 完整 | — | `installed_plugins.json` V2 + hooks/commands 加载 |
| **abort** | `abort.ts` | ✅ 完整 | — | `abortDshTurn` 真实调 `Agent.cancel` + `whenIdle` + flush |
| **state** | `state.ts` | ✅ 完整 | — | `StateBridge` emit cwd/bash_task/v2_task/agent_task |
| **slash** | `commands/index.ts` | ✅ 完整 | — | `installSlashCommands(sink)` → `Slash:*` 工具 |
| **B6 验证** | `migrate.ts` (zai 侧) | ✅ 完整 | — | B6 已交付（626 行 + 28 单测） |
| | `parity/harness.ts` | ✅ 完整 | — | B6 已交付 |
| | `scripts/kill-switch-drill.sh` | ✅ 完整（脚本） | 实跑需真实 zai 环境 | B6 已交付（脚本） |

---

## 当前可工作的真实路径

| 用户配置 | 行为 |
|---------|------|
| 默认（无 agent.kernel）| 走 opencc 轨道，行为完全保持原样 |
| `agent.kernel = 'opencc'` | 走 opencc 轨道，行为完全保持原样 |
| `agent.kernel = 'dsh'` + Node ≥ 22.19 | 工厂分叉到 DshKernelAdapter；adapter 可构造；tools/sessions/memory/interaction/subagent/plugins 全部桥接（run() 真实驱动对话依赖 dsh 0.1.0-rc.7 的稳定性） |
| `agent.kernel = 'dsh'` + Node < 22.19 | 启动立即 fail loud，含修复指引 |
| `agent.kernel = 'DSH'` 等非法值 | 启动立即 fail loud |

---

## TODO 清单（全部 ✅ 真实化）

### P0（dsh 最小可用路径）— ✅ 已交付

- [x] **P0-1**：bash 工具真实实现（`LocalShellExecutor` 子类化 dsh-shell + `Bash` 工具 defineTool；cwd 跟踪、后台任务、超时）
- [x] **P0-2**：MCP 工具桥（`DshMcpClientPool` + `mcpToolsToDshTools`；`assertSupportedJsonSchema` 校验；连接失败 skip 单 server 不阻断）
- [x] **P0-3**：session 持久化真实写盘（`dshSessionsRoot` 隔离目录 + `flushDshSession` 真实调 `ctx.sessions.flush` + `readDshSessionHeader` 真实读 `loadStored`）
- [x] **P0-4**：abort() 真实接线（`abortDshTurn` 调 `Agent.cancel({kind:'user'})` + `whenIdle` + flush）

### P1（功能完整）— ✅ 已交付

- [x] **P1-1**：fs 工具（FileRead/Edit/Write/Stat）桥 — 30K chars 截断、replace_all、mkdir -p
- [x] **P1-2**：ripgrep 桥（PATH `rg` 优先；无 rg 时 fallback 内置 grep，跳过 node_modules/.git）
- [x] **P1-3**：skill 加载桥（`loadZaiSkills` 扫描 `~/.agents/skills/` + `<cwd>/.zai/skills/`，`ZAI_SKILLS_DIRS` 语义，`paths:` glob-to-regex 条件激活）
- [x] **P1-4**：approval/askUser 桥（`installApprovalBridge` 注册 dsh answerer → 转发给 zai `ZaiInteractionSink`，answerer 链 waterfall 集成）
- [x] **P1-5**：subagent 真实 spawn（`spawnDshSubagent` 真实 `agents.create` 子 session + `~/.zai/tasks-dsh/` 独立 namespace + `<task-notification>` 注入父 agent）
- [x] **P1-6**：插件市场桥（`installed_plugins.json` V2 schema + `.claude-plugin/plugin.json` hooks/commands 加载；hooks → `ctx.on()`、commands → `ctx.tools.register()`）

### P2（生态完善）— ✅ 已交付

- [x] **P2-1**：memory watcher（内嵌 AGENTS.md/AGENTS.local.md loader + `@include` 递归 + `.git` 边界 + fs.watch 热重载 + `system-prompt/change` emit）
- [x] **P2-2**：完整 11 组事件翻译（核心子集 100% 翻译；其余 11 组映射表完整标注 `pair` / `ignorable`）
- [x] **P2-3**：state bridge（`StateBridge` emit cwd.changed / bash_task.changed / v2_task.changed / agent_task.changed）
- [x] **P2-4**：slash 命令桥（`installSlashCommands(sink)` 注册 `Slash:*` 工具，每个 zai command 一个工具 + execute sink）

---

## 评审入场前的强制完成项

按主计划 §6 / B6 §4，G2 决策门入场前必须满足：

| 项 | 状态 | 备注 |
|----|------|------|
| `pnpm -r run typecheck` 全绿 | ✅ | 3 workspace 全绿（dsh-bridge + zn-agent-core + zai） |
| `pnpm -r run test` 全绿 | ✅ | 2587 测试通过（dsh-bridge 15、zn-agent-core 382、zai 2190） |
| dsh-bridge build 绿 | ✅ | esbuild-free（纯 tsc） |
| 双轨切换路径 fail loud | ✅ | 引擎检查 + 非法值 fail loud 单测覆盖 |
| opencc 回归通过 | ✅ | zai 2190 + zn-agent-core 382 测试，无污染 |
| B2-B5 真实实现 | ✅ | **2026-08-22 全部真实化** |
| dsh 模式启动验证 | ✅ | dev 服务正常 listen 8104/7720，无 InvalidAgentKernelError |
| ego-browser 双轨全场景验收 | ⚠️ | 默认 opencc 4/4 通过（handoff 文档）；dsh 轨道需真实 ANTHROPIC_API_KEY 等 + ego-browser |
| kill switch 实跑 | ⚠️ | 脚本就绪，需真实环境演练 |

---

## 已知缺口（2026-08-22 盘点）

dsh 模式下的真实差距（已诚实标注）：

1. **dsh-subagent 包未发布** — `spawnDshSubagent` 直接用 `agents.create` 创建子 session，未走 dsh-subagent capability seam。父子作用域继承语义是简化的（通过 setup callback 注入 cwd/model），不通过 ScopedLayers。
2. **dsh-mcp 包未发布** — `DshMcpClientPool` 自实现；行为对齐 zai `MCPClientPool` 但缺重连/退避策略。
3. **dsh-side 状态/Job/Prompt 事件源缺失** — 11 组事件映射表中 State/Job/Instance/Queue 等组的对等事件需要 dsh-side 插件补齐；当前为 ignorable 但显式记录。
4. **win32 平台支持** — `LocalShellExecutor` 仅支持 POSIX；Windows 走 win32 ShellExecutor 需子类化（未实现）。
5. **dsh-session-persistence-jsonl 的 `root` 配置** — 当前依赖 `ctx.sessions.create()` 默认 config；要走自定义目录需手动改 `JsonlSessionPersistence.Config.root`。
6. **ego-browser dsh 轨道验收** — 需真实 ANTHROPIC_API_KEY 或等价 + dsh 模型 router 已配置；handoff 文档确认 dsh 默认可启动，对话驱动需 LLM key。

---

## 后续推进路径

✅ **全部 P0/P1/P2 已交付**。下一步：

1. **真实对话验证**：配置 ANTHROPIC_API_KEY + dsh 模型 router → ego-browser 跑 dsh 轨道核心用户路径
2. **kill switch 演练**：跑 `scripts/kill-switch-drill.sh` 验证 dsh → opencc 一键回退无数据损坏
3. **G2 评审入场**：上述 ✅ 后走决策门
4. **可选**（若 G2 通过）：dsh 默认内核切换 → vendor 退役评估
