# OpenCC 插件运行时集成到 zai-agent-core 设计

- 日期：2026-07-15
- 状态：设计已确认，待实现计划
- 范围：运行时加载 OpenCC/ZAI 已安装插件；不包含 marketplace 安装、更新、卸载或 Web 管理 UI

## 1. 背景与目标

`zai-agent-core` 已具备 skills、agents、MCP 的运行时骨架，但当前只能通过显式目录加载 skills/agents，不能识别 OpenCC 插件的 manifest、启用状态、commands、插件 MCP 配置或 hooks。

本项目需要在不依赖 OpenCC CLI/TUI 的前提下，在 agent-core 内建立原生插件运行时，使已安装插件能够参与完整的 Agent 对话流程：

- 读取 OpenCC 与 ZAI 两套插件来源；
- 加载插件提供的 skills、agents、commands、MCP servers 和 hooks；
- 保持 OpenCC 插件格式与关键安全语义；
- 通过现有 `SkillTool`、`AgentTool`、`MCPClientPool` 和 runtime 事件链路暴露能力；
- 以真实插件端到端运行作为验收目标。

## 2. 已确认的决策

- 第一阶段覆盖：运行时加载 + MCP + hooks。
- 组件范围：Skills、Agents、Commands、MCP、hooks。
- 插件来源：OpenCC 与 ZAI 双源合并。
- 合并优先级：OpenCC 先加载，ZAI 后加载；重复插件或组件由 ZAI 覆盖。
- MCP 策略：已发现且启用的插件自动接入现有 `MCPClientPool`。
- hooks 策略：兼容 OpenCC 的 matcher/hooks schema 和主要生命周期事件；支持阻断型 hooks。
- 实现路线：agent-core 原生插件运行时，不直接依赖 OpenCC CLI/TUI，也不把 OpenCC 作为运行时依赖。
- Commands 语义：在 core 中作为可由 `SkillTool` 调用的 prompt，不实现 CLI 或 slash UI。
- 第一阶段不实现 marketplace 网络操作、插件安装/更新/卸载和管理 UI。

## 3. 总体架构

新增 `src/plugins/` 作为 agent-core 原生插件运行时，划分为四层：

### 3.1 Source adapters

分别读取两个插件源：

- OpenCC：默认读取 `OPENCC_CONFIG_DIR`、`CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的插件缓存、安装记录和启用配置；支持现有 OpenCC 插件无需迁移。
- ZAI：默认读取 `RuntimeConfig.dataDir/plugins`；可选读取 `RuntimeConfig.dataDir/plugins/settings.json` 的 `enabledPlugins`，或使用 `zai.settingsPath` 指定配置文件。未提供配置文件时默认启用发现到的 ZAI 插件。运行时显式 `zai.enabledPlugins` 优先于文件配置。

source adapter 只负责发现、读取和解析本地状态，不负责 marketplace 网络操作或插件管理。

### 3.2 Normalizer

把 OpenCC 插件 manifest、目录结构、frontmatter、`.mcp.json` 和 hooks 配置转换为 core 内部模型：

- `LoadedPlugin`
- `LoadedSkill`
- `AgentDefinition`
- `McpServerSpec`
- `PluginHook`
- `PluginLoadError`

Normalizer 不导入 OpenCC 源码，避免 core 重新依赖 OpenCC 的 Bun、CLI、TUI 和 settings 模块。

### 3.3 Merge registry

- 先注册 OpenCC 结果，再注册 ZAI 结果；
- 使用插件 ID 去重，ZAI 对同 ID 插件具有覆盖权；
- skills、commands、agents 使用稳定的插件命名空间，避免同名组件冲突；
- MCP server 使用插件命名空间，避免工具名冲突；
- 单插件或单组件失败进入结构化错误集合，不影响其他插件。

### 3.4 Runtime bridge

`queryEngine` 在 session 开始时获取插件快照：

- skills/commands 合并进本次 query 的 `LoadedSkill[]`；
- agents 合并进 `AgentTool` 的可用 agent 列表；
- 已启用插件的 MCP server 自动交给 `MCPClientPool`；
- hooks 注册到本次 session 的 `HookRunner`。

没有插件目录或有效配置时，插件运行时是 no-op。

## 4. 核心 API

建议新增并从 `runtime` 导出以下类型：

```ts
type HookExecutor = (request: {
  command: string
  event: string
  pluginId: string
  pluginRoot: string
  input: unknown
  signal: AbortSignal
}) => Promise<{
  blocked?: boolean
  output?: unknown
  error?: string
}>

type PluginRuntimeConfig = {
  enabled?: boolean
  opencc?: { configDir?: string; enabled?: boolean }
  zai?: {
    pluginsDir?: string
    settingsPath?: string
    enabled?: boolean
    enabledPlugins?: Record<string, boolean>
  }
  hookExecutor?: HookExecutor
}

type PluginSnapshot = {
  plugins: LoadedPlugin[]
  skills: LoadedSkill[]
  agents: AgentDefinition[]
  mcpServers: McpServerSpec[]
  hooks: PluginHook[]
  errors: PluginLoadError[]
}

interface PluginRuntime {
  load(options: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot>
  clearCache(): void
}
```

`RuntimeConfig` 增加可选的插件配置和 runtime 注入点；现有显式 `skillsDirs`、`userAgentsDir`、`mcpServers` 行为保持兼容，并与插件快照合并。

## 5. 组件规则

### 5.1 Skills 与 Commands

- 使用 YAML frontmatter 解析 Markdown；
- `SKILL.md` 按所在目录名生成名称；
- 普通 command 按文件名生成名称；
- 最终名称格式为 `plugin:<namespace>:<name>`；
- commands 与 skills 统一为可由 `SkillTool` 调用的 prompt；
- 支持参数替换、`CLAUDE_SKILL_DIR` 和插件根目录变量。

### 5.2 Agents

- 使用 YAML frontmatter 解析插件 agent；
- 复用并扩展现有 `AgentDefinition`；
- 插件 agent 的 `permissionMode`、单 agent hooks 和单 agent MCP 声明继续忽略；
- 保留插件根目录变量替换和命名空间；
- 加载失败只记录错误，不影响其他 agent。

### 5.3 MCP

支持插件 manifest 或 `.mcp.json` 中的：

- 内联 server 配置；
- 相对 JSON 文件路径；
- 多配置数组；
- MCPB/DXT 不在第一阶段支持；发现此类配置时记录 `unsupported-mcp-bundle` 结构化错误，其他 MCP server 继续加载。

所有相对路径必须限制在插件根目录内。server 名称加插件命名空间后交给现有 `MCPClientPool`。单个 server 连接失败只影响对应 server，不阻断普通对话。

### 5.4 Hooks

- 解析 manifest/hooks.json 或 manifest 内 hooks 配置；
- 保留 OpenCC 的事件名、matcher、命令定义和插件上下文；
- 支持 `${CLAUDE_PLUGIN_ROOT}` 等变量替换；
- 通过 `HookRunner` 统一执行，避免把 hook 生命周期散落到工具实现中；
- 第一阶段将事件映射限定为 `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact` 和 `PostCompact`；其他 OpenCC 事件记录为不支持的 hook 错误；
- 插件 agent 文件内的 hooks 不单独提升权限，继续遵守 OpenCC 的第三方插件安全边界。

## 6. 数据流与生命周期

一次 `runtime.run()` / `queryEngine()` 流程：

1. session 开始，两个 source adapter 并行读取插件状态；
2. 发现插件、校验 manifest 和组件路径；
3. 进入 registry 合并，ZAI 覆盖 OpenCC；
4. 生成 skills、agents、MCP servers、hooks 快照；
5. 构建 system prompt，注入插件 skills/commands、agents 列表和 MCP instructions；
6. 自动连接已启用插件的 MCP servers；
7. 工具执行前后及 session/subagent 生命周期触发 hooks；
8. session 结束时执行 SessionEnd/停止相关 hooks，并释放插件 MCP 连接；
9. 快照按 source 配置和目录状态缓存，显式 `clearCache()` 或状态变化后重新加载。

### 错误处理

- manifest、组件、MCP server 或 hook 的单点错误不会阻断其他插件；
- 路径越界、非法 manifest 等安全错误以结构化错误记录；
- 阻断型 hook 超时或执行失败沿用 OpenCC 的阻断语义，并通过 runtime 事件暴露原因；
- 非阻断型 hook 失败只记录错误；
- MCP 连接失败通过现有 MCP 健康状态处理，不向模型注册失效工具。

## 7. 测试与验收

### 7.1 Source adapter 单测

覆盖：

- OpenCC/ZAI 目录发现；
- enabledPlugins 合并与禁用过滤；
- 安装记录缺失、目录不存在和损坏配置；
- 双源同 ID 时 ZAI 覆盖；
- symlink、路径越界和恶意相对路径。

### 7.2 组件解析单测

覆盖：

- manifest、commands、`SKILL.md`、agents、hooks.json、`.mcp.json`；
- frontmatter、命名空间和变量替换；
- MCP 多种配置形式；
- 单组件错误不影响其他组件。

### 7.3 Runtime 集成测试

使用临时 OpenCC/ZAI 插件目录和真实 `DefaultAgentRuntime`，验证：

- SkillTool 能发现并调用插件 skill/command；
- AgentTool 能发现插件 agent；
- MCPClientPool 能连接并调用插件 server；
- HookRunner 能执行 Session、PreToolUse、PostToolUse 和失败 hooks；
- PreToolUse 阻断行为符合预期；
- 双源覆盖结果符合 ZAI 优先级；
- 插件加载失败时普通对话仍可继续。

### 7.4 端到端验收

使用一个真实 OpenCC 插件或等价 fixture，运行一次完整 agent-core 对话，确认模型可发现并调用插件 skill/command、delegation agent 和 MCP tool，且 hooks 在工具生命周期中执行。

不在本阶段测试 marketplace 安装、更新、卸载和 Web 管理 UI。

## 8. 非目标与约束

- 不把 OpenCC CLI/TUI 或 OpenCC package 作为 agent-core 运行时依赖；
- 不迁移 marketplace 管理能力；
- 不改变现有显式 skillsDirs、agents、MCP 配置的调用契约；
- 不默认授予插件 agent 超出用户已批准范围的 permission、hooks 或 MCP 权限；
- 不因单一插件损坏而让整个 runtime 启动失败。
