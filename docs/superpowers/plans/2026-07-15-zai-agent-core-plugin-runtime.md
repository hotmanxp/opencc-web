# ZAI Agent Core Plugin Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@zn-ai/zai-agent-core` 内实现不依赖 OpenCC CLI/TUI 的原生插件运行时，读取 OpenCC/ZAI 双源插件并让其 skills、agents、commands、MCP servers 和 hooks 参与完整 Agent session。

**Architecture:** 新增 `src/plugins/` 子系统，将 OpenCC/ZAI 本地插件状态适配成统一的 `PluginSnapshot`，以 ZAI 覆盖 OpenCC 的规则合并。`queryEngine` 在 session 开始加载快照，把 prompt 组件、agents、MCP servers 和 hooks 接入现有 runtime；HookRunner 通过注入的执行器运行插件 hooks，单插件错误进入结构化错误集合而不阻断其他插件。

**Tech Stack:** Node.js 20+, TypeScript 5, `fs/promises`, `path`, `js-yaml`, `zod`, `@modelcontextprotocol/sdk`, Vitest, 现有 `MCPClientPool`、`SkillTool`、`AgentTool` 和 transcript/runtime 事件。

## Global Constraints

- 不把 OpenCC CLI/TUI、OpenCC package 或 OpenCC 源码模块作为 agent-core runtime 依赖。
- OpenCC source 默认读取 `OPENCC_CONFIG_DIR`、`CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `plugins/installed_plugins.json`、安装缓存和启用配置。
- ZAI source 默认读取 `RuntimeConfig.dataDir/plugins`；可通过 `plugins.zai.settingsPath` 指定 `enabledPlugins` 文件，缺少该文件时默认启用发现到的 ZAI 插件；`plugins.zai.enabledPlugins` 优先于文件配置。
- OpenCC 结果先合并，ZAI 结果后合并；重复插件 ID 由 ZAI 覆盖。
- 第一阶段不实现 marketplace 网络操作、插件安装/更新/卸载和 Web 管理 UI。
- Commands 在 core 中作为 `SkillTool` 可调用的 prompt，不实现 CLI/slash UI。
- 第一阶段只支持 MCP inline config、相对 JSON 配置和配置数组；MCPB/DXT 必须返回 `unsupported-mcp-bundle` 错误且不阻断其他 MCP server。
- 第一阶段支持 hooks：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`；其他事件返回不支持错误。
- 所有插件相对路径必须通过 realpath/path-boundary 校验，不能逃逸插件根目录。
- 单插件、单组件、单 MCP server 或非阻断 hook 失败不阻断普通对话；阻断型 hook 保留 OpenCC 的阻断语义。
- 保持显式 `skillsDirs`、`userAgentsDir`、`mcpServers` 和现有 runtime 调用契约兼容。
- 实现过程采用 TDD：先写失败测试，再写最小实现，再运行包级测试和类型检查。

---

## 文件地图

### 新增文件

- `packages/zai-agent-core/src/plugins/types.ts` — 插件源、manifest、快照、组件、hook 和结构化错误类型。
- `packages/zai-agent-core/src/plugins/paths.ts` — OpenCC/ZAI 默认目录及可注入路径解析。
- `packages/zai-agent-core/src/plugins/manifest.ts` — manifest 解析、schema 校验和插件根目录内路径解析。
- `packages/zai-agent-core/src/plugins/sources/opencc.ts` — OpenCC 安装记录、启用配置和缓存目录发现。
- `packages/zai-agent-core/src/plugins/sources/zai.ts` — ZAI 插件目录与启用配置发现。
- `packages/zai-agent-core/src/plugins/registry.ts` — 双源加载、ZAI 覆盖规则、snapshot 聚合和缓存清理。
- `packages/zai-agent-core/src/plugins/components/markdown.ts` — 插件 Markdown/frontmatter 通用读取与命名空间。
- `packages/zai-agent-core/src/plugins/components/skills.ts` — skills 与 commands 组件加载。
- `packages/zai-agent-core/src/plugins/components/agents.ts` — 插件 agents 加载与 `AgentDefinition` 转换。
- `packages/zai-agent-core/src/plugins/components/mcp.ts` — manifest/`.mcp.json` 到 `McpServerSpec` 的转换。
- `packages/zai-agent-core/src/plugins/components/hooks.ts` — hooks.json/manifest hooks 解析与事件过滤。
- `packages/zai-agent-core/src/plugins/HookRunner.ts` — matcher、超时、阻断结果和执行器调度。
- `packages/zai-agent-core/src/plugins/index.ts` — 插件 runtime 类型、默认实现和公共导出。
- `packages/zai-agent-core/test/plugins/paths.test.ts` — 路径解析测试。
- `packages/zai-agent-core/test/plugins/manifest.test.ts` — manifest 与路径安全测试。
- `packages/zai-agent-core/test/plugins/sources.test.ts` — OpenCC/ZAI source 与合并测试。
- `packages/zai-agent-core/test/plugins/components.test.ts` — skills/commands/agents/MCP/hooks 解析测试。
- `packages/zai-agent-core/test/plugins/HookRunner.test.ts` — hooks 执行和阻断测试。
- `packages/zai-agent-core/test/plugins/runtime.test.ts` — PluginRuntime 聚合测试。
- `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/...` — OpenCC 格式端到端 fixture。
- `packages/zai-agent-core/test/fixtures/plugins/zai-plugin/...` — ZAI 格式及覆盖场景 fixture。

### 修改文件

- `packages/zai-agent-core/src/runtime/types.ts` — 增加插件配置、PluginRuntime 注入和 query 级插件覆盖类型。
- `packages/zai-agent-core/src/runtime/index.ts` — 导出插件 runtime/API。
- `packages/zai-agent-core/src/runtime/queryEngine.ts` — session 级插件加载、prompt/agent/MCP/hook 接线和清理。
- `packages/zai-agent-core/src/runtime/toolExecution.ts` — PreToolUse/PostToolUse/PostToolUseFailure hook 生命周期。
- `packages/zai-agent-core/src/tools/AgentTool/loadAgentsDir.ts` — 支持把插件 agent 与 built-in/project/user agent 合并。
- `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts` — 同步子 agent 路径使用 session 插件 agent 快照，并触发 subagent hooks。
- `packages/zai-agent-core/src/tools/AgentTool/prompt.ts` — 说明插件 agent 来源和命名规则。
- `packages/zai-agent-core/src/runtime/skills/types.ts` — 增加 skill/command 的来源与插件元数据。
- `packages/zai-agent-core/package.json` — 增加 `./plugins` export（若构建产物目录结构需要）。
- `packages/zai-agent-core/README.md` — 增加插件配置、来源、生命周期和安全边界说明。
- `packages/zai-agent-core/test/runtime/queryEngine.test.ts` — 增加插件 skills/commands/agents/hook 生命周期验证。
- `packages/zai-agent-core/test/runtime/queryEngine-mcp.test.ts` — 增加插件 MCP 自动接入和失败隔离验证。
- `packages/zai-agent-core/test/tools/AgentTool.test.ts` — 增加插件 agent 发现和 subagent hook 验证。

---

### Task 1: 建立插件契约、配置和路径解析

**Files:**
- Create: `packages/zai-agent-core/src/plugins/types.ts`
- Create: `packages/zai-agent-core/src/plugins/paths.ts`
- Modify: `packages/zai-agent-core/src/runtime/types.ts:41-88`
- Modify: `packages/zai-agent-core/src/runtime/skills/types.ts:28-48`
- Modify: `packages/zai-agent-core/src/runtime/index.ts:1-25`
- Test: `packages/zai-agent-core/test/plugins/paths.test.ts`

**Interfaces:**
- Consumes: 现有 `RuntimeConfig`、`LoadedSkill`、`McpServerSpec` 和 `dataDir` 约定。
- Produces: `PluginRuntimeConfig`、`PluginSourceName`、`LoadedPlugin`、`PluginSnapshot`、`PluginRuntime`、`PluginLoadError`、`resolveOpenccConfigDir()`、`resolveOpenccPluginsDir()`、`resolveZaiPluginsDir()`。

- [ ] **Step 1: 写路径解析失败测试**

在 `paths.test.ts` 中使用 `homedir`/环境变量覆盖测试，不修改真实用户目录：

```ts
test('OpenCC 目录优先使用显式 configDir，其次 OPENCC_CONFIG_DIR，再次 CLAUDE_CONFIG_DIR', () => {
  expect(resolveOpenccConfigDir({ configDir: '/explicit' })).toBe('/explicit')
  expect(resolveOpenccConfigDir({ env: { OPENCC_CONFIG_DIR: '/opencc', CLAUDE_CONFIG_DIR: '/claude' } })).toBe('/opencc')
  expect(resolveOpenccConfigDir({ env: { CLAUDE_CONFIG_DIR: '/claude' } })).toBe('/claude')
})

test('ZAI 插件目录默认为 dataDir/plugins，允许显式覆盖', () => {
  expect(resolveZaiPluginsDir('/zai')).toBe('/zai/plugins')
  expect(resolveZaiPluginsDir('/zai', '/custom/plugins')).toBe('/custom/plugins')
})
```

- [ ] **Step 2: 运行路径测试确认失败**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/paths.test.ts`
Expected: FAIL，提示路径解析函数尚未导出或文件不存在。

- [ ] **Step 3: 写插件契约和纯路径实现**

在 `types.ts` 固化后续任务使用的类型：

```ts
export type PluginSourceName = 'opencc' | 'zai'
export type PluginComponent = 'skills' | 'commands' | 'agents' | 'mcp' | 'hooks'

export type PluginManifest = {
  name: string
  version?: string
  description?: string
  commands?: unknown
  agents?: unknown
  skills?: unknown
  mcpServers?: unknown
  hooks?: unknown
  [key: string]: unknown
}

export type PluginCandidate = {
  // Canonical merge key is manifest.name. OpenCC's original marketplace ID
  // remains in sourceRef for enabledPlugins lookup and diagnostics.
  id: string
  name: string
  source: PluginSourceName
  sourceRef: string
  root: string
  manifest: PluginManifest
}

export type LoadedPlugin = PluginCandidate & { enabled: true }

export type PluginHook = {
  event: string
  matcher?: string
  command: string
  pluginId: string
  pluginRoot: string
  timeoutMs?: number
}

export type PluginLoadError = {
  code: string
  message: string
  source?: PluginSourceName
  pluginId?: string
  component?: PluginComponent
  path?: string
  detail?: unknown
}

export type PluginCandidateResult = {
  candidates: PluginCandidate[]
  errors: PluginLoadError[]
}

export type HookExecutor = (request: {
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

export type PluginRuntimeConfig = {
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

export type PluginSnapshot = {
  plugins: LoadedPlugin[]
  skills: LoadedSkill[]
  agents: AgentDefinition[]
  mcpServers: McpServerSpec[]
  pluginMcpServerNames: string[]
  hooks: PluginHook[]
  errors: PluginLoadError[]
}

export function emptyPluginSnapshot(): PluginSnapshot {
  return { plugins: [], skills: [], agents: [], mcpServers: [], pluginMcpServerNames: [], hooks: [], errors: [] }
}

export interface PluginRuntime {
  load(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot>
  clearCache(): void
}
```

在 `RuntimeConfig` 增加 `plugins?: PluginRuntimeConfig` 和可选 `pluginRuntime?: PluginRuntime`；在 `LoadedSkill` 增加 `kind?: 'skill' | 'command'`、`pluginId?: string`、`source?: 'disk' | 'mcp' | 'plugin'`，不删除现有字段。

- [ ] **Step 4: 运行路径和类型测试确认通过**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/paths.test.ts && pnpm --filter @zn-ai/zai-agent-core typecheck`
Expected: PASS；类型检查只允许后续实现尚未被引用的新增类型存在。

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/plugins/types.ts packages/zai-agent-core/src/plugins/paths.ts packages/zai-agent-core/src/runtime/types.ts packages/zai-agent-core/src/runtime/skills/types.ts packages/zai-agent-core/src/runtime/index.ts packages/zai-agent-core/test/plugins/paths.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 建立插件运行时契约
EOF
)"
```

### Task 2: 实现 manifest、frontmatter 和路径安全边界

**Files:**
- Create: `packages/zai-agent-core/src/plugins/manifest.ts`
- Create: `packages/zai-agent-core/src/plugins/errors.ts`
- Test: `packages/zai-agent-core/test/plugins/manifest.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LoadedPlugin`、`PluginLoadError`、`PluginComponent`。
- Produces: `readPluginManifest(root)`、`parsePluginManifest(raw, path)`、`resolvePluginPath(root, relativePath, component)`、`readJsonFileIfPresent(path)`。

- [ ] **Step 1: 写 manifest 与安全边界失败测试**

测试 `.claude-plugin/plugin.json` 优先级、root `plugin.json` fallback、非法 name、缺 manifest、`../`、绝对路径和 symlink 越界：

```ts
test('优先读取 .claude-plugin/plugin.json 并返回规范化 manifest', async () => {
  await writeJson(join(root, '.claude-plugin/plugin.json'), { name: 'demo-plugin', version: '1.0.0' })
  const result = await readPluginManifest(root)
  expect(result.manifest.name).toBe('demo-plugin')
  expect(result.manifestPath).toBe(join(root, '.claude-plugin/plugin.json'))
})

test.each(['../outside.md', '/tmp/outside.md'])('拒绝越过插件根目录的组件路径 %s', async rel => {
  await expect(resolvePluginPath(root, rel, 'skills')).rejects.toMatchObject({ code: 'plugin_path_outside_root' })
})
```

- [ ] **Step 2: 运行 manifest 测试确认失败**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/manifest.test.ts`
Expected: FAIL，提示导入函数不存在。

- [ ] **Step 3: 实现 manifest schema 和 realpath boundary**

使用 `js-yaml` 仅解析 Markdown frontmatter，使用 `zod` 校验 JSON manifest 的 `name`、`version`、`description`、`commands`、`agents`、`skills`、`mcpServers`、`hooks` 字段；通过 `realpath` + `relative(root, candidate)` 保证最终路径仍处于插件根目录。缺失 manifest 返回结构化 `manifest_not_found`，JSON/YAML 无法解析返回 `manifest_parse_error`，不向外抛出未分类异常。

- [ ] **Step 4: 验证解析和安全测试**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/manifest.test.ts`
Expected: PASS，覆盖正常、缺失、非法 JSON、路径越界和 symlink 场景。

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/plugins/manifest.ts packages/zai-agent-core/src/plugins/errors.ts packages/zai-agent-core/test/plugins/manifest.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 增加插件清单与路径校验
EOF
)"
```

### Task 3: 实现 OpenCC/ZAI source discovery 与 ZAI 覆盖合并

**Files:**
- Create: `packages/zai-agent-core/src/plugins/sources/opencc.ts`
- Create: `packages/zai-agent-core/src/plugins/sources/zai.ts`
- Create: `packages/zai-agent-core/src/plugins/registry.ts`
- Test: `packages/zai-agent-core/test/plugins/sources.test.ts`

**Interfaces:**
- Consumes: Task 1 的路径/config 类型和 Task 2 的 manifest/path API。
- Produces:
  - `loadOpenccPluginCandidates(input: { configDir: string; cwd: string }): Promise<PluginCandidateResult>`
  - `loadZaiPluginCandidates(input: { pluginsDir: string; settingsPath?: string; enabledPlugins?: Record<string, boolean> }): Promise<PluginCandidateResult>`
  - `PluginRegistry.load({ cwd, signal }): Promise<PluginSnapshot>` 的插件候选阶段。

- [ ] **Step 1: 写 OpenCC 安装状态和双源合并失败测试**

在临时目录创建真实 OpenCC 文件结构：

```ts
await writeJson(join(openccPlugins, 'installed_plugins.json'), {
  version: 2,
  plugins: {
    'demo@marketplace': [{ scope: 'user', installPath: openccPluginRoot }],
    'project-only@marketplace': [{ scope: 'project', projectPath: cwd, installPath: projectPluginRoot }],
  },
})
await writeJson(join(cwd, '.claude/settings.json'), {
  enabledPlugins: { 'demo@marketplace': true, 'project-only@marketplace': false },
})
await writeJson(join(zaiPlugins, 'settings.json'), {
  enabledPlugins: { 'demo@marketplace': true },
})
```

断言 user/匹配 project 安装、禁用项过滤、ZAI 同 manifest name 替换 OpenCC、source 不存在或坏 JSON 不阻断其他 source。OpenCC 的 marketplace key 保存为 `sourceRef`；启用配置同时接受完整 sourceRef 和 canonical manifest name。

- [ ] **Step 2: 运行 source 测试确认失败**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/sources.test.ts`
Expected: FAIL，提示 source loader/registry 尚未实现。

- [ ] **Step 3: 实现 OpenCC source adapter**

只读取 `plugins/installed_plugins.json` 中有效 `installPath`；按 `scope` 过滤：`user`/`managed` 始终可用，`project`/`local` 只有 `projectPath === cwd` 才可用。启用状态读取当前配置目录和 `cwd/.claude/settings.json`、`cwd/.claude/settings.local.json` 的 `enabledPlugins`，后出现的更具体配置覆盖前者。缺失文件返回空候选，坏文件追加结构化错误。

- [ ] **Step 4: 实现 ZAI source adapter 和 registry**

扫描 `pluginsDir` 的直接子目录；每个子目录交给 `readPluginManifest`。ZAI `settingsPath` 缺失时默认启用所有发现的插件；设置文件或 `enabledPlugins` 显式为 `false` 时禁用。registry 先写 OpenCC Map，再写 ZAI Map，按 `plugin.id` 做 replace，并把候选错误保留到 `snapshot.errors`。

- [ ] **Step 5: 验证 source 与 merge 测试**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/sources.test.ts`
Expected: PASS；ZAI 覆盖、scope 过滤、禁用和错误隔离均有断言。

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/src/plugins/sources/opencc.ts packages/zai-agent-core/src/plugins/sources/zai.ts packages/zai-agent-core/src/plugins/registry.ts packages/zai-agent-core/test/plugins/sources.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 支持 OpenCC 与 ZAI 插件双源发现
EOF
)"
```

### Task 4: 加载插件 skills、commands、agents、MCP 和 hooks 配置

**Files:**
- Create: `packages/zai-agent-core/src/plugins/components/markdown.ts`
- Create: `packages/zai-agent-core/src/plugins/components/skills.ts`
- Create: `packages/zai-agent-core/src/plugins/components/agents.ts`
- Create: `packages/zai-agent-core/src/plugins/components/mcp.ts`
- Create: `packages/zai-agent-core/src/plugins/components/hooks.ts`
- Test: `packages/zai-agent-core/test/plugins/components.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LoadedPlugin`、`resolvePluginPath` 和 Task 3 的候选插件。
- Produces:
  - `loadPluginSkills(plugin): Promise<LoadedSkill[]>`
  - `loadPluginCommands(plugin): Promise<LoadedSkill[]>`
  - `loadPluginAgents(plugin): Promise<AgentDefinition[]>`
  - `loadPluginMcpServers(plugin): Promise<{ servers: McpServerSpec[]; errors: PluginLoadError[] }>`
  - `loadPluginHooks(plugin): Promise<{ hooks: PluginHook[]; errors: PluginLoadError[] }>`

- [ ] **Step 1: 写组件加载失败测试**

fixture 至少包含：`skills/review/SKILL.md`、`commands/build.md`、`agents/reviewer.md`、`.mcp.json`、`hooks/hooks.json` 和一个非法组件。断言：

```ts
expect(skills[0]).toMatchObject({
  name: 'plugin:demo-plugin:review',
  kind: 'skill',
  pluginId: 'demo-plugin@marketplace',
})
expect(commands[0]).toMatchObject({
  name: 'plugin:demo-plugin:build',
  kind: 'command',
})
expect(agents[0]).toMatchObject({ name: 'plugin:demo-plugin:reviewer' })
expect(mcp.servers[0]!.name).toBe('plugin:demo-plugin:echo')
expect(hooks[0]).toMatchObject({ event: 'PreToolUse', pluginId: plugin.id })
```

另测普通 command 目录内的 `SKILL.md`、manifest 追加 paths、`${CLAUDE_PLUGIN_ROOT}` 替换、MCPB/DXT 被标为 `unsupported-mcp-bundle`、无效单组件不影响其他组件。

- [ ] **Step 2: 运行组件测试确认失败**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/components.test.ts`
Expected: FAIL，提示组件 loader 尚未实现。

- [ ] **Step 3: 实现 Markdown、skill 和 command loader**

递归读取标准目录和 manifest 追加路径；识别 `SKILL.md` 时使用所在目录名，普通 Markdown 使用不含 `.md` 的文件名；名称统一为 `plugin:<pluginName>:<relativeNamespace>`。保留 `baseDir`、`filePath`、frontmatter、markdown，并写入 `kind`/`pluginId`/`source`。复用现有参数替换，不把完整 body 注入 system prompt。

- [ ] **Step 4: 实现 agent loader**

使用 `js-yaml` 解析 frontmatter，生成现有 `AgentDefinition`；加载标准 `agents/` 和 manifest 追加文件；名称为 `plugin:<pluginName>:<namespace>:<agentName>`。替换 `${CLAUDE_PLUGIN_ROOT}`，忽略插件 agent 文件内的 `permissionMode`、`hooks`、`mcpServers` 字段并记录 debug warning。

- [ ] **Step 5: 实现 MCP loader**

读取根目录 `.mcp.json`、manifest `mcpServers` 的对象/相对 JSON/数组形式；相对 JSON 通过 Task 2 的边界函数限制在插件根目录；把 stdio/sse/http 配置转换为现有 `McpServerSpec`，名称前缀为 `plugin:<pluginName>:`；遇到 `.mcpb`/`.dxt` 只追加 `unsupported-mcp-bundle` 错误。

- [ ] **Step 6: 实现 hooks config loader**

合并 `hooks/hooks.json` 和 manifest inline/path hooks；只保留 Global Constraints 中列出的事件；保留 matcher、command、pluginId、pluginRoot；变量替换只作用于执行时 command，不把 plugin root 原文暴露到无关 prompt。

- [ ] **Step 7: 验证组件测试与类型检查**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/components.test.ts && pnpm --filter @zn-ai/zai-agent-core typecheck`
Expected: PASS；非法组件有结构化错误，合法组件的命名空间和变量替换正确。

- [ ] **Step 8: Commit**

```bash
git add packages/zai-agent-core/src/plugins/components packages/zai-agent-core/test/plugins/components.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 加载插件运行时组件
EOF
)"
```

### Task 5: 实现 HookRunner 和默认 hook 执行器

**Files:**
- Create: `packages/zai-agent-core/src/plugins/HookRunner.ts`
- Create: `packages/zai-agent-core/src/plugins/defaultHookExecutor.ts`
- Modify: `packages/zai-agent-core/src/runtime/types.ts:26-88`（导出 `HookExecutor` 所需请求/结果类型）
- Test: `packages/zai-agent-core/test/plugins/HookRunner.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `PluginHook[]` 和 `RuntimeConfig.sandbox`。
- Produces:

```ts
export type HookRunResult = {
  event: string
  ran: number
  blocked: boolean
  outputs: unknown[]
  errors: PluginLoadError[]
}

export class HookRunner {
  constructor(hooks: PluginHook[], executor: HookExecutor)
  run(event: string, input: unknown, signal: AbortSignal): Promise<HookRunResult>
}
```

- [ ] **Step 1: 写 matcher、执行顺序、超时和阻断测试**

使用注入的 fake executor，不启动 shell：

```ts
const calls: string[] = []
const runner = new HookRunner([
  { event: 'PreToolUse', matcher: 'Bash', command: 'first', pluginId: 'p', pluginRoot: root },
  { event: 'PreToolUse', matcher: '.*', command: 'second', pluginId: 'p', pluginRoot: root },
], async request => {
  calls.push(request.command)
  return request.command === 'first' ? { blocked: true, output: 'denied' } : {}
})
const result = await runner.run('PreToolUse', { toolName: 'Bash' }, signal)
expect(calls).toEqual(['first'])
expect(result.blocked).toBe(true)
```

另测 matcher 不匹配不执行、非阻断错误继续后续 hook、AbortSignal 取消、超时转换错误和空 hook 列表。

- [ ] **Step 2: 运行 HookRunner 测试确认失败**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/HookRunner.test.ts`
Expected: FAIL，提示 HookRunner 尚未实现。

- [ ] **Step 3: 实现 HookRunner**

按配置顺序过滤同 event 的 matcher；matcher 为空匹配所有输入，非空 matcher 对 `toolName`/`command` 等事件字段做正则匹配。`PreToolUse` 和 `Stop` 是第一阶段允许阻断的事件，遇到 `blocked` 立即停止后续同事件 hook；Session、Prompt、PostTool 和 Subagent 事件只记录结果并继续执行。非阻断错误加入结果但继续执行。每个 hook 使用合并 abort signal 和明确 timeout。

- [ ] **Step 4: 实现默认 child_process executor**

将 command 在 `pluginRoot` 作为 cwd 执行，向 stdin 写入 JSON input，继承受限环境变量，支持 `AbortSignal` 和 timeout；返回 exit code、stdout/stderr 摘要；非零退出在阻断型事件中返回 `blocked: true`，其他事件返回错误结果。调用方提供 `hookExecutor` 时完全替换默认执行器。

- [ ] **Step 5: 验证 HookRunner 测试和类型检查**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/HookRunner.test.ts && pnpm --filter @zn-ai/zai-agent-core typecheck`
Expected: PASS；fake executor 测试不依赖系统命令，default executor 的单测使用当前 Node 可执行的 `process.execPath`。

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/src/plugins/HookRunner.ts packages/zai-agent-core/src/plugins/defaultHookExecutor.ts packages/zai-agent-core/src/runtime/types.ts packages/zai-agent-core/test/plugins/HookRunner.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 增加插件 hook 执行器
EOF
)"
```

### Task 6: 构建 PluginRuntime 并接入 query、tools 和 MCP 生命周期

**Files:**
- Create: `packages/zai-agent-core/src/plugins/index.ts`
- Modify: `packages/zai-agent-core/src/plugins/registry.ts`
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts:26-433`
- Modify: `packages/zai-agent-core/src/runtime/contract.ts:16-46`
- Modify: `packages/zai-agent-core/src/runtime/toolExecution.ts:63-270`
- Modify: `packages/zai-agent-core/src/tools/AgentTool/loadAgentsDir.ts:80-102`
- Modify: `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts:69-105`
- Modify: `packages/zai-agent-core/src/tools/AgentTool/prompt.ts:28-57`
- Modify: `packages/zai-agent-core/src/runtime/index.ts:1-25`
- Test: `packages/zai-agent-core/test/plugins/runtime.test.ts`
- Test: `packages/zai-agent-core/test/runtime/queryEngine.test.ts`
- Test: `packages/zai-agent-core/test/runtime/queryEngine-mcp.test.ts`
- Test: `packages/zai-agent-core/test/tools/AgentTool.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 的 PluginRuntime、组件 loader、HookRunner 和 `MCPClientPool`。
- Produces: `DefaultPluginRuntime`，并让 `queryEngine()` 对 `RuntimeConfig.plugins` 自动加载插件；现有直接调用 `queryEngine()` 的测试在无插件目录时行为不变。

- [ ] **Step 1: 写 PluginRuntime 聚合失败测试**

使用 Task 3/4 fixture，断言 `load()` 一次返回所有组件、错误和 plugin MCP server names：

```ts
const snapshot = await runtime.load({ cwd, signal: new AbortController().signal })
expect(snapshot.plugins.map(p => p.id)).toEqual(['demo'])
expect(snapshot.skills.map(s => s.name)).toContain('plugin:demo:review')
expect(snapshot.agents.map(a => a.name)).toContain('plugin:demo:reviewer')
expect(snapshot.pluginMcpServerNames).toEqual(['plugin:demo:echo'])
expect(snapshot.errors).toEqual([])
```

- [ ] **Step 2: 运行聚合测试确认失败**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/runtime.test.ts`
Expected: FAIL，提示 `DefaultPluginRuntime` 尚未实现。

- [ ] **Step 3: 实现 DefaultPluginRuntime**

registry 加载 source candidates 后并行加载每个插件的 skills、commands、agents、MCP、hooks；使用一次 promise cache 避免同一 runtime 并发扫描两次；`clearCache()` 清除 source 和 snapshot cache。返回 `pluginMcpServerNames`，供 session 结束时只断开插件 server，不断开调用方显式配置的 MCP server。

- [ ] **Step 4: 在 queryEngine session 开头合并插件资源**

在现有 skills/MCP boot 之前加载 snapshot：

```ts
const pluginRuntime = config.pluginRuntime ?? new DefaultPluginRuntime(config.plugins)
const pluginSnapshot = config.plugins?.enabled === false
  ? emptyPluginSnapshot()
  : await pluginRuntime.load({ cwd: options.cwd, signal: options.abortSignal })
const explicitSkills = await loadSkillsFromDirs(options.skillsDirs ?? config.skillsDirs ?? [], { cwd: options.cwd })
const skills = [...explicitSkills, ...pluginSnapshot.skills]
const mcpServers = [...(config.mcpServers ?? []), ...pluginSnapshot.mcpServers]
```

把 `mcpServers` 作为局部变量贯穿 connect/adapt/snapshot，不覆盖 `config.mcpServers`。system prompt 的 agents 列表使用 built-in/project/user agents 与 `pluginSnapshot.agents` 合并后的结果；SkillTool state 使用合并后的 skills。`DefaultAgentRuntime` 构造时默认创建启用插件的 `DefaultPluginRuntime`；低层直接调用 `queryEngine()` 且没有 `config.plugins` 时保持插件关闭，避免现有单测和嵌入调用意外读取宿主用户目录。显式传入 `config.plugins` 时按配置启用/关闭。

- [ ] **Step 5: 接入工具和 subagent agent 列表**

将 `pluginSnapshot.agents` 放入 tool context state；同步 `AgentTool` 优先从该 session 快照查找 agent，找不到时保持现有 `loadAgentDefinitions` fallback。后台子 agent 通过共享 `RuntimeConfig.pluginRuntime`/`plugins` 在自己的 query 中重新加载插件；现有 subagent start/done 事件前后调用 `SubagentStart`/`SubagentStop` hooks。

- [ ] **Step 6: 接入 tool hooks**

在 `executeToolsStreaming` 中：

1. 对每个可执行 tool 运行 `PreToolUse`；返回 blocked 时写入 error tool result、yield `tool_use:denied` 并跳过实际工具调用。
2. `tool.call` 成功后运行 `PostToolUse`，失败/抛错后运行 `PostToolUseFailure`。
3. hook 结果通过现有 `RuntimeEvent` 泛型事件携带 `plugin.hook:*`，不改变旧事件字段。

- [ ] **Step 7: 接入 session/prompt/stop hooks 和资源清理**

将原 query loop 放入内部 `runQuery()`，外层 `queryEngine()` 负责 session hook 生命周期：

- 首条 user prompt 前运行 `SessionStart` 和 `UserPromptSubmit`；
- 普通 text-only 完成前运行 `Stop`；若阻断且未达到 maxTurns，将 hook 输出作为新的 user context 继续下一轮；
- maxTurns 或 model/tool 错误路径运行 `StopFailure`；
- `finally` 中运行 `SessionEnd`，并仅断开 `pluginMcpServerNames`；
- hooks 失败按 Task 5 规则转为错误事件，不改变已有 runtime.done/runtime.error 的结束协议。

- [ ] **Step 8: 运行插件 runtime/query/MCP/agent 测试**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/plugins/runtime.test.ts test/runtime/queryEngine.test.ts test/runtime/queryEngine-mcp.test.ts test/tools/AgentTool.test.ts`
Expected: PASS；旧 query/tool 测试保持通过，新增测试验证插件 skills/commands/agents、MCP 自动连接、PreToolUse 阻断、PostToolUse、Stop 和 SessionEnd。

- [ ] **Step 9: Commit**

```bash
git add packages/zai-agent-core/src/plugins/index.ts packages/zai-agent-core/src/plugins/registry.ts packages/zai-agent-core/src/runtime/queryEngine.ts packages/zai-agent-core/src/runtime/contract.ts packages/zai-agent-core/src/runtime/toolExecution.ts packages/zai-agent-core/src/tools/AgentTool packages/zai-agent-core/src/runtime/index.ts packages/zai-agent-core/test/plugins/runtime.test.ts packages/zai-agent-core/test/runtime/queryEngine.test.ts packages/zai-agent-core/test/runtime/queryEngine-mcp.test.ts packages/zai-agent-core/test/tools/AgentTool.test.ts
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): 接入插件运行时生命周期
EOF
)"
```

### Task 7: 完成真实插件 fixture、包导出、文档和全量验证

**Files:**
- Create: `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/.claude-plugin/plugin.json`
- Create: `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/skills/review/SKILL.md`
- Create: `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/commands/build.md`
- Create: `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/agents/reviewer.md`
- Create: `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/.mcp.json`
- Create: `packages/zai-agent-core/test/fixtures/plugins/opencc-plugin/hooks/hooks.json`
- Create: `packages/zai-agent-core/test/fixtures/plugins/zai-plugin/.claude-plugin/plugin.json`
- Create: `packages/zai-agent-core/test/fixtures/plugins/zai-plugin/skills/review/SKILL.md`
- Modify: `packages/zai-agent-core/package.json:7-16`
- Modify: `packages/zai-agent-core/README.md:25-76`
- Test: `packages/zai-agent-core/test/plugins/e2e.test.ts`

**Interfaces:**
- Consumes: Task 6 已接入的 `DefaultPluginRuntime` 和 `DefaultAgentRuntime`。
- Produces: 可重复运行的真实本地 fixture 和公开 `@zn-ai/zai-agent-core/plugins` 导出。

- [ ] **Step 1: 创建最小真实 fixture**

OpenCC fixture manifest 使用 `name: demo`，ZAI fixture 使用相同插件 ID 但不同 skill body，以验证 ZAI 覆盖；`.mcp.json` 只使用当前 MCP transport 支持的 stdio 配置；hook command 使用 `process.execPath` 调用 fixture 脚本或最小 Node `-e` 命令，避免依赖外部二进制。

- [ ] **Step 2: 写端到端 fixture 测试**

使用临时 `dataDir/plugins` 和显式 OpenCC `configDir`，配置 `modelCaller: makeMockModelCaller(...)`，断言：

```ts
const events = await collect(runtime.run({ prompt: 'use the review plugin', cwd }))
expect(events.at(-1)?.type).toBe('runtime.done')
expect(capturedSystemPrompt).toContain('plugin:demo:review')
expect(capturedTools.some(tool => tool.name === 'Skill')).toBe(true)
expect(hookCalls).toContain('PreToolUse')
```

另测 fixture MCP server 能被发现；MCP server 失败时普通 text-only query 仍返回 runtime.done。

- [ ] **Step 3: 增加 package export 和 README**

在 `package.json` 增加 `"./plugins": "./dist/plugins/index.js"`，在 `README.md` 说明：

- `plugins` 配置对象及 OpenCC/ZAI 默认路径；
- ZAI 覆盖 OpenCC 的规则；
- commands 作为 SkillTool prompt；
- MCP 自动接入和不支持 MCPB/DXT；
- hooks 支持事件、`hookExecutor` 注入和第三方插件安全边界；
- marketplace 安装/更新/管理不属于 agent-core。

- [ ] **Step 4: 运行包级全量验证**

Run: `pnpm --filter @zn-ai/zai-agent-core test`
Expected: PASS，包含所有新增插件测试和既有测试。

Run: `pnpm --filter @zn-ai/zai-agent-core typecheck && pnpm --filter @zn-ai/zai-agent-core build`
Expected: PASS，`dist/plugins/index.js` 和类型声明存在。

Run: `pnpm test`
Expected: PASS，根 Vitest 不出现 zai 或 zai-agent-core 回归。

- [ ] **Step 5: 检查变更范围和工作树**

Run: `git diff --check && git status --short`
Expected: 无 whitespace error；工作树只包含本计划内的实现、测试、包导出和 README 变更。

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/test/fixtures/plugins packages/zai-agent-core/test/plugins/e2e.test.ts packages/zai-agent-core/package.json packages/zai-agent-core/README.md
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 test(zai-agent-core): 验证插件端到端运行
EOF
)"
```

## 完成标准

- `PluginRuntime` 可从 OpenCC 与 ZAI 双源发现已安装插件，并按 ZAI 优先级合并。
- skills、commands、agents、MCP 和 hooks 均有独立解析测试。
- `queryEngine` 能在真实 session 中暴露插件 prompt/agent/MCP 能力并执行 hooks。
- 单插件或单组件错误不阻断普通对话，路径越界和不支持 bundle 有结构化错误。
- `pnpm --filter @zn-ai/zai-agent-core test`、`typecheck`、`build` 和根 `pnpm test` 全部通过。
- README 与 public exports 反映实际配置和边界。
