# Batch 3 — 会话与记忆

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> **状态**：✅ 已合入（commit `b7d8b130`，2026-08-17 前后）— G4 会话/记忆能力面达成
> 目标：dsh 轨道会话持久化（隔离目录）、transcript 桥（修复/续读）、记忆系统（AGENTS.md / rules watcher）桥接。依赖 B1a（B1b 的 transcript patchTranscript / readTranscript 由本批对接）。

---

## 1. 目标

- dsh 会话以事件溯源格式持久化到隔离目录（`${dataDir}/projects/<cwd>/dsh-sessions/<sessionId>/`），重启后可列出、可续读。
- 会话标题、元信息（model/permissionMode/custom-title）在 dsh 轨道可用（对齐 opencc 的 `session-meta` / `custom-title` 语义）。
- transcript 持久化（`appendUserMessageV2` 等）在 dsh 轨道有对等物：dsh 事件即权威源，前端 transcript 从 dsh session log 重建。
- 记忆系统（memory loader / watcher、`hasExternalIncludes`、AGENTS.md 热重载）在 dsh 轨道生效。

## 2. 前置条件

- B1a（dsh 长驻运行时）；B1b 的 `patchTranscript` / `readTranscript` 由本批对接。
- 盘点 zai transcript 持久化 API（`compat/transcript/persistence.ts`：`appendUserMessageV2` / `appendAssistantMessageV2` / `appendToolUse` / `appendToolResult`、`repairAndPersistTranscript`）当前被哪些调用方使用（routes/agent.ts、transcript.ts、compact 等）。
- 盘点 dsh `session-persistence-jsonl` 的 provider 接口（`SessionPersistence`）与 `sessions.flush` 语义。
- **任务 store 独立 namespace**：本批确认会话目录隔离（`dsh-sessions/`），任务 namespace 由 B5 落地（`~/.zai/tasks-dsh/` 或前缀方案，B0 T0.6 常量已定义）。

## 3. 任务清单

### T3.1 会话持久化桥

- **做什么**：dsh 轨道用 `dsh-session-persistence-jsonl` 写 `dsh-sessions/<sessionId>/`；`sessions.flush(agent.session)` 每次 turn 结束落盘；`listSessions` / `resumeSession` 从该目录重建 `SessionMeta` 与 Agent。
- **文件**：`packages/dsh-bridge/src/sessions/store.ts`。
- **验收**：重启 zai（dsh 轨道）后，历史会话出现在列表，可续读继续对话。

### T3.2 会话元信息映射

- **做什么**：title（首条 prompt 摘要）、custom-title、model、permissionMode 的读写映射到 dsh session header / meta；`/api/sessionState` 语义对齐。
- **文件**：`packages/dsh-bridge/src/sessions/meta.ts`。
- **验收**：dsh 轨道重命名会话、切换 model 后，重启仍保留。

### T3.3 transcript 桥（前端重建）

- **做什么**：前端 transcript 视图在 dsh 轨道从 dsh session log 重建：`SessionEvent` 序列 → `ServerEvent`/transcript 结构；`repairAndPersistTranscript` 的修复职责在 dsh 侧由 `dsh-session/repair`（`packages/core/session/src/repair.ts`）对等承担。
- **文件**：`packages/dsh-bridge/src/transcript/`、`packages/zai/src/server/routes/transcript.ts`（dsh 分支）。
- **验收**：dsh 轨道历史会话在 UI transcript 展示完整（含工具调用配对）。

### T3.4 记忆系统桥

- **做什么**：AGENTS.md / `.zai/rules` 的 memory loader + watcher（`compat/memory/`）在 dsh 轨道生效：dsh 的系统提示装配时注入 memory 内容；`hasExternalIncludes` 告警语义保留。
- **文件**：`packages/dsh-bridge/src/memory.ts`。
- **验收**：修改 AGENTS.md 后 dsh 轨道新一轮对话反映新记忆（watcher 热重载）；外部 include 告警 toast 出现。

### T3.5 会话压缩/整理

- **做什么**：评估 zai 的会话压缩能力（compact 命令、auto-compact）在 dsh 轨道的对等实现：dsh `compaction` capability 或 bridge 补丁实现（按 dsh 现状决定）。
- **文件**：`packages/dsh-bridge/src/compaction.ts`（若需要）。
- **验收**：dsh 轨道长会话可压缩且行为可观测（记录到已知差异清单，若 dsh 无对等物）。

## 4. 验收标准

1. dsh 轨道：创建会话 → 对话 → 重启 → 会话列表可见 → 续读对话成功。
2. dsh 轨道：title/model/permissionMode 重启保留。
3. dsh 轨道：UI transcript 与工具调用配对正确。
4. dsh 轨道：AGENTS.md 热重载生效；`ZAI_MEMORY` 语义对齐（若有）。
5. opencc 轨道回归：transcript / memory 相关单测绿。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh 事件溯源格式与 zai transcript 结构差异大 | 重建层做显式映射（T3.3），映射表文档化；「前端视图」为准，不追求底层格式一致 |
| `sessions.flush` 时机与 zai「实时落盘」体验差异 | 每 turn 结束 flush + 关键事件即时落盘（对齐 dsh `SESSION_FORMAT_VERSION` 规则） |
| 历史 opencc 会话在 dsh 轨道不可读 | 数据隔离（互不读取）；B6 迁移工具处理；dsh 轨道对 opencc 历史会话显示「未迁移」提示 |
| memory watcher 双轨双跑 | watcher 只在激活轨道启动（`initAgentRuntime` 按 `agent.kernel` 分支） |

## 6. 测试策略

- 单测：持久化读写、元信息映射、transcript 重建（构造 SessionEvent 序列 → 断言视图结构）、memory 装配。
- 集成：dsh 轨道「对话 → 重启 → 续读」全链路。
- 回归：opencc 轨道 transcript/memory 相关单测。
- ego-browser：dsh 轨道历史会话恢复 + transcript 展示。
