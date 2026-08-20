# 主 Agent 插槽配置设计(系统提示词 / 工具列表 / MCP Server)

日期:2026-08-20
状态:设计定稿(待实施)

## 1. 背景与目标

zai 目前的主对话行为是固定的:系统提示词由 `constants/prompts.ts` 的 `getSystemPrompt()` 构建,工具池由 `getAllBaseTools()` + `computeTools()` 组成,MCP server 由 user/project/local/enterprise 四层 scope 配置解析后连接。用户无法针对不同使用场景(如纯办公)整体更换主对话的"人格 + 工具 + MCP"组合。

目标:zn-agent-core 支持**插槽配置**。三个插槽点(**系统提示词、工具列表、MCP server**)可被 **agent 配置**整体替换;agent 配置是 JS 对象,支持内置与外置用户配置两种来源;设置 UI 增加 Agent 选择;新增内置 Office 办公助手。

## 2. 插槽模型

每个插槽是 `(origin) => new` 的纯函数:`origin` 是系统默认值(未选任何 agent 时的产物),返回值替换默认。agent 可省略任意槽(省略 = 用默认),可只替换一个槽,也可基于 origin 过滤/追加。

| 插槽 | origin 类型 | 默认值来源(现状) |
|---|---|---|
| `systemPrompt` | `string[]` | `opencc-src/constants/prompts.ts:459` `getSystemPrompt()`,在 `QueryEngine.ts:374` 组装为 final systemPrompt |
| `tools` | `Tool[]` | `opencc-src/server/createOpenccRuntime-impl.ts:93` `computeTools()`(assembleToolPool + mergeAndFilterTools,内置 + MCP + 权限过滤后的最终工具池) |
| `mcp` | `McpServerSpec[]` | vendor `services/mcp/config.ts` 解析的 server 配置列表(连接前) |

> 注:gitStatus / claudeMd / currentDate 等动态上下文在 `userContext`,不在 `systemPrompt` 数组内,插槽不受影响。

## 3. Agent 配置格式

```ts
// zn-agent-core 主入口导出
export type MainAgentSlot<T> = (origin: T) => T | Promise<T>

export interface MainAgentConfig {
  /** 唯一 id,持久化到 settings.mainAgent */
  name: string
  description: string
  /** 系统提示词插槽:origin 为默认 prompt 数组 */
  systemPrompt?: MainAgentSlot<string[]>
  /** 工具列表插槽:origin 为最终工具池 */
  tools?: MainAgentSlot<Tool[]>
  /** MCP server 插槽:origin 为解析后的 server 配置列表 */
  mcp?: MainAgentSlot<McpServerSpec[]>
}
```

## 4. Agent 两种来源

### 4.1 内置 agents(zn-agent-core 代码内置)

`getBuiltinMainAgents(): MainAgentConfig[]`,包含:

- **`default`** — 无任何插槽,即现系统行为(恒等于不选 agent)。
- **`office`** — 办公助手,见 §7。
- **`agent-creator`** — 主 Agent 创作助手:systemPrompt 内置完整的外置 Agent 创作规范(文件位置、字段、三个插槽语义、工具真实名对照、生效时机、标准示例、工作流程),tools 白名单保留 `Read/Edit/Write/Glob/Grep/Bash/WebFetch/Skill/TodoWrite/AskUserQuestion` 并注入专属的 **`ValidateMainAgent`** 工具(不注册进 `getAllBaseTools`,仅 agent-creator 可见),生成/修改外置 agent 文件后强制调用该工具做配置校验;与用户共创外置 agent 并生成到 `~/.zai/main-agents/`。

### 4.2 外置用户配置(`~/.zai/main-agents/*.js`)

每个 `.js` 文件以 **`(ctx) => config` 工厂函数**导出(直接导出对象/数组的旧格式也兼容),CJS(`module.exports = (ctx) => ({...})`)或 ESM(`export default (ctx) => ({...})`)均可,zai-server 启动时用 dynamic import 加载,并把 `ctx`(`{ buildTool, z }`,工具构建能力,供 tools 槽创造自定义工具)传入:

```js
// ~/.zai/main-agents/my-assistant.js
module.exports = ({ buildTool, z }) => ({
  name: 'my-assistant',
  description: '我的自定义助手',
  systemPrompt: (origin) => [`你是我的私人助手。`, ...origin],
  tools: (origin) =>
    origin.filter((t) => ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'].includes(t.name)),
  mcp: (origin) => ({ ...origin, codegraph: { type: 'stdio', command: 'codegraph' } }),
})
```

**命名冲突**:内置 + 外置合并,重名时**外置覆盖内置**(允许用户定制/改写内置 agent 行为)。

**信任边界**:外置文件是用户自己目录下的可执行 JS,信任模型与 `~/.claude/agents` 的 subagent 文件一致;文件加载失败仅记日志,不阻断启动。

## 5. 插槽应用点(zn-agent-core 内,opencc-src 打 zai 补丁)

`createOpenccRuntime(options)` 新增可选 `mainAgent?: MainAgentConfig`(impl 内逐槽拆出),三处接线:

1. **systemPrompt 槽**:`QueryEngine` 构造参数新增 `systemPromptSlot?: (origin: string[]) => string[]`;在 `QueryEngine.ts:374` 组装 final systemPrompt 时,以 `customPrompt ?? defaultSystemPrompt` 为 origin 应用。engine 创建时固定 → **对新会话生效**。
2. **tools 槽**:`createOpenccRuntime-impl.ts:93` 的 `computeTools()` 返回值上应用 `mainAgent.tools(origin)`。`computeTools` 同时是 `refreshTools`(每次 query 调用)→ 工具槽对后续所有 query 即时生效。
3. **mcp 槽**:`getMcpToolsCommandsAndResources(cb, mcpConfigs?)`(client.ts:2285)已有第二个可选参数;impl 侧先取配置 → 应用 `mainAgent.mcp(origin)` → 传入连接。MCP 连接是启动时一次性 → **切换 agent 的 mcp 槽需重启生效**。

### 5.1 生效时机语义(用户已确认)

- **per-session 落盘与恢复(2026-08-20 追加)**:mainAgent 随会话首次 query 写入 transcript 的 `session-meta` entry(与 model/providerId 同机制,`legacyTranscriptStore.ts` patch + `findLatestSessionMeta` 读取);下次加载会话时从 meta 恢复,会话级固定 —— **已有会话保持当时选的 agent,不随全局切换变化**。新会话用当前全局设置并落盘。
  - `agent.ts` prompt 路由:读 meta.mainAgent → 无记录则用 `settings.mainAgent`(同步缓存,不阻塞热路径)并落盘 → 经 `OpenccQueryInput.mainAgent` 透传给 runtime。
  - `createOpenccRuntime-impl`:engine 创建时按 `input.mainAgent` 从 `options.mainAgents`(完整合并表)resolve 出该会话 agent,`systemPrompt` / `tools` 槽固定为该 agent。
- mcp 槽需重启生效(连接生命周期限制),保持全局。
- 设置 UI 明示「对新会话生效;MCP 槽需重启」,不做会话中途热切换。

## 6. zai-server 接线

- `packages/zai/src/shared/settings.ts`:`ZaiSettings` 增加 `mainAgent?: string`(默认 `'default'`;`BUILTIN_DEFAULT_SETTINGS` 同步)。
- 新增 `packages/zai/src/server/services/mainAgents.ts`:
  - `getBuiltinMainAgents()`(调 core 的 `getBuiltinMainAgents`)
  - `loadUserMainAgents()`(扫描 `~/.zai/main-agents/*.js`,dynamic import,校验 shape,外置覆盖内置)
  - `resolveMainAgent(name): MainAgentConfig`(合并表按名查找,未知名回退 `default`)
- `agentRuntime.ts` `initAgentRuntime()`:读 `zaiSettings.mainAgent` → `resolveMainAgent` → 传 `createOpenccRuntime({ mainAgent })`。
- `bundle-entry.ts`:显式 re-export `MainAgentConfig`(type)、`MainAgentSlot`(type)、`getBuiltinMainAgents`(value)。

## 7. Office 内置 agent(草案)

```ts
{
  name: 'office',
  description: '办公助手 —— 面向文档、表格、邮件与日常办公任务',
  systemPrompt: (origin) => [
    '你是 OpenCC 的办公助手。你擅长处理文档撰写与整理、表格计算、邮件起草、',
    '信息检索与汇总、日常办公自动化等任务。回复使用简体中文,条理清晰、',
    '直接给出可用的结果(完整的文案、表格、步骤)。',
    ...origin, // 保留 CWD/环境/语言等基础上下文
  ],
  tools: (origin) => origin.filter((t) => OFFICE_TOOL_ALLOWLIST.has(t.name)),
}
```

`OFFICE_TOOL_ALLOWLIST` 精简保留(约 10 个):

```
FileReadTool, FileEditTool, FileWriteTool, GrepTool, GlobTool,
BashTool, WebFetchTool, SkillTool, TodoWriteTool, AskUserQuestionTool
```

移除开发向工具:`AgentTool / WorkflowTool / LSPTool / EnterPlanModeTool / ExitPlanModeTool / TaskCreateTool / TaskGetTool / TaskUpdateTool / TaskListTool / WebBrowserTool / EnterWorktreeTool / ExitWorktreeTool / PowerShellTool / ListMcpResourcesTool / ReadMcpResourceTool / VerifyPlanExecutionTool` 等。

> 允许列表是白名单过滤而非黑名单,新工具默认不进 Office agent,避免工具池随 vendor 扩张而膨胀。

## 8. 设置 UI(Agent 选择)

- `GET /api/agent/settings`(agentSettings.ts:87)响应增加 `mainAgent`(当前选择)与 `mainAgents: { name; description }[]`(内置 + 外置合并,`default` 排首位)。
- 新增 `PUT /api/agent/settings/main-agent`,body `{ mainAgent: string }`;校验:值必须存在于 `mainAgents` 列表,否则 400;持久化仿 `work-mode` 路由(agentSettings.ts:126)。
- `SettingsDrawer.tsx`:「工作模式」section 内新增 enum 行 `key: 'mainAgent'`(紧随"工作模式"行下方),options 由 GET 返回的 `mainAgents` 动态渲染;切换走完整持久化路径(写 store + PUT)。生效时机注明:「对新会话生效;MCP 槽需重启」。

## 9. 测试计划

- `packages/zai/test/server/mainAgents.test.ts`:`loadUserMainAgents` 扫描/加载/覆盖/容错;`resolveMainAgent` 未知名回退。
- `agentSettings` 路由:GET 返回 `mainAgent` + `mainAgents`;PUT 校验与持久化(仿 work-mode 测试)。
- core 侧:`computeTools` 应用 tools 槽(过滤/增强);`systemPromptSlot` 组装;mcp 槽传入 `getMcpToolsCommandsAndResources`。
- 改动 core 后必须 `pnpm run build:core` 再验证;最终用 `/ego-browser` 走一遍设置页切换 Agent + 真实对话。

## 10. 风险与取舍

- vendor 两处改动(`QueryEngine.ts`、`createOpenccRuntime-impl.ts`)需 `build:core` 生效。
- mcp 槽启动时固定、systemPrompt 槽对新会话生效 —— 不做会话中途热切换,复杂度不值得。
- tools 槽是唯一即时生效的,只影响新 query 的工具池,符合直觉。
- 外置 agent JS 可执行任意代码,信任边界同 subagent 文件,文档注明。
