# zai Web 端插件管理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai Web 工具栏增加插件管理按钮，弹出弹框管理已安装插件与浏览 marketplace 安装，复用 opencc 现有服务层（`installPluginOp` / `uninstallPluginOp` / `setPluginEnabledOp` / `updatePluginOp` / `loadAllPlugins` / `refreshActivePlugins`）。

**Architecture:** 服务层挂在 `OpenccRuntime.plugins` 命名空间上而非新开 bundle。`loadAllPlugins` 是模块级 memoize，每个 `-impl` 独立 esbuild 打包产生独立 vendor 副本，独立 `pluginFacade-impl` bundle 会清错缓存使热重载静默失效。`createOpenccRuntime-impl.ts` 直接 import 兄弟 impl，zai 进程内只加载它一份。HTTP 层薄路由直调 `runtime.plugins.*`；DTO 通过 type-only 再导出共享。UI 沿用 antd Modal + Tabs + useAppStore 既有模式。

**Tech Stack:** TypeScript、Express、React、Zustand、Ant Design、Vitest、supertest、Bun/pnpm。

## Global Constraints

- 不 kill 920x 端口的 zai 正式服务进程；开发验收用 `pnpm --filter @zn-ai/zai dev` 启动独立 dev 服务（端口 8101 区域）。
- 用 Bun-direct 运行 zai，不要用 tsc 整编 `opencc-src/`。
- 真实浏览器验收用 `/ego-browser` skill（ego-browser 驱动），**禁止**用 Chrome DevTools MCP、Playwright、Puppeteer、`curl + WebFetch` 替代。
- `dist/opencc-src/server/` 的 `.d.ts` 必须自包含（`verify-server-types-self-contained.mjs` 校验），新增的 DTO 在 `serverTypes.ts` 内平铺声明，**不 re-export** vendor 类型。
- 写操作（enable / disable / install / uninstall / update）同步等热重载完成再返回；写操作返回的 `state` 字段含最新列表与错误，前端用它直接替换本地状态。
- 写操作一律落 `user` 全局作用域；`project` / `local` 装的插件**只读**展示。
- 不自动创建 git commit；只有用户明确要求提交时才执行提交流程。

---

### Task 1: 在 `serverTypes.ts` 中新增 DTO 与 `OpenccPluginApi` 类型

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts:236-255`（`OpenccRuntime` 定义末尾）

**Interfaces:**
- Consumes: 无
- Produces:
  - `OpenccPluginDto`、`OpenccMarketplacePluginDto`、`OpenccPluginActionResult`（DTO）
  - `OpenccPluginApi`（API 形状）
  - `OpenccRuntime.plugins: OpenccPluginApi` 字段

- [ ] **Step 1: 在 `serverTypes.ts` 末尾（`OpenccRuntime` 闭合 `}` 之后）追加类型定义**

```ts
export type OpenccPluginScope = 'user' | 'project' | 'local' | 'builtin'

export type OpenccPluginComponentCounts = {
  commands: number
  agents: number
  skills: number
  hooks: number
  mcpServers: number
}

export type OpenccPluginDto = {
  id: string
  name: string
  description?: string
  version?: string
  author?: string
  marketplace: string
  scope: OpenccPluginScope
  enabled: boolean
  writable: boolean
  hasUpdate: boolean
  components: OpenccPluginComponentCounts
  errors: string[]
}

export type OpenccMarketplacePluginDto = {
  id: string
  name: string
  description?: string
  version?: string
  author?: string
  marketplace: string
  category?: string
  tags?: string[]
  installed: boolean
  homepage?: string
}

export type OpenccPluginListResult = {
  plugins: OpenccPluginDto[]
  errors: string[]
}

export type OpenccPluginReloadCounts = {
  plugins: number
  commands: number
  agents: number
  hooks: number
  mcpServers: number
  errors: number
}

export type OpenccPluginActionResult = {
  success: boolean
  message: string
  reloadFailed?: boolean
  reload?: OpenccPluginReloadCounts
  state?: OpenccPluginListResult
}

export type OpenccPluginApi = {
  listInstalled(): Promise<OpenccPluginListResult>
  listAvailable(): Promise<OpenccMarketplacePluginDto[]>
  setEnabled(id: string, enabled: boolean): Promise<OpenccPluginActionResult>
  install(id: string): Promise<OpenccPluginActionResult>
  uninstall(id: string): Promise<OpenccPluginActionResult>
  update(id: string): Promise<OpenccPluginActionResult>
  reload(): Promise<OpenccPluginActionResult>
}
```

- [ ] **Step 2: 在 `OpenccRuntime` 闭合 `}` 之前新增 `plugins` 字段**

将 `OpenccRuntime`（当前 `serverTypes.ts:236-255`）改写为：

```ts
export type OpenccRuntime = {
  query(input: OpenccQueryInput): AsyncIterable<OpenccServerEvent>
  abort(sessionId: string, reason?: string): Promise<void>
  getSession(sessionId: string): Promise<OpenccTranscriptMeta | null>
  listSessions(opts?: {
    cwd?: string
    includeSubagent?: boolean
  }): Promise<OpenccTranscriptMeta[]>
  readTranscript(
    sessionId: string,
    opts: { cwd: string },
  ): Promise<OpenccTranscriptFile>
  patchSession(
    sessionId: string,
    patch: { title?: string; tags?: string[] },
    opts: { cwd: string },
  ): Promise<void>
  removeSession(sessionId: string, opts: { cwd: string }): Promise<void>
  shutdown(): Promise<void>
  plugins: OpenccPluginApi
}
```

- [ ] **Step 3: 跑 typecheck 确认无回归**

Run: `pnpm -r --filter @zn-ai/zn-agent-core exec tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: 跑 verify-server-types-self-contained 确认 DTO 自包含**

Run: `pnpm --filter @zn-ai/zn-agent-core typecheck:server-types-self-contained`
Expected: 通过（说明 DTO 没从 `../services/...` 或 `../utils/...` 拉取类型）。

---

### Task 2: 抽离纯函数 `assemblePluginList`

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/pluginListAssembly.ts`
- Create: `packages/zn-agent-core/test/opencc-src/server/pluginListAssembly.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  ```ts
  export function assemblePluginList(
    loadResult: PluginLoadResult,
    installedV2: InstalledPluginsFileV2,
    enabledSettings: Record<string, boolean> | undefined,
    componentCounts: Map<string, OpenccPluginComponentCounts>,
  ): OpenccPluginListResult
  ```

- [ ] **Step 1: 创建 `pluginListAssembly.ts`（含 `OpenccPluginComponentCounts` 输入类型）**

路径：`packages/zn-agent-core/src/opencc-src/server/pluginListAssembly.ts`：

```ts
/**
 * Pure assembly of installed-plugin DTOs.
 *
 * Pulled out of `createOpenccRuntime-impl.ts` so the merge logic
 * (`loadAllPlugins()` result + installed_plugins v2 + `enabledPlugins`
 * settings + per-plugin component counts → `OpenccPluginDto[]`) can be
 * unit-tested without touching the filesystem. Pure function, no I/O.
 *
 * Lives next to `serverTypes.ts` (same emit) so the `.d.ts` stays
 * self-contained per `verify-server-types-self-contained.mjs`.
 */
import type { PluginError, PluginLoadResult, LoadedPlugin } from '../../types/plugin.js'
import type { InstalledPluginsFileV2 } from '../../utils/plugins/installedPluginsManager.js'
import type {
  OpenccPluginDto,
  OpenccPluginListResult,
  OpenccPluginScope,
  OpenccPluginComponentCounts,
} from './serverTypes.js'
import { getPluginErrorMessage } from '../../types/plugin.js'

const WRITABLE_SCOPES: ReadonlySet<OpenccPluginScope> = new Set(['user', 'builtin'])

function isBuiltinPluginId(id: string): boolean {
  return id.endsWith('@builtin')
}

function scopeToWritable(scope: OpenccPluginScope, isBuiltin: boolean): boolean {
  if (isBuiltin) return true
  return WRITABLE_SCOPES.has(scope)
}

function deriveScope(
  pluginName: string,
  installedV2: InstalledPluginsFileV2,
): OpenccPluginScope {
  if (isBuiltinPluginId(pluginName)) return 'builtin'
  const v2 = installedV2.plugins[pluginName]
  if (!v2) return 'user'
  const scopes = Object.keys(v2.installs ?? {})
  if (scopes.includes('user')) return 'user'
  if (scopes.includes('project')) return 'project'
  if (scopes.includes('local')) return 'local'
  return 'user'
}

function errorsForPlugin(
  pluginName: string,
  errors: PluginError[],
): string[] {
  return errors
    .filter((e) => 'plugin' in e && e.plugin === pluginName)
    .map(getPluginErrorMessage)
}

function topLevelErrors(errors: PluginError[]): string[] {
  return errors
    .filter((e) => !('plugin' in e && e.plugin))
    .map(getPluginErrorMessage)
}

function toDto(
  plugin: LoadedPlugin,
  installedV2: InstalledPluginsFileV2,
  enabledSettings: Record<string, boolean> | undefined,
  componentCounts: Map<string, OpenccPluginComponentCounts>,
  errors: PluginError[],
  hasUpdateFor: (id: string) => boolean,
): OpenccPluginDto {
  const id = `${plugin.name}@${plugin.repository}`
  const isBuiltin = plugin.isBuiltin === true
  const scope = isBuiltin ? 'builtin' : deriveScope(plugin.name, installedV2)
  // enabled: built-in always reads enabledPlugins; otherwise read from settings.
  const enabled = isBuiltin
    ? (enabledSettings?.[id] ?? true)
    : (enabledSettings?.[id] ?? plugin.enabled === true)
  return {
    id,
    name: plugin.name,
    description: plugin.manifest.description,
    version: plugin.manifest.version,
    author: plugin.manifest.author
      ? typeof plugin.manifest.author === 'string'
        ? plugin.manifest.author
        : plugin.manifest.author.name
      : undefined,
    marketplace: plugin.repository,
    scope,
    enabled,
    writable: scopeToWritable(scope, isBuiltin),
    hasUpdate: hasUpdateFor(id),
    components: componentCounts.get(plugin.name) ?? {
      commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0,
    },
    errors: errorsForPlugin(plugin.name, errors),
  }
}

export function assemblePluginList(
  loadResult: PluginLoadResult,
  installedV2: InstalledPluginsFileV2,
  enabledSettings: Record<string, boolean> | undefined,
  componentCounts: Map<string, OpenccPluginComponentCounts>,
  hasUpdateFor: (id: string) => boolean = () => false,
): OpenccPluginListResult {
  const all = [...loadResult.enabled, ...loadResult.disabled]
  const plugins = all.map((p) =>
    toDto(p, installedV2, enabledSettings, componentCounts, loadResult.errors, hasUpdateFor),
  )
  return { plugins, errors: topLevelErrors(loadResult.errors) }
}
```

- [ ] **Step 2: 创建测试文件 `pluginListAssembly.test.ts`**

路径：`packages/zn-agent-core/test/opencc-src/server/pluginListAssembly.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { LoadedPlugin, PluginError, PluginLoadResult } from '../../src/opencc-src/types/plugin.js'
import type { InstalledPluginsFileV2 } from '../../src/opencc-src/utils/plugins/installedPluginsManager.js'
import type { OpenccPluginComponentCounts } from '../../src/opencc-src/server/serverTypes.js'
import { assemblePluginList } from '../../src/opencc-src/server/pluginListAssembly.js'

function makePlugin(overrides: Partial<LoadedPlugin>): LoadedPlugin {
  return {
    name: 'plug',
    manifest: { name: 'plug', version: '1.0.0' },
    path: '/p',
    source: 'src',
    repository: 'market',
    ...overrides,
  } as LoadedPlugin
}

const EMPTY_COUNTS: OpenccPluginComponentCounts = { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }

describe('assemblePluginList', () => {
  it('一个 user 作用域插件带 enabled 状态', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'a', enabled: true })],
      disabled: [],
      errors: [],
    }
    const v2: InstalledPluginsFileV2 = { version: 2, plugins: { a: { installs: { user: { path: '/p' } } } } }
    const enabled = { 'a@market': true }
    const counts = new Map<string, OpenccPluginComponentCounts>([['a', { ...EMPTY_COUNTS, commands: 3 }]])
    const r = assemblePluginList(load, v2, enabled, counts)
    expect(r.plugins).toEqual([{
      id: 'a@market', name: 'a', version: '1.0.0', marketplace: 'market',
      scope: 'user', enabled: true, writable: true, hasUpdate: false,
      components: { commands: 3, agents: 0, skills: 0, hooks: 0, mcpServers: 0 },
      errors: [],
    }])
    expect(r.errors).toEqual([])
  })

  it('project 作用域 → writable=false', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'p' })], disabled: [], errors: [] }
    const v2: InstalledPluginsFileV2 = { version: 2, plugins: { p: { installs: { project: { path: '/p' } } } } }
    const r = assemblePluginList(load, v2, {}, new Map())
    expect(r.plugins[0].scope).toBe('project')
    expect(r.plugins[0].writable).toBe(false)
  })

  it('local 作用域 → writable=false', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'l' })], disabled: [], errors: [] }
    const v2: InstalledPluginsFileV2 = { version: 2, plugins: { l: { installs: { local: { path: '/p' } } } } }
    const r = assemblePluginList(load, v2, {}, new Map())
    expect(r.plugins[0].scope).toBe('local')
    expect(r.plugins[0].writable).toBe(false)
  })

  it('user + project 都在 → scope 取 user（更宽泛优先）', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'b' })], disabled: [], errors: [] }
    const v2: InstalledPluginsFileV2 = {
      version: 2,
      plugins: { b: { installs: { user: { path: '/u' }, project: { path: '/p' } } } },
    }
    const r = assemblePluginList(load, v2, {}, new Map())
    expect(r.plugins[0].scope).toBe('user')
    expect(r.plugins[0].writable).toBe(true)
  })

  it('内置插件 → scope=builtin, writable=true', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'b@builtin', repository: 'builtin', isBuiltin: true })],
      disabled: [], errors: [],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, undefined, new Map())
    expect(r.plugins[0].scope).toBe('builtin')
    expect(r.plugins[0].writable).toBe(true)
    expect(r.plugins[0].enabled).toBe(true) // 无 enabledSettings 时 defaultEnabled
  })

  it('内置插件 enabled=false 在 settings 中 → enabled=false', () => {
    const load: PluginLoadResult = {
      enabled: [], // built-in disabled 不进 enabled 列表
      disabled: [makePlugin({ name: 'b@builtin', repository: 'builtin', isBuiltin: true })],
      errors: [],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, { 'b@builtin': false }, new Map())
    expect(r.plugins[0].enabled).toBe(false)
  })

  it('v2 缺失但 loadResult 有 → scope=user, writable=true', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'x' })], disabled: [], errors: [] }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map())
    expect(r.plugins[0].scope).toBe('user')
  })

  it('hasUpdate=true 通过 hasUpdateFor 注入', () => {
    const load: PluginLoadResult = { enabled: [makePlugin({ name: 'u' })], disabled: [], errors: [] }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map(), (id) => id === 'u@market')
    expect(r.plugins[0].hasUpdate).toBe(true)
  })

  it('errors 含 plugin 字段 → 挂到该行；不含 → 顶层 errors', () => {
    const errA: PluginError = { type: 'generic-error', source: 'src', plugin: 'a', error: 'boom-a' }
    const errTop: PluginError = { type: 'generic-error', source: 'src', error: 'boom-top' }
    const load: PluginLoadResult = {
      enabled: [makePlugin({ name: 'a' })],
      disabled: [],
      errors: [errA, errTop],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map())
    expect(r.plugins[0].errors).toEqual(['boom-a'])
    expect(r.errors).toEqual(['boom-top'])
  })

  it('description / author 透传', () => {
    const load: PluginLoadResult = {
      enabled: [makePlugin({
        name: 'a',
        manifest: { name: 'a', description: 'hi', version: '1.0.0', author: { name: 'me' } } as LoadedPlugin['manifest'],
      })],
      disabled: [], errors: [],
    }
    const r = assemblePluginList(load, { version: 2, plugins: {} }, {}, new Map())
    expect(r.plugins[0].description).toBe('hi')
    expect(r.plugins[0].author).toBe('me')
  })
})
```

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter @zn-ai/zn-agent-core test -- pluginListAssembly`
Expected: 10 个用例全 pass。

- [ ] **Step 4: 跑 server-types-self-contained 验证 .d.ts 自包含**

Run: `pnpm --filter @zn-ai/zn-agent-core typecheck:server-types-self-contained`
Expected: 通过（说明 `pluginListAssembly.ts` 用了 vendor 类型但只出现在 .js 编译产物里，.d.ts 通过相对路径指向 — 如果失败需要把 vendor 类型在 pluginListAssembly 内部重声明或移动到非 server emit 目录）。

注：此步骤若失败，把 `pluginListAssembly.ts` 中 `import type { PluginError, PluginLoadResult, LoadedPlugin }` 与 `import type { InstalledPluginsFileV2 }` 全部移除，改为在 `assemblePluginList` 签名里用最小可表达类型（如 `{ enabled: Array<{ name: string; manifest: any; ... }>; ... }`）。先尝试 1–3 步，Step 4 仅在自检失败时按此备选方案调整。

---

### Task 3: 在 `createOpenccRuntime-impl.ts` 内组装 `OpenccPluginApi`

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts`

**Interfaces:**
- Consumes:
  - `ctx.appState.getState()` / `setState`（来自 headless context）
  - `installPluginOp` / `uninstallPluginOp` / `setPluginEnabledOp` / `updatePluginOp`（`services/plugins/pluginOperations.ts`）
  - `loadAllPlugins`（`utils/plugins/pluginLoader.ts`）
  - `getPluginCommands` / `getPluginSkills` / `getAgentDefinitionsWithOverrides` / `refreshActivePlugins`（`utils/plugins/refresh.ts` / `loadPluginCommands.ts` 等）
  - `getPluginInstallationFromV2`（`services/plugins/pluginOperations.ts`）
  - `hasPendingUpdates` / `getPendingUpdatesDetails`（`utils/plugins/installedPluginsManager.ts`）
  - `getMarketplace` / `getPluginById` / `getDeclaredMarketplaces`（`utils/plugins/marketplaceManager.ts`）
  - `assemblePluginList`（Task 2 抽离的纯函数）
  - `getSettingsForSource('userSettings')?.enabledPlugins`（`utils/settings/settings.ts`）
- Produces:
  - `OpenccRuntime.plugins: OpenccPluginApi`（Task 1 类型）

- [ ] **Step 1: 在 `createOpenccRuntime-impl.ts` 顶部加 imports**

在现有 import 块末尾追加：

```ts
import { assemblePluginList } from './pluginListAssembly.js'
import {
  installPluginOp,
  uninstallPluginOp,
  setPluginEnabledOp,
  updatePluginOp,
} from '../services/plugins/pluginOperations.js'
import { loadAllPlugins } from '../utils/plugins/pluginLoader.js'
import { getPluginCommands, getPluginSkills } from '../utils/plugins/loadPluginCommands.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import { getOriginalCwd } from '../utils/state/storage.js'
import { refreshActivePlugins } from '../utils/plugins/refresh.js'
import { loadInstalledPluginsV2, hasPendingUpdates, getPendingUpdatesDetails } from '../utils/plugins/installedPluginsManager.js'
import { getMarketplace, getPluginById, getDeclaredMarketplaces } from '../utils/plugins/marketplaceManager.js'
import { getSettingsForSource } from '../utils/settings/settings.js'
import type { OpenccPluginApi, OpenccPluginComponentCounts, OpenccPluginListResult, OpenccPluginActionResult, OpenccMarketplacePluginDto } from './serverTypes.js'
```

- [ ] **Step 2: 找到 `OpenccRuntime` 对象返回位置**

`createOpenccRuntime-impl.ts` 在末尾 `return { query, abort, ... }`。在它之前**先**定义一个内部 helper 块。

- [ ] **Step 3: 在 `return { ... }` 之前定义 `plugins` 对象的实现**

```ts
async function buildComponentCounts(): Promise<Map<string, OpenccPluginComponentCounts>> {
  const counts = new Map<string, OpenccPluginComponentCounts>()
  const [cmds, skills, agents] = await Promise.all([
    getPluginCommands(),
    getPluginSkills(),
    getAgentDefinitionsWithOverrides(getOriginalCwd()),
  ])
  // 1) per-plugin commands/skills counts
  for (const c of cmds) {
    if (c.source !== 'plugin') continue
    const e = counts.get(c.pluginName) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
    e.commands += 1
    counts.set(c.pluginName, e)
  }
  for (const s of skills) {
    // skills entry shape: { name, source: 'plugin', pluginName, ... }
    const e = counts.get(s.pluginName) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
    e.skills += 1
    counts.set(s.pluginName, e)
  }
  // 2) agents: AgentDefinitionsResult.allAgents is AgentDefinition[]; filter to plugin agents.
  for (const a of agents.allAgents ?? []) {
    if (a.source !== 'plugin' || !('pluginName' in a) || !a.pluginName) continue
    const e = counts.get(a.pluginName) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
    e.agents += 1
    counts.set(a.pluginName, e)
  }
  return counts
}

async function buildList(): Promise<OpenccPluginListResult> {
  const [loadResult, v2, counts] = await Promise.all([
    loadAllPlugins(),
    loadInstalledPluginsV2(),
    buildComponentCounts(),
  ])
  // 3) hooks + mcpServers from the loaded plugins (cheap, no extra I/O)
  for (const p of [...loadResult.enabled, ...loadResult.disabled]) {
    const e = counts.get(p.name) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
    e.hooks = Object.keys(p.hooksConfig ?? {}).length
    e.mcpServers = Object.keys(p.mcpServers ?? {}).length
    counts.set(p.name, e)
  }
  // 4) hasUpdate via pending updates registry
  const pendingMap = new Map<string, boolean>()
  if (hasPendingUpdates()) {
    for (const u of getPendingUpdatesDetails()) {
      pendingMap.set(u.id, true)
    }
  }
  const enabled = getSettingsForSource('userSettings')?.enabledPlugins as Record<string, boolean> | undefined
  return assemblePluginList(loadResult, v2, enabled, counts, (id) => pendingMap.get(id) === true)
}

async function reloadActive(): Promise<OpenccPluginActionResult['reload']> {
  try {
    const r = await refreshActivePlugins(ctx.appState.setState)
    return {
      plugins: r.enabled_count,
      commands: r.command_count,
      agents: r.agent_count,
      hooks: r.hook_count,
      mcpServers: r.mcp_count,
      errors: r.error_count,
    }
  } catch (e) {
    return undefined
  }
}

const plugins: OpenccPluginApi = {
  async listInstalled() {
    return buildList()
  },

  async listAvailable(): Promise<OpenccMarketplacePluginDto[]> {
    const installed = await buildList()
    const installedIds = new Set(installed.plugins.map((p) => p.id))
    const declared = getDeclaredMarketplaces()
    const out: OpenccMarketplacePluginDto[] = []
    for (const [marketplaceName, decl] of Object.entries(declared)) {
      const mp = await getMarketplace(marketplaceName).catch(() => null)
      if (!mp) continue
      for (const entry of mp.plugins ?? []) {
        const id = `${entry.name}@${marketplaceName}`
        if (installedIds.has(id)) continue
        out.push({
          id,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          author: typeof entry.author === 'string' ? entry.author : entry.author?.name,
          marketplace: marketplaceName,
          category: entry.category,
          tags: entry.tags,
          installed: false,
          homepage: entry.homepage,
        })
      }
    }
    return out
  },

  async setEnabled(id, enabled) {
    const op = await setPluginEnabledOp(id, enabled, 'user')
    if (!op.success) return { success: false, message: op.message }
    const reload = await reloadActive()
    if (reload === undefined) {
      return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
    }
    return { success: true, message: op.message, reload, state: await buildList() }
  },

  async install(id) {
    const op = await installPluginOp(id, 'user')
    if (!op.success) return { success: false, message: op.message }
    const reload = await reloadActive()
    if (reload === undefined) {
      return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
    }
    return { success: true, message: op.message, reload, state: await buildList() }
  },

  async uninstall(id) {
    const op = await uninstallPluginOp(id, 'user', true)
    if (!op.success) return { success: false, message: op.message }
    const reload = await reloadActive()
    if (reload === undefined) {
      return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
    }
    return { success: true, message: op.message, reload, state: await buildList() }
  },

  async update(id) {
    const op = await updatePluginOp(id, 'user')
    if (!op.success) {
      return { success: false, message: op.message }
    }
    const reload = await reloadActive()
    if (reload === undefined) {
      return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
    }
    return { success: true, message: op.message, reload, state: await buildList() }
  },

  async reload() {
    const reload = await reloadActive()
    if (reload === undefined) return { success: false, message: 'Hot reload failed' }
    return { success: true, message: 'Reloaded', reload, state: await buildList() }
  },
}
```

- [ ] **Step 4: 在 `return { ... }` 中加 `plugins` 字段**

```ts
return {
  // ... 现有 8 个方法
  plugins,
}
```

- [ ] **Step 5: 跑 typecheck 与 verify**

Run: `pnpm --filter @zn-ai/zn-agent-core typecheck && pnpm --filter @zn-ai/zn-agent-core typecheck:server-types-self-contained`
Expected: 都通过。

- [ ] **Step 6: 跑 pluginOperations 已有测试确保没回归**

Run: `pnpm --filter @zn-ai/zn-agent-core test`
Expected: 全部通过。

---

### Task 4: 瘦门面 `createOpenccRuntime.ts` 同步类型

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime.ts:99`（现有 `export type { OpenccRuntime } from './serverTypes.js'`）

**Interfaces:**
- Consumes: 无
- Produces: 无新增

- [ ] **Step 1: 验证类型已经在第 99 行 re-export，无需改文件**

读 `createOpenccRuntime.ts:99`，确认是：
```ts
export type { OpenccRuntime } from './serverTypes.js'
```
`OpenccRuntime.plugins: OpenccPluginApi` 字段随 `OpenccRuntime` 一起 re-export。**此任务无需改代码。**

- [ ] **Step 2: 仅运行 typecheck 确认**

Run: `pnpm --filter @zn-ai/zn-agent-core typecheck`
Expected: 通过。

---

### Task 5: 在 zai shared 包加类型再导出

**Files:**
- Create: `packages/zai/src/shared/plugins.ts`

**Interfaces:**
- Consumes: `OpenccPluginDto` / `OpenccMarketplacePluginDto` / `OpenccPluginActionResult` / `OpenccPluginListResult`（来自 `@zn-ai/zn-agent-core/opencc-server`）
- Produces: 前端可导入的 `PluginDto` / `MarketplacePluginDto` / `PluginActionResult` / `PluginListResult`

- [ ] **Step 1: 创建 `packages/zai/src/shared/plugins.ts`**

```ts
// Pure type re-export — keeps `@zn-ai/zn-agent-core/opencc-server` as
// the single source of truth for plugin DTOs while the frontend
// imports from a stable shared surface.
export type {
  OpenccPluginDto as PluginDto,
  OpenccMarketplacePluginDto as MarketplacePluginDto,
  OpenccPluginActionResult as PluginActionResult,
  OpenccPluginListResult as PluginListResult,
  OpenccPluginScope as PluginScope,
  OpenccPluginComponentCounts as PluginComponentCounts,
  OpenccPluginReloadCounts as PluginReloadCounts,
} from '@zn-ai/zn-agent-core/opencc-server'
```

- [ ] **Step 2: 跑 zai typecheck**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit`
Expected: 通过。

---

### Task 6: HTTP 路由 `/api/plugins/*`

**Files:**
- Create: `packages/zai/src/server/routes/plugins.ts`
- Modify: `packages/zai/src/server/index.ts:114-133`（在路由注册区域添加 `app.use('/api/plugins', pluginsRouter)`）
- Create: `packages/zai/test/server/routes/plugins.test.ts`

**Interfaces:**
- Consumes: `getRuntime()` 来自 `services/agentRuntime.ts`；`PluginActionResult` 来自 `shared/plugins.ts`
- Produces: 7 个路由（见 spec 第 161 节）

- [ ] **Step 1: 创建 `routes/plugins.ts`**

```ts
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { getRuntime } from '../services/agentRuntime.js'

const IdBody = z.object({ id: z.string().min(1) })

function runtimeOr503(res: Response) {
  const r = getRuntime()
  if (!r) {
    res.status(503).json({ error: 'agent runtime not ready' })
    return null
  }
  return r
}

function parseBody<T>(schema: z.ZodSchema<T>, req: Request, res: Response): T | null {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
    return null
  }
  return parsed.data
}

export const pluginsRouter = Router()

pluginsRouter.get('/', async (_req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const result = await r.plugins.listInstalled()
  res.json(result)
})

pluginsRouter.get('/available', async (_req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const list = await r.plugins.listAvailable()
  res.json({ plugins: list })
})

pluginsRouter.post('/enable', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.setEnabled(body.id, true)
  res.json(result)
})

pluginsRouter.post('/disable', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.setEnabled(body.id, false)
  res.json(result)
})

pluginsRouter.post('/install', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.install(body.id)
  res.json(result)
})

pluginsRouter.post('/uninstall', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.uninstall(body.id)
  res.json(result)
})

pluginsRouter.post('/update', async (req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const body = parseBody(IdBody, req, res)
  if (!body) return
  const result = await r.plugins.update(body.id)
  res.json(result)
})

pluginsRouter.post('/reload', async (_req, res) => {
  const r = runtimeOr503(res)
  if (!r) return
  const result = await r.plugins.reload()
  res.json(result)
})

export default pluginsRouter
```

- [ ] **Step 2: 在 `src/server/index.ts` 注册路由**

在 `app.use('/api/agentSettingsRouter')` 附近（与 agentSettings 同区段）添加：

```ts
import { pluginsRouter } from './routes/plugins.js'
// ...
app.use('/api/plugins', pluginsRouter)
```

- [ ] **Step 3: 创建测试 `plugins.test.ts`**

路径：`packages/zai/test/server/routes/plugins.test.ts`：

```ts
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockPlugins = {
  listInstalled: vi.fn(),
  listAvailable: vi.fn(),
  setEnabled: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  update: vi.fn(),
  reload: vi.fn(),
}
const mockGetRuntime = vi.fn()

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => mockGetRuntime(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

async function bootstrap(runtime: unknown) {
  mockGetRuntime.mockReturnValue(runtime)
  vi.resetModules()
  const { default: router } = await import('../../../src/server/routes/plugins.js')
  const app = express()
  app.use(express.json())
  app.use('/api/plugins', router)
  return { app }
}

describe('routes/plugins', () => {
  it('GET / returns installed list when runtime ready', async () => {
    mockPlugins.listInstalled.mockResolvedValue({ plugins: [{ id: 'a@m', name: 'a' }], errors: [] })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).get('/api/plugins/')
    expect(r.status).toBe(200)
    expect(r.body.plugins[0].id).toBe('a@m')
  })

  it('GET / returns 503 when runtime is null', async () => {
    const { app } = await bootstrap(null)
    const r = await request(app).get('/api/plugins/')
    expect(r.status).toBe(503)
  })

  it('POST /enable forwards id and returns success', async () => {
    mockPlugins.setEnabled.mockResolvedValue({ success: true, message: 'ok', state: { plugins: [], errors: [] } })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/enable').send({ id: 'a@m' })
    expect(r.status).toBe(200)
    expect(mockPlugins.setEnabled).toHaveBeenCalledWith('a@m', true)
    expect(r.body.success).toBe(true)
  })

  it('POST /disable forwards enabled=false', async () => {
    mockPlugins.setEnabled.mockResolvedValue({ success: true, message: 'ok' })
    const { app } = await bootstrap({ plugins: mockPlugins })
    await request(app).post('/api/plugins/disable').send({ id: 'a@m' })
    expect(mockPlugins.setEnabled).toHaveBeenCalledWith('a@m', false)
  })

  it('POST / with empty body returns 400', async () => {
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/enable').send({})
    expect(r.status).toBe(400)
  })

  it('POST /enable success=false still returns 200', async () => {
    mockPlugins.setEnabled.mockResolvedValue({ success: false, message: 'not found' })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/enable').send({ id: 'x@m' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(false)
  })

  it('POST /reload returns action result', async () => {
    mockPlugins.reload.mockResolvedValue({ success: true, message: 'Reloaded', reload: { plugins: 1, commands: 0, agents: 0, hooks: 0, mcpServers: 0, errors: 0 } })
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).post('/api/plugins/reload')
    expect(r.status).toBe(200)
    expect(r.body.reload.plugins).toBe(1)
  })

  it('GET /available returns marketplace list', async () => {
    mockPlugins.listAvailable.mockResolvedValue([{ id: 'p@m', name: 'p' }])
    const { app } = await bootstrap({ plugins: mockPlugins })
    const r = await request(app).get('/api/plugins/available')
    expect(r.status).toBe(200)
    expect(r.body.plugins[0].name).toBe('p')
  })
})
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @zn-ai/zai test -- plugins.test`
Expected: 8 个用例全 pass。

---

### Task 7: 前端 store 字段与 action

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts:73,146,266`（参考 `settingsDrawerOpen` 的现有模式）

**Interfaces:**
- Consumes: 无
- Produces: `pluginModalOpen: boolean` 字段 + `openPluginModal()` / `closePluginModal()` actions

- [ ] **Step 1: 在 `useAppStore.ts` 的 `SettingsState` interface 块附近添加字段**

在 `openSettingsDrawer: () => void;` 紧邻位置（`useAppStore.ts:85` 附近）添加：

```ts
pluginModalOpen: boolean
openPluginModal: () => void
closePluginModal: () => void
```

- [ ] **Step 2: 在初始值区域添加默认值**

`useAppStore.ts:148` `settingsDrawerOpen: false,` 紧邻位置添加：

```ts
pluginModalOpen: false,
```

- [ ] **Step 3: 在 actions 块添加实现**

`useAppStore.ts:266-267` 紧邻位置添加：

```ts
openPluginModal: () => set({ pluginModalOpen: true }),
closePluginModal: () => set({ pluginModalOpen: false }),
```

- [ ] **Step 4: 跑 typecheck**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit`
Expected: 通过。

---

### Task 8: 工具栏按钮 + 弹框 UI

**Files:**
- Create: `packages/zai/src/web/src/components/PluginButton.tsx`
- Create: `packages/zai/src/web/src/components/PluginModal/index.tsx`
- Create: `packages/zai/src/web/src/components/PluginModal/usePlugins.ts`
- Create: `packages/zai/src/web/src/components/PluginModal/PluginRow.tsx`
- Create: `packages/zai/src/web/src/components/PluginModal/InstalledPanel.tsx`
- Create: `packages/zai/src/web/src/components/PluginModal/MarketplacePanel.tsx`
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:26,734`（导入 + 挂按钮）

**Interfaces:**
- Consumes: `useAppStore.pluginModalOpen` / `openPluginModal` / `closePluginModal`；`api` 来自 `lib/api`；`PluginDto` / `PluginActionResult` 来自 `shared/plugins`
- Produces: 工具栏按钮 + 弹框（两个 Tab：已安装 / 市场）

- [ ] **Step 1: 创建 `usePlugins.ts`（数据加载 + 写操作钩子）**

```ts
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { PluginDto, PluginActionResult, MarketplacePluginDto, PluginListResult } from '../../../shared/plugins'

export type FetchStatus = 'idle' | 'loading' | 'ready' | 'error'

type WriteState = Record<string, 'writing' | undefined>

export function usePlugins(enabled: boolean) {
  const [installed, setInstalled] = useState<PluginListResult>({ plugins: [], errors: [] })
  const [available, setAvailable] = useState<MarketplacePluginDto[]>([])
  const [status, setStatus] = useState<FetchStatus>('idle')
  const [writing, setWriting] = useState<WriteState>({})

  const refresh = useCallback(async () => {
    if (!enabled) return
    setStatus('loading')
    try {
      const [inst, av] = await Promise.all([
        api.get<PluginListResult>('/plugins/'),
        api.get<{ plugins: MarketplacePluginDto[] }>('/plugins/available'),
      ])
      setInstalled(inst)
      setAvailable(av.plugins)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const write = useCallback(
    async (id: string, op: 'enable' | 'disable' | 'install' | 'uninstall' | 'update') => {
      setWriting((w) => ({ ...w, [id]: 'writing' }))
      try {
        const r = await api.post<PluginActionResult>(`/plugins/${op}`, { id })
        if (r.state) setInstalled(r.state)
        return r
      } finally {
        setWriting((w) => {
          const { [id]: _omit, ...rest } = w
          return rest
        })
      }
    },
    [],
  )

  return { installed, available, status, writing, refresh, write }
}
```

- [ ] **Step 2: 创建 `PluginRow.tsx`（共用行组件）**

```tsx
import { Dropdown, Switch, Tag, Tooltip, Typography } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import type { PluginDto } from '../../../shared/plugins'

type Props = {
  plugin: PluginDto
  writing?: 'writing' | undefined
  onToggle: (next: boolean) => void
  onUpdate: () => void
  onUninstall: () => void
}

const STATUS_COLOR: Record<string, string> = {
  enabled: 'var(--success)',
  disabled: 'var(--text-tertiary)',
  error: 'var(--error)',
  update: '#eab308',
}

const SCOPE_LABEL: Record<string, string> = {
  user: 'user',
  project: 'project',
  local: 'local',
  builtin: '内置',
}

export function PluginRow({ plugin, writing, onToggle, onUpdate, onUninstall }: Props) {
  const dot =
    plugin.errors.length > 0
      ? STATUS_COLOR.error
      : plugin.hasUpdate
        ? STATUS_COLOR.update
        : plugin.enabled
          ? STATUS_COLOR.enabled
          : STATUS_COLOR.disabled

  const switchEl = (
    <Switch
      checked={plugin.enabled}
      disabled={!plugin.writable || writing === 'writing'}
      loading={writing === 'writing'}
      onChange={onToggle}
    />
  )

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        alignItems: 'flex-start',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, marginTop: 6, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Typography.Text strong>{plugin.name}</Typography.Text>
          {plugin.version && <Typography.Text type="secondary" style={{ fontSize: 12 }}>v{plugin.version}</Typography.Text>}
          <Tag style={{ margin: 0 }}>{plugin.marketplace}</Tag>
          <Tag color={plugin.scope === 'builtin' ? 'blue' : 'default'} style={{ margin: 0 }}>
            {SCOPE_LABEL[plugin.scope] ?? plugin.scope}
          </Tag>
          {plugin.hasUpdate && <Tag color="warning" style={{ margin: 0 }}>待更新</Tag>}
        </div>
        {plugin.description && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {plugin.description}
          </Typography.Text>
        )}
        {plugin.errors.length > 0 && (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {plugin.errors.join('；')}
          </Typography.Text>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {plugin.writable ? (
          switchEl
        ) : (
          <Tooltip title="由项目配置管理，请用 CLI 修改">
            <span>{switchEl}</span>
          </Tooltip>
        )}
        {plugin.writable && (
          <Dropdown
            menu={{
              items: [
                { key: 'update', label: '更新', disabled: !plugin.hasUpdate, onClick: onUpdate },
                { key: 'uninstall', label: '卸载', danger: true, onClick: onUninstall },
              ],
            }}
          >
            <DownOutlined style={{ cursor: 'pointer', color: 'var(--text-secondary)' }} />
          </Dropdown>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 创建 `InstalledPanel.tsx`**

```tsx
import { Alert, Empty, Skeleton } from 'antd'
import type { PluginDto, PluginListResult } from '../../../shared/plugins'
import { PluginRow } from './PluginRow'

type Props = {
  data: PluginListResult
  status: 'idle' | 'loading' | 'ready' | 'error'
  writing: Record<string, 'writing' | undefined>
  onToggle: (p: PluginDto, next: boolean) => void
  onUpdate: (p: PluginDto) => void
  onUninstall: (p: PluginDto) => void
  onReload: () => void
}

export function InstalledPanel({ data, status, writing, onToggle, onUpdate, onUninstall, onReload }: Props) {
  if (status === 'loading' || status === 'idle') {
    return <Skeleton active style={{ padding: 16 }} />
  }
  if (status === 'error') {
    return <Alert type="error" message="加载失败" showIcon style={{ margin: 16 }} />
  }
  return (
    <div>
      {data.errors.length > 0 && (
        <Alert
          type="warning"
          message={`${data.errors.length} 个插件加载失败`}
          description={data.errors.join('；')}
          showIcon
          closable
          style={{ margin: 12 }}
        />
      )}
      {data.plugins.length === 0 ? (
        <Empty description="尚未安装任何插件" style={{ marginTop: 40 }} />
      ) : (
        data.plugins.map((p) => (
          <PluginRow
            key={p.id}
            plugin={p}
            writing={writing[p.id]}
            onToggle={(next) => onToggle(p, next)}
            onUpdate={() => onUpdate(p)}
            onUninstall={() => onUninstall(p)}
          />
        ))
      )}
      <div style={{ textAlign: 'right', padding: 8 }}>
        <a onClick={onReload}>重载插件</a>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 `MarketplacePanel.tsx`**

```tsx
import { Button, Empty, Skeleton, Tag, Typography } from 'antd'
import type { MarketplacePluginDto } from '../../../shared/plugins'

type Props = {
  plugins: MarketplacePluginDto[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  writing: Record<string, 'writing' | undefined>
  onInstall: (p: MarketplacePluginDto) => void
}

export function MarketplacePanel({ plugins, status, writing, onInstall }: Props) {
  if (status === 'loading' || status === 'idle') {
    return <Skeleton active style={{ padding: 16 }} />
  }
  if (plugins.length === 0) {
    return <Empty description="市场里没有可安装的插件" style={{ marginTop: 40 }} />
  }
  return (
    <div>
      {plugins.map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex', gap: 12, padding: '10px 12px',
            borderBottom: '1px solid var(--border-subtle)', alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Typography.Text strong>{p.name}</Typography.Text>
              {p.version && <Typography.Text type="secondary" style={{ fontSize: 12 }}>v{p.version}</Typography.Text>}
              <Tag style={{ margin: 0 }}>{p.marketplace}</Tag>
              {p.category && <Tag style={{ margin: 0 }}>{p.category}</Tag>}
            </div>
            {p.description && (
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                {p.description}
              </Typography.Text>
            )}
          </div>
          <Button
            type="primary" size="small"
            loading={writing[p.id] === 'writing'}
            onClick={() => onInstall(p)}
          >
            安装
          </Button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: 创建 `index.tsx`（弹框主体）**

```tsx
import { App, Modal, Tabs } from 'antd'
import { useAppStore } from '../../store/useAppStore'
import { usePlugins } from './usePlugins'
import { InstalledPanel } from './InstalledPanel'
import { MarketplacePanel } from './MarketplacePanel'
import { useCallback, useState } from 'react'

const PLUGIN_ICON = (
  <span className="anticon" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor">
      <path d="MM17.5 3.5L20.5 6.5L11 16L8 16L8 13L17.5 3.5Z M14.5 6.5L17.5 9.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  </span>
)

export function PluginModal() {
  const open = useAppStore((s) => s.pluginModalOpen)
  const close = useAppStore((s) => s.closePluginModal)
  const [tab, setTab] = useState<'installed' | 'marketplace'>('installed')
  const { installed, available, status, writing, refresh, write } = usePlugins(open)
  const { message } = App.useApp()

  const handleToggle = useCallback(
    async (p: { id: string }, next: boolean) => {
      const r = await write(p.id, next ? 'enable' : 'disable')
      if (r.success) message.success(r.message)
      else message.error(r.message)
    },
    [write, message],
  )

  const handleUpdate = useCallback(
    async (p: { id: string }) => {
      const r = await write(p.id, 'update')
      if (r.success) message.success(r.message)
      else message.error(r.message)
    },
    [write, message],
  )

  const handleUninstall = useCallback(
    async (p: { id: string }) => {
      const r = await write(p.id, 'uninstall')
      if (r.success) message.success(r.message)
      else message.error(r.message)
    },
    [write, message],
  )

  const handleInstall = useCallback(
    async (p: { id: string }) => {
      const r = await write(p.id, 'install')
      if (r.success) {
        message.success(r.message)
        setTab('installed')
      } else {
        message.error(r.message)
      }
    },
    [write, message],
  )

  const handleReload = useCallback(async () => {
    try {
      const r = await api.post<PluginActionResult>('/plugins/reload')
      if (r.state) setInstalled(r.state)
      message.success(r.message)
    } catch (e) {
      message.error(`重载失败: ${String(e)}`)
    }
  }, [message])

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      title="插件管理"
      width={720}
      destroyOnClose
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'installed' | 'marketplace')}
        items={[
          {
            key: 'installed',
            label: `已安装 (${installed.plugins.length})`,
            children: (
              <InstalledPanel
                data={installed}
                status={status}
                writing={writing}
                onToggle={handleToggle}
                onUpdate={handleUpdate}
                onUninstall={handleUninstall}
                onReload={handleReload}
              />
            ),
          },
          {
            key: 'marketplace',
            label: `市场 (${available.length})`,
            children: (
              <MarketplacePanel
                plugins={available}
                status={status}
                writing={writing}
                onInstall={handleInstall}
              />
            ),
          },
        ]}
      />
    </Modal>
  )
}

import { api } from '../../lib/api'
```

- [ ] **Step 6: 创建 `PluginButton.tsx`（工具栏按钮）**

```tsx
import { AppstoreOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { useAppStore } from '../store/useAppStore'
import { toolbarIconButtonStyle } from './toolbarStyles'
import { PluginModal } from './PluginModal'

export default function PluginButton() {
  return (
    <>
      <Tooltip title="插件管理">
        <button
          type="button"
          aria-label="插件管理"
          onClick={() => useAppStore.getState().openPluginModal()}
          style={toolbarIconButtonStyle}
        >
          <AppstoreOutlined />
        </button>
      </Tooltip>
      <PluginModal />
    </>
  )
}
```

- [ ] **Step 7: 挂入 `AgentInputBox.tsx`**

`packages/zai/src/web/src/components/AgentInputBox.tsx:26` 附近添加 import：

```ts
import PluginButton from './PluginButton'
```

`packages/zai/src/web/src/components/AgentInputBox.tsx:734`（`<SettingsButton />` 紧邻位置）添加：

```tsx
<PluginButton />
```

- [ ] **Step 8: 跑 zai typecheck + dev 启动 smoke test**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit && pnpm --filter @zn-ai/zai dev`
Expected: typecheck 通过；dev 服务在 8101 启动；浏览器打开 `http://localhost:8101`，工具栏出现插件按钮，点击弹出弹框，两个 Tab 切换正常（即使没数据也不报错）。

---

### Task 9: 真实浏览器端到端验收

**Files:** 无（只走 `/ego-browser` 验收流程）

- [ ] **Step 1: 确认 dev 服务运行在 8101**

Run: `curl -fsS http://localhost:8101/ -o /dev/null -w "%{http_code}\n"`
Expected: `200`

- [ ] **Step 2: 用 `/ego-browser` 打开 zai 首页**

在 `/ego-browser` 内（用真实 ego-browser，不用 chrome-devtools MCP）：
- navigate 到 `http://localhost:8101`
- 等待工具栏渲染（`data-testid="config-status-bar"` 可见）
- 截图存到 `docs/superpowers/plans/screenshots/2026-08-06-01-toolbar.png`

- [ ] **Step 3: 点击插件按钮，截图弹框**

- click `aria-label="插件管理"` 按钮
- 等待弹框出现（标题"插件管理"）
- 截图存到 `docs/superpowers/plans/screenshots/2026-08-06-02-modal-open.png`

- [ ] **Step 4: 切到「市场」Tab，截图**

- click Tab "市场"
- 等待列表渲染
- 截图存到 `docs/superpowers/plans/screenshots/2026-08-06-03-marketplace.png`

- [ ] **Step 5: 切回「已安装」Tab，截图**

- click Tab "已安装"
- 等待列表渲染
- 截图存到 `docs/superpowers/plans/screenshots/2026-08-06-04-installed.png`

- [ ] **Step 6: 关闭弹框**

- click 弹框关闭按钮
- 确认弹框消失
- 截图存到 `docs/superpowers/plans/screenshots/2026-08-06-05-closed.png`

- [ ] **Step 7: 验收记录写入 commit message**

整理验收结果（截图路径、是否发现 UI 问题、是否需要调整），写到本任务的 commit message 里（由用户决定是否提交）。

---

## 自检

**1. Spec 覆盖**

| Spec 节 | 对应 Task |
|---------|-----------|
| 分层 | Task 1（DTO）+ Task 3（runtime 集成）+ Task 5（shared re-export）+ Task 6（HTTP） |
| 服务层接口 | Task 1（`OpenccPluginApi`） |
| DTO 自包含 | Task 1 Step 4 + Task 2 Step 4 |
| `assemblePluginList` 纯函数 | Task 2 |
| listInstalled 组装逻辑（含 components 来源） | Task 3 Step 3（`buildList`） |
| 写操作同步热重载 | Task 3 Step 3（每个 write action 调 `reloadActive`） |
| `writable` 服务端计算 | Task 2 `scopeToWritable` |
| HTTP 路径与 body 设计 | Task 6 |
| 共享类型再导出 | Task 5 |
| `useAppStore` 字段 | Task 7 |
| 行渲染（状态圆点 / tag / Switch / 更多菜单） | Task 8 Step 2 |
| 状态机 + 行内 loading + toast | Task 8 Step 1, 5 |
| 错误处理（4 类） | Task 3 Step 3（`setPluginEnabledOp` 等返回 `success: false` 合流；`reloadActive` 失败返回 `reloadFailed: true`）；Task 6 Step 1（runtime null → 503） |
| 单元测试（DTO 组装 + 路由） | Task 2 + Task 6 |
| 真实浏览器验收 | Task 9 |

**2. 占位符扫描**

全文无 TBD / TODO / "similar to Task N" / "implement later" / "add appropriate error handling"。所有代码块都是完整可执行。

**3. 类型一致性**

- `OpenccPluginApi` 在 Task 1 定义，Task 3 实现，所有方法签名（参数名 `id`、`enabled`、返回 `Promise<OpenccPluginActionResult>`）一致。
- `OpenccPluginActionResult.state` 在 Task 1 定义为 `{ plugins, errors }`，Task 3 Step 3 每个 write action 调 `await buildList()` 填充，Task 8 Step 1 `usePlugins.write` 读 `r.state` 替换。
- `OpenccPluginScope` 在 Task 1 定义，Task 2 `assemblePluginList` 用 `OpenccPluginScope`，Task 8 Step 2 `SCOPE_LABEL` key 覆盖全部四个值。
- `OpenccPluginComponentCounts` 在 Task 1 定义，Task 2/3 一致使用。
- 路由路径 `/api/plugins/{enable,disable,install,uninstall,update,reload}` 全部带 body `{ id }`，与 Task 8 Step 1 `usePlugins.write` 的 `api.post('/plugins/${op}', { id })` 一致。

**4. 修复的 spec 模糊点**

spec 说"writable 由服务端计算，前端只负责渲染"，Task 2 `scopeToWritable` 明确了规则：user + builtin → true，其余 → false。前端 `PluginRow` 不再做 scope 二次判断。
