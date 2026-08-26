# Batch 2 — 工具与 MCP

> 所属主计划：[2026-08-17-dsh-kernel-main-plan.md](2026-08-17-dsh-kernel-main-plan.md)
> 目标：dsh 轨道具备与 opencc 轨道对等的**工具能力面**——核心工具（bash/fs/read/edit/write）、MCP 客户端工具、Skill 动态加载。依赖 B1 的运行时闭环。

---

## 1. 目标

- dsh 轨道可调用：bash、文件读写（Read/Edit/Write）、ripgrep、目录浏览等核心工具，且行为与 opencc 轨道对齐（含 cwd 跟踪、权限模式）。
- MCP 服务器工具在 dsh 轨道可用：复用 zai 的 `MCPClientPool` 与 `<cwd>/.mcp.json` 配置。
- Skill（`~/.agents/skills/`）在 dsh 轨道可动态加载并按 `skill.md` frontmatter 暴露。

## 2. 前置条件

- B1a（dsh 长驻运行时 + 模型桥；事件核心子集翻译到位）。
- B1b 不阻塞本批（工具事件翻译可在 B2 推进过程中同步完善）。
- 盘点 dsh 现有能力包：`dsh-fs`、`dsh-shell`（bash capability seam：Service Definition + bash-local provider + tool Consumer）、`dsh-tools` 注册 API（`ctx.tools.register(defineTool)`）。
- 确认 dsh 是否已有 MCP 包（若无，走自定义插件桥 zai MCPClientPool）。

## 3. 任务清单

### T2.1 工具注册基建

- **做什么**：在 dsh-bridge 实现统一工具注册入口 `registerZaiTools(ctx, { tools })`，把 zai 的 `buildDefaultTools()` 产物（`compat/tools/`）以 `defineTool` 形态注册进 dsh `ctx.tools`；保留 dsh 原生工具路径可同时注册。
- **文件**：`packages/dsh-bridge/src/tools/registry.ts`。
- **验收**：工具出现在 dsh 模型可调用清单（`agent.session` 的系统提示或工具列表可观测）。

### T2.2 核心工具桥（bash / fs）

- **做什么**：
  - bash：优先用 dsh `dsh-shell` capability seam（Service Definition + bash-local provider + Consumer），**不**直接复用 zai 的 bash 实现；若 dsh-shell 行为与 zai 差异大（cwd 跟踪、后台任务通知），在 bridge 补丁插件里对齐。
  - fs：复用 zai `compat/tools/` 的 Read/Edit/Write 实现（保持行为一致），以 defineTool 注册。
  - ripgrep：复用 zai `compat/vendor/ripgrep`。
- **文件**：`packages/dsh-bridge/src/tools/bash.ts`、`tools/fs.ts`、`tools/ripgrep.ts`。
- **验收**：dsh 轨道对话中触发「读文件 → 改文件 → 跑命令」链路成功；cwd 变化反映到 `state.cwd.changed`。

### T2.3 MCP 工具桥

- **做什么**：复用 zai `MCPClientPool`（`compat/mcp/MCPClientPool.ts`）+ `MCPToolAdapter` + `permission-matcher`，在 dsh 轨道注册为工具；连接语义沿用「按需连接，不阻塞启动」（对齐 `connectMcp:false` 现状）。
- **文件**：`packages/dsh-bridge/src/tools/mcp.ts`。
- **验收**：配置了 `.mcp.json` 的本地 MCP 服务器工具在 dsh 轨道可用；未配置时不阻塞启动。

### T2.4 Skill 加载桥

- **做什么**：复用 zai `loadSkillsFromDirs()`（`ZAI_SKILLS_DIRS` 语义），把解析出的 skill 包装为 dsh 工具注册；支持条件激活（`paths:` frontmatter 匹配）。**注**：zai 的 skill 实现位于 `compat/runtime/skills-*` 与 `compat/tools/opencc/SkillTool.ts`（无独立 `compat/skills/` 目录），本任务跨这两处引用。
- **文件**：`packages/dsh-bridge/src/tools/skill.ts`。
- **验收**：`~/.agents/skills/` 下既有 skill 在 dsh 轨道可被模型调用；`ZAI_SKILLS_DIRS=''` 显式禁用语义一致。

### T2.5 工具执行事件对齐

- **做什么**：确保 dsh 轨道工具调用的 `tool_call` / `tool_result` 事件经翻译后与 opencc 轨道的前端展示结构一致（工具名、输入、输出、耗时）。
- **文件**：`packages/dsh-bridge/src/translate/`。
- **验收**：前端 tool renderer（`web/` 既有组件）在 dsh 轨道渲染工具调用与 opencc 轨道一致。

## 4. 验收标准

1. dsh 轨道完成一条含「bash + 文件读写 + MCP 工具（如有配置）或 skill」的复合任务，全程流式可见。
2. 工具权限模式（permissionMode）语义与 opencc 轨道一致（本批含 bypass 模式即可；approve 弹窗在 B4 对齐）。
3. opencc 轨道回归：`compat/tools` 相关单测绿；`pnpm -r test` 相关文件绿。
4. 无 MCP/skill 配置时 dsh 轨道启动正常（不阻塞、不报错）。
5. **安全语义注释**（审查 R5 缓解）：B2 阶段 dsh 轨道的 `permissionMode='bypassPermissions'` 仅在用户在 settings 中**显式配置**时生效；默认走 ask 模式以避免「B4 完成前 dsh 轨道可绕过权限执行真实工具」的风险窗口。注释需写在 `packages/dsh-bridge/src/tools/permissionMode.ts` 顶部。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| dsh `dsh-shell` 的 bash 行为与 zai 现状差异（后台任务、cwd 跟踪） | 差异点以 bridge 补丁插件对齐；不兼容点记录到 B6 已知差异清单 |
| MCP 工具 schema 与 dsh 严格 JSON Schema 校验冲突 | 用 `assertSupportedJsonSchema` 预先校验/转换；异常工具显式报错并记录 |
| Skill frontmatter 解析与 dsh 工具 schema 差异 | skill 包装层统一转成 dsh `defineTool` schema；复用 zai 解析结果 |
| 双轨工具注册重复执行 | 注册按轨道隔离（opencc 走 `buildDefaultTools`，dsh 走 bridge），不在同一 ctx 混合 |

## 6. 测试策略

- 单测：工具注册清单、bash 命令执行（白名单命令）、fs 工具行为、skill 解析注册、MCP 适配（mock MCP server）。
- 集成：dsh 轨道真实对话驱动「读文件 → 改文件 → 跑 bash」。
- 回归：opencc 轨道工具相关单测。
- ego-browser：验证 dsh 轨道工具调用在前端的流式展示（工具卡片、结果折叠）。
