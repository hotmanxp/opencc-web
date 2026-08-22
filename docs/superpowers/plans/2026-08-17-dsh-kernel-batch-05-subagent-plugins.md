# Batch 5 — 多 Agent 与插件

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> **状态**：✅ 已合入（commit `b7d8b130`，2026-08-17 前后）— G6 多 Agent / 插件 / Slash 命令能力面达成
> 目标：dsh 轨道的多 Agent / 后台任务、插件市场、Slash 命令能力面对齐。依赖 B2（工具）+ B3（会话）+ B4（交互）。

---

## 1. 目标

- 子 agent / 后台任务在 dsh 轨道可用：zai 的 BackgroundRuntime 语义（后台任务启动、进度、结果回传、`<task-notification>` 续传）映射到 dsh `ScopedLayers` + `dsh-subagent`。
- 任务持久化在 dsh 轨道**独立 namespace**（`~/.zai/tasks-dsh/` 或 `~/.zai/tasks/dsh-<taskId>.json` 前缀方案）——**禁止与 opencc 共用 `~/.zai/tasks/<taskId>.json`**（审查 R4 修正）。
- 插件市场（`~/.zai/plugins/`，V2 schema）在 dsh 轨道可加载：zai 插件（hooks/commands/skills 类）通过桥注册进 dsh ctx。
- Slash 命令（builtin + 用户定义）在 dsh 轨道可用。

## 2. 前置条件

- B2、B3、B4。
- 盘点 zai 多 agent 现状：`backgroundRuntime.ts`、`DefaultBackgroundRuntime`、`subagentNotifier.ts`、`taskListStore.ts`、`JsonTaskStore`、`BackgroundAgentResultTool` / `TaskOutputTool`。
- 盘点 dsh 现状：`dsh-scope`（`ScopedLayers`、父子 scope 继承）、`dsh-subagent`（subagent capability seam）、agent-loop 的 `agents.create` 父子关系。
- 盘点 dsh hooks 桥（`packages/hooks/`：Claude Code/Codex hook bridge + wire protocol）对 zai 插件 hooks 的映射潜力。

## 3. 任务清单

### T5.1 子 agent / 后台任务映射

- **做什么**：设计映射：
  - zai `BackgroundRuntime.startTask` → dsh 子 agent（父子作用域，子 agent 继承父 cwd/模型）。
  - 进度事件（`job.started/progress/done/failed`）→ 从 dsh 子 agent 的 SessionEvent 翻译。
  - 结果回传 → `<task-notification>` 续传父 session 的语义用 dsh `agent/…` 事件对齐。
- **文件**：`packages/dsh-bridge/src/subagent/`。
- **验收**：dsh 轨道发起后台任务 → 前端 drawer 可见 → 完成 → 父会话收到通知续传。

### T5.2 任务 store 桥（**独立 namespace**）

- **做什么**：dsh 轨道任务 store **不复用** opencc 的 `~/.zai/tasks/<taskId>.json`，走**独立 namespace**：`~/.zai/tasks-dsh/<taskId>.json`（子目录）或 `~/.zai/tasks/dsh-<taskId>.json`（前缀）。常量由 B0 T0.6 给出。任务事件先写盘后 emit、Last-Event-ID 续读语义保留。**禁止两轨共享同一文件**——ID 空间、schema、续读语义均不同。
- **文件**：`packages/dsh-bridge/src/subagent/taskStore.ts`。
- **验收**：dsh 轨道任务重启后仍可续读（与 opencc 轨道语义一致）；opencc 任务文件不被 dsh 写入；dsh 任务文件不被 opencc 写入。

### T5.3 插件市场桥

- **做什么**：zai 插件（`~/.zai/plugins/` V2 schema，`installed_plugins.json`）在 dsh 轨道加载：插件内的 hooks / commands / skills 定义经桥注册进 dsh ctx；优先评估 dsh `hooks/` 包（wire protocol）映射 zai 插件 hooks。
- **文件**：`packages/dsh-bridge/src/plugins/`。
- **验收**：安装一个既有 zai 插件（如 superpowers），dsh 轨道可触发其 hook / 命令。

### T5.4 Slash 命令桥

- **做什么**：builtin + 用户 slash 命令（`commands/registry.ts`、`slashList`、`routes/slash.ts`）在 dsh 轨道可用：slash 执行路径仍走 zai 命令实现，dsh 只负责「模型/用户触达」接线。
- **文件**：`packages/dsh-bridge/src/commands/`。
- **验收**：dsh 轨道输入 `/status` 等 builtin 命令行为与 opencc 轨道一致。

### T5.5 会话级任务通知（subagent notifier）

- **做什么**：`subagentNotifier.ts` 的 `<task-notification>` 在 dsh 轨道对等：子任务结束时父 session 收到通知并续传。
- **文件**：`packages/dsh-bridge/src/subagent/notifier.ts`。
- **验收**：dsh 轨道子任务完成 → 父对话自动续传。

## 4. 验收标准

1. dsh 轨道：后台任务全链路（启动 → 进度 → 完成 → 通知续传）可用。
2. dsh 轨道：任务 store 重启可续读。
3. dsh 轨道：已安装插件可加载并生效（至少 1 个真实插件验证）。
4. dsh 轨道：builtin + 用户 slash 命令可用。
5. opencc 轨道回归：background / tasks / plugins / commands 相关单测绿。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh 子 agent 模型与 zai BackgroundRuntime 语义差异大（作用域 vs 独立运行时） | 映射以「用户可见行为」为准（drawer 任务卡片、通知续传）；底层机制差异记录到 B6 已知差异 |
| 插件 hooks 与 dsh 事件模型不兼容 | 优先用 dsh `hooks/` wire protocol 映射；不兼容插件在 dsh 轨道标记「不支持」并 fail loud |
| 子 agent 递归防护（zai `subagent-recursion-prevention`）在 dsh 轨道缺失 | 复用 zai 现有递归防护策略，桥层注入 |
| 任务并发与 `dsh-scope` 的父子关系组合复杂度 | 先做单层子 agent（一个后台任务一个子 agent），嵌套在 B6 已知差异中评估 |

## 6. 测试策略

- 单测：任务 store 读写、subagent 通知、slash 命令注册、插件加载（mock 插件）。
- 集成：dsh 轨道「派发后台任务 → 完成 → 父续传」全链路。
- 回归：opencc 轨道 background / tasks / plugins / commands 相关单测。
- ego-browser：dsh 轨道后台任务 drawer + 插件命令 + slash 的真实浏览器验证。
