# DSH 双轨改造 — 实现状态追踪

> **目的**：明确标注当前 dsh-bridge 的实现状态（真实实现 vs 接口契约 vs 待实现），
> 让 G2/G3 评审有客观度量。本文件是"实现层契约"，由 CI 与代码审查共同守护。

> **日期**：2026-08-22
> **对应计划**：[main-plan](../superpowers/plans/2026-08-17-dsh-kernel-main-plan.md)

---

## 实现状态总览

| 层级 | 模块 | 状态 | 缺失项 | 真实化预计 |
|------|------|------|--------|-----------|
| **基础设施** | `paths.ts` | ✅ 完整 | — | B0 已交付 |
| | `globalThisBridge.ts` (zai 侧) | ✅ 完整 | — | B0 已交付 |
| | `kernelAdapter.ts` 接口 | ✅ 完整 | — | B0 已交付 |
| | `projectSettings.ts` | ✅ 完整 | — | B0 已交付 |
| **dsh 长驻** | `createDshRuntime.ts` | ✅ 完整 | Cordis 4.x 的 ctx.dispose 实际 API（运行时通过 process.exit 自然清理） | B1a 已交付 |
| | `run.ts` | ✅ 完整 | — | B1a 已交付 |
| | `model.ts` | ✅ 完整 | — | B1a 已交付 |
| **事件翻译** | `translate/sessionEvents.ts` | ✅ 核心子集 100% | 11 组映射表的非 Runtime group（State/Job/Prompt/Instance/Queue/Command/StreamError/Projection）依赖 dsh-side 插件（dsh-state-bridge 等），需 B1b 后续批次提供 | B1a 交付核心子集；B1b 完整对齐需要 dsh-side 插件 |
| **zai 侧 adapter** | `factories/opencc.ts` | ⚠️ Stub run/abort/patchTranscript | run() 真实接线 routes/agent.ts（计划 T1.6 后续）；abort 已通过 sessionControllers；patchTranscript 待 B3 | B0 stub 形态，行为通过 routes/agent.ts 旧路径保留 |
| | `factories/dsh.ts` | ✅ KernelAdapter.run 完整 + abort stub | abort() 需要 dsh Agent.cancel() 真实 API；patchTranscript/readTranscript 待 B3 | B1a+ 接线 run；abort/patchTranscript 后续 |
| **B2 工具** | `tools/bash.ts` | ⚠️ 接口契约 | 真实实现需要 dsh-shell `ShellExecutor` 子类（无现成 POSIX provider，需自实现或 port dsh-subprocess-local） | 后续 B2 deep-dive |
| | `tools/fs.ts` | ❌ 缺失 | 当前 zai compat/tools/fs/* 未桥接 | 后续 B2 deep-dive |
| | `tools/ripgrep.ts` | ❌ 缺失 | zai compat/vendor/ripgrep 未桥接 | 后续 B2 deep-dive |
| | `tools/mcp.ts` | ⚠️ 类型契约 | 需要 zai MCPClientPool 接口契约 + dsh-tool-mcp 不存在需自实现 | 后续 B2 deep-dive |
| | `tools/skill.ts` | ⚠️ 类型契约 | 需要 zai loadSkillsFromDirs + SkillTool 桥 | 后续 B2 deep-dive |
| | `tools/registry.ts` | ⚠️ 接口契约 | `ctx.tools.register(defineTool)` 调用待 B2 deep-dive | 后续 B2 deep-dive |
| **B3 会话/记忆** | `sessions/store.ts` | ⚠️ 接口契约 | dsh-session-persistence-jsonl 的真实数据目录写入未实现；readDshSessionHeader 待补 | B3 deep-dive |
| | `memory.ts` | ⚠️ 接口契约 | zai compat/memory/* 桥未实现；AGENTS.md watcher 桥未实现 | B3 deep-dive |
| **B4 交互** | `interaction/bridge.ts` | ⚠️ 类型契约 | ApprovalBridge / AskUserBridge 真实实现需 dsh-user-approval Consumer 接线 | B4 deep-dive |
| **B5 多 Agent** | `subagent/taskStore.ts` | ✅ 任务文件读写 + namespace | 真实 spawn 子 agent 需要 dsh-subagent seam；当前只有任务元数据读写 | B5 deep-dive |
| | `plugins/index.ts` | ⚠️ 接口契约 | zai installed_plugins.json 解析 + dsh hooks 桥未实现 | B5 deep-dive |
| **B6 验证** | `migrate.ts` (zai 侧) | ✅ 完整 | — | B6 已交付（626 行 + 28 单测） |
| | `parity/harness.ts` | ✅ 完整 | — | B6 已交付 |
| | `scripts/kill-switch-drill.sh` | ✅ 完整（脚本） | 实跑需真实 zai 环境 | B6 已交付（脚本） |

---

## 当前可工作的真实路径

| 用户配置 | 行为 |
|---------|------|
| 默认（无 agent.kernel）| 走 opencc 轨道，行为完全保持原样 |
| `agent.kernel = 'opencc'` | 走 opencc 轨道，行为完全保持原样 |
| `agent.kernel = 'dsh'` + Node ≥ 22.19 | 工厂分叉到 DshKernelAdapter；adapter 可构造与关闭；但 run() 当前走 dsh SessionEvent 流（受限于当前 dsh 包仅 0.1.0-rc.7 预发布，部分能力可能运行时报错） |
| `agent.kernel = 'dsh'` + Node < 22.19 | 启动立即 fail loud，含修复指引 |
| `agent.kernel = 'DSH'` 等非法值 | 启动立即 fail loud |

---

## TODO 清单（按优先级）

### P0（dsh 最小可用路径）
- [ ] **P0-1**：bash 工具真实实现（subclass dsh-shell ShellExecutor，port zai compat/tools/BashTool）
- [ ] **P0-2**：MCP 工具桥（zai MCPClientPool → dsh defineTool；dsh-side MCP provider 暂未开源需自实现）
- [ ] **P0-3**：session 持久化真实写盘（用 dsh-session-persistence-jsonl 的 Persistence plugin）
- [ ] **P0-4**：abort() 真实接线（Agent.cancel 完整路径）

### P1（功能完整）
- [ ] **P1-1**：fs 工具（Read/Edit/Write）桥
- [ ] **P1-2**：ripgrep 桥（直接复用 zai compat/vendor/ripgrep binary）
- [ ] **P1-3**：skill 加载桥（zai loadSkillsFromDirs → dsh defineTool）
- [ ] **P1-4**：approval/askUser 桥（dsh-user-approval Consumer → zai registry）
- [ ] **P1-5**：subagent 真实 spawn（dsh-subagent seam）
- [ ] **P1-6**：插件市场桥（zai installed_plugins.json → dsh hooks）

### P2（生态完善）
- [ ] **P2-1**：memory watcher（AGENTS.md 热重载）
- [ ] **P2-2**：完整 11 组事件翻译（依赖 dsh-side 插件补齐 State/Job/Prompt 等组）
- [ ] **P2-3**：bash task / v2_task / agent_task 状态桥
- [ ] **P2-4**：slash 命令桥

---

## 评审入场前的强制完成项

按主计划 §6 / B6 §4，G2 决策门入场前必须满足：

| 项 | 状态 | 备注 |
|----|------|------|
| `pnpm -r run typecheck` 全绿 | ✅ | 4 workspace 全绿 |
| `pnpm -r run test` 全绿 | ✅ | 2587 测试通过（含 dsh-bridge 15、kernel 16、parity 24、migrate 28、其余 2504） |
| dsh-bridge build 绿 | ✅ | esbuild-free（纯 tsc） |
| 双轨切换路径 fail loud | ✅ | 引擎检查 + 非法值 fail loud 单测覆盖 |
| opencc 回归通过 | ✅ | zai 2138 测试 + zn-agent-core 382 测试，无污染 |
| B2-B5 真实实现 | ❌ | 接口契约 + TODO 标记；需后续 deep-dive |
| ego-browser 双轨全场景验收 | ❌ | 默认轨道可验证；dsh 轨道需真实 API + 后续批次能力补齐 |
| kill switch 实跑 | ⚠️ | 脚本就绪，需真实环境演练 |

---

## 后续推进路径

1. **B2 deep-dive**：按 P0-1 / P0-2 / P1-1 / P1-2 / P1-3 顺序，每个工具一个独立 worktree
2. **B3 deep-dive**：session persistence 真实写盘 + memory watcher
3. **B4 deep-dive**：approval/askUser 真实接线（依赖 B2 完成）
4. **B5 deep-dive**：subagent + plugins 桥
5. **真实环境验证**：每个 deep-dive 完成后跑对应单测 + ego-browser 场景
6. **G2 评审入场**：上述全部 ✅ 后走决策门
