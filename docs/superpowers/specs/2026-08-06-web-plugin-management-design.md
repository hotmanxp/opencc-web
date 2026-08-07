# zai Web 端插件管理设计

**日期：** 2026-08-06
**状态：** 已确认，待实施

## 背景

opencc 的 `/plugin` slash command 提供了完整的插件管理 TUI（`packages/zn-agent-core/src/opencc-src/commands/plugin/`，19 个文件约 7700 行），视图状态机定义在 `commands/plugin/types.ts:12`，覆盖已安装插件管理、marketplace 浏览安装、marketplace 源增删、插件发现、manifest 校验等十个视图。

zai Web UI 目前**没有任何插件管理能力**。`packages/zai/src/web/src/pages/Config.tsx:297` 的 `PluginForm` 管理的是 `opencode.json` 里的 `plugin` 字符串数组，与 opencc 的插件体系无关。用户要在 Web 端管理插件，只能回到 CLI 敲 `/plugin`。

本设计在 zai 工具栏（`components/ConfigStatusBar.tsx:18`）增加一个插件按钮，点击弹出插件管理弹框，把 opencc 的插件能力搬到 Web 上。

## 范围

第一版覆盖：

- 已安装插件列表、启用/禁用、卸载、更新
- 从已配置的 marketplace 浏览并安装插件

不在第一版：marketplace 源的增删改、自动更新开关、插件发现（Discover）、manifest 校验（Validate）。这些留待后续迭代。

## 已确认的取舍

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 作用域 | 写操作一律落 `user` 全局；`project` / `local` 装的插件只读展示并标注来源 | 避免把「当前是哪个项目」的歧义引入 v1。zai 是多实例、每会话独立 cwd 的，`project` 指向不自明 |
| 生效时机 | 每次写操作后**同步**热重载，等重载完成再返回 | 前端状态永远与运行时一致，无需乐观更新与轮询。代价是单次操作数百毫秒，对低频配置操作可接受 |
| 列表构成 | 插件 + 加载失败的插件；不含 MCP server | zai 的 MCP 已有 `Config.tsx` / `Tools.tsx` 承载，混排会造成职责重叠 |
| 能力暴露 | 挂到已有的 `OpenccRuntime` 对象上 | 见下文「模块图约束」，这是唯一不会静默坏掉热重载的做法 |

## 模块图约束（关键）

`utils/plugins/pluginLoader.ts:3380` 的 `loadAllPlugins` 是 `memoize(...)` 的**模块级**缓存，`clearAllCaches()` 清理的同样是模块级状态。

而 `scripts/bundle-opencc.ts` 为每个 `-impl.ts` 各配一个 esbuild `bundle: true` 的 entry point，因此**每个 impl 产物内都内联着一份独立的 vendor 模块副本**——两个 bundle 之间不共享任何模块级状态。

若把插件能力做成独立的 `pluginFacade-impl.ts` bundle，它调用 `clearAllCaches()` 清理的是自己那份缓存，而运行中的 QueryEngine 读取的是另一份——热重载会**表现为成功、实际不生效**。

实际情况是：`packages/zai/src/server/services/agentRuntime.ts:334` 只调用 `createOpenccRuntime` 一个入口；而 `createOpenccRuntime-impl.ts:3-4` 直接 import `createHeadlessContext-impl` 与 `sessionFacade-impl`（不经瘦包装），esbuild 把三者内联进了同一个产物。所以尽管另两个 impl 也各自有独立产物，zai server 进程实际只加载了 `createOpenccRuntime-impl.js` 一个——**进程内只存在一份活的 vendor 模块图**。

结论：插件能力必须在该 bundle 内实现，通过 runtime 对象暴露。

## 分层

```
opencc-src/services/plugins/pluginOperations.ts          已存在，不改
opencc-src/utils/plugins/{marketplaceManager,pluginLoader,refresh}.ts   已存在，不改
        ↑
opencc-src/server/serverTypes.ts + createOpenccRuntime-impl.ts   新增 plugins 命名空间
        ↑  @zn-ai/zn-agent-core/opencc-server
zai/src/server/routes/plugins.ts                          新增 HTTP
        ↑  /api/plugins/*
zai/src/web/src/components/PluginModal/*                  新增 UI
```

复用的 vendor 服务层（均为纯函数，不打 console、不 `process.exit`；外层 `services/plugins/pluginCliCommands.ts` 才做这些）：

- `services/plugins/pluginOperations.ts` — `installPluginOp` / `uninstallPluginOp` / `setPluginEnabledOp` / `enablePluginOp` / `disablePluginOp` / `updatePluginOp`，统一返回 `PluginOperationResult`
- `utils/plugins/marketplaceManager.ts` — `getMarketplace` / `getPluginById` / `refreshAllMarketplaces`
- `utils/plugins/pluginLoader.ts` — `loadAllPlugins()` 返回 `{ enabled, disabled, errors }`
- `utils/plugins/refresh.ts` — `refreshActivePlugins(setAppState)`，`/reload-plugins` 走的同一条路径

## 服务层接口

`opencc-src/server/serverTypes.ts:236` 的 `OpenccRuntime` 增加 `plugins` 命名空间，现有 8 个方法不变：

```ts
export type OpenccRuntime = {
  // ... 现有方法不动
  plugins: OpenccPluginApi
}

export type OpenccPluginApi = {
  listInstalled(): Promise<{ plugins: OpenccPluginDto[]; errors: string[] }>
  listAvailable(): Promise<OpenccMarketplacePluginDto[]>
  setEnabled(id: string, enabled: boolean): Promise<OpenccPluginActionResult>
  install(id: string): Promise<OpenccPluginActionResult>
  uninstall(id: string): Promise<OpenccPluginActionResult>
  update(id: string): Promise<OpenccPluginActionResult>
  reload(): Promise<OpenccPluginActionResult>
}
```

实现在 `createOpenccRuntime-impl.ts` 内组装。该文件已持有 headless context 的 `ctx.appState` 并在其上构造了传给 vendor 的 `setAppState`（`createOpenccRuntime-impl.ts:150,157` 一带）；`refreshActivePlugins` 复用同一个 setter，无需再往 `globalThis` 注入桥接。

### DTO

`scripts/verify-server-types-self-contained.mjs` 要求 `dist/opencc-src/server/` 的 `.d.ts` 自包含，因此 DTO 在 `serverTypes.ts` 内平铺声明，**不 re-export** vendor 的 `LoadedPlugin`。这同时给 Web API 划出了与 vendor 内部类型解耦的稳定传输结构。

```ts
export type OpenccPluginDto = {
  id: string                    // "name@marketplace"
  name: string
  description?: string
  version?: string
  author?: string
  marketplace: string
  scope: 'user' | 'project' | 'local' | 'builtin'
  enabled: boolean
  writable: boolean             // user/builtin → 可操作；project/local → 只读
  hasUpdate: boolean
  components: {
    commands: number
    agents: number
    skills: number
    hooks: number
    mcpServers: number
  }
  errors: string[]              // getPluginErrorMessage() 格式化后的字符串
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

export type OpenccPluginActionResult = {
  success: boolean
  message: string
  reloadFailed?: boolean
  /** 热重载后的全局计数，取自 refreshActivePlugins 的返回值 */
  reload?: {
    plugins: number
    commands: number
    agents: number
    hooks: number
    mcpServers: number
    errors: number
  }
  /** 操作成功后的最新列表，形状与 listInstalled 一致，省去前端二次 GET */
  state?: { plugins: OpenccPluginDto[]; errors: string[] }
}
```

`reload` 直接映射 `utils/plugins/refresh.ts:41` 的 `RefreshActivePluginsResult`：`enabled_count` → `plugins`，`command_count` → `commands`，`agent_count` → `agents`，`hook_count` → `hooks`，`mcp_count` → `mcpServers`，`error_count` → `errors`。

`writable` 由服务端计算：把「哪些行可操作」的规则收敛到一处，前端只负责渲染。将来放开 `project` / `local` 写入时只改服务端。

### listInstalled 组装逻辑

1. `loadAllPlugins()` 取 `{ enabled, disabled, errors }`
2. 用 `installedPluginsManager` 的 v2 安装记录判定每个插件的 `scope`
3. `hasPendingUpdates` / `getPendingUpdatesDetails` 判定 `hasUpdate`
4. `errors` 数组按其 `plugin` 字段归属到对应插件行；归属不上的（marketplace 级错误）进顶层 `errors`
5. `enabledPlugins` 设置判定 `enabled`；内置插件（`scope: 'builtin'`）走 `builtinPlugins.ts` 的 `defaultEnabled` 兜底

`components` 的逐插件计数分两种来源：

- `commands` / `agents` / `skills` — 由 `getPluginCommands()` / `getPluginSkills()` / `getAgentDefinitionsWithOverrides()` 的结果按插件归组统计。插件提供的命令与技能名均以 `${pluginName}:` 为前缀（`utils/plugins/loadPluginCommands.ts:83,755`），条目本身也带 `pluginName` 字段（同文件 `:197`），归组可靠。
- `hooks` / `mcpServers` — 直接数 `LoadedPlugin.hooksConfig` 与 `LoadedPlugin.mcpServers` 的键，无需额外加载。

## HTTP 接口

`packages/zai/src/server/routes/plugins.ts`，挂载在 `/api/plugins`：

```
GET  /api/plugins            → { plugins: PluginDto[], errors: string[] }
GET  /api/plugins/available  → { plugins: MarketplacePluginDto[] }
POST /api/plugins/enable     body { id }  → ActionResult
POST /api/plugins/disable    body { id }  → ActionResult
POST /api/plugins/install    body { id }  → ActionResult
POST /api/plugins/uninstall  body { id }  → ActionResult
POST /api/plugins/update     body { id }  → ActionResult
POST /api/plugins/reload                  → ActionResult
```

写操作的插件 id 一律放 body，不做路径参数。插件 id 形如 `name@marketplace`，marketplace 名可能含点号或连字符；放进路径段需要前后端全程 `encodeURIComponent` 配合，任一侧遗漏就产生只在特定插件名上复现的 bug。放 body 里不存在这个问题。

路由层保持极薄：zod 校验 body、`getRuntime()` 判空（未初始化返回 503）、转调 `runtime.plugins.*`。**不额外引入 `pluginService.ts`**——`runtime.plugins` 本身即服务层，纯转发中间层只会多一处需要同步维护的签名。

共享类型放 `packages/zai/src/shared/plugins.ts`，以纯类型再导出保持单一事实源：

```ts
export type {
  OpenccPluginDto as PluginDto,
  OpenccMarketplacePluginDto as MarketplacePluginDto,
  OpenccPluginActionResult as PluginActionResult,
} from '@zn-ai/zn-agent-core/opencc-server'
```

`export type` 编译后被完全擦除，前端 bundle 不会混入 server 包。

## 前端

```
components/PluginButton.tsx          工具栏按钮，挂进 ConfigStatusBar.tsx
components/PluginModal/
  index.tsx                          antd Modal + Tabs（已安装 / 市场）
  PluginRow.tsx                      共用行组件
  InstalledPanel.tsx
  MarketplacePanel.tsx
  usePlugins.ts                      数据加载、写操作、状态机
```

弹框开关按既有惯例在 `useAppStore` 增加 `pluginModalOpen` 字段与 `openPluginModal()` / `closePluginModal()` action，照抄 `settingsDrawerOpen`（`useAppStore.ts:73,266`）。

### 行渲染

TUI 的 `UnifiedInstalledCell.tsx` 形态是「状态图标 + 名称 + `· marketplace` 暗字 + 描述」，状态图标用 `figures.tick`（已启用）/ `radioOff`（已禁用）/ `cross`（错误）/ `triangleUpOutline`（待更新）。

Web 映射：

- 左侧状态圆点，配色对应上述四态
- 主行：插件名 + marketplace tag + scope tag
- 副行：描述；若有 `errors` 则标红展开错误信息
- 右侧：启用 Switch + 「更多」菜单（更新 / 卸载）
- `writable === false` 的行 Switch 置灰，tooltip 说明该插件由项目配置管理，需用 CLI 修改

### 状态与反馈

数据加载沿用 `ApproveDrawer` 的 `fetchStatus: 'idle' | 'loading' | 'ready' | 'error'` 状态机。

写操作使用行内 loading：仅该行 Switch 转圈，其余行保持可用。完成后以 `ActionResult.message` 走 `useAppStore` 已有的 toast 队列（`useAppStore.ts:48`）提示，并用返回的 `state` 直接替换本地列表与错误告警条。

## 错误处理

**操作失败（业务级）** — `*Op` 返回 `{ success: false, message }` 而非抛异常。路由统一返回 HTTP 200 + `ActionResult`，前端按 `success` 分支走 error toast。「插件不存在」「该作用域下未安装此插件」属于正常的用户输入结果，不是服务端故障，不应映射为 5xx。

**操作抛异常** — marketplace 的 git clone / pull 会因网络、鉴权、超时抛出。`plugins` 命名空间内每个方法包 try/catch，转为 `{ success: false, message }` 与上一类合流。不让 vendor 异常穿透到 Express，避免栈信息泄漏进 HTTP 响应。

**插件自身加载失败** — 属常态数据而非操作失败。`loadAllPlugins()` 的 `errors` 照常返回，能归属到具体插件的挂到该行 `errors`，归属不上的进顶层 `errors`，在弹框顶部渲染为一条告警条。

**热重载失败不回滚配置写入** — 若 `setPluginEnabledOp` 成功但 `refreshActivePlugins` 抛出，配置已落盘、操作语义上已成功，回滚反而制造磁盘与内存的不一致。此时返回 `success: true` 且 `reloadFailed: true`，前端提示「配置已保存，但热重载失败，重开会话后生效」。

## 测试

**单元测试（vitest）**

- **DTO 组装**是重点。`loadAllPlugins()` 结果 + installed_plugins v2 + `enabledPlugins` 设置三者合并为 `PluginDto[]` 的纯函数，喂假数据断言 scope 判定、`writable` 判定、`hasUpdate` 判定、错误归属。分支多且无 I/O，性价比最高。
- **路由层**测 zod 校验拒绝非法 body、runtime 未初始化返回 503、`success: false` 仍返回 200。runtime 用 stub。
- **不为 `*Op` 与 marketplace 写测试**。那是 vendor 既有代码，本设计不修改它，为其补测试等于测试他人实现。

**真实浏览器验收**（AGENTS.md 强制项）

用 `/ego-browser` 启动独立 dev 服务（`pnpm --filter @zn-ai/zai dev`，端口避开 920x 正式服务），走完完整用户路径：

1. 点击工具栏插件按钮 → 弹框打开
2. 已安装列表正确渲染（含 scope tag、启用态）
3. 切换某插件的启用开关 → 确认 toast 提示与开关状态变化
4. 切到「市场」Tab → 可安装列表渲染
5. 截图存档

## 涉及文件

**新增**

- `packages/zai/src/server/routes/plugins.ts`
- `packages/zai/src/shared/plugins.ts`
- `packages/zai/src/web/src/components/PluginButton.tsx`
- `packages/zai/src/web/src/components/PluginModal/{index,PluginRow,InstalledPanel,MarketplacePanel,usePlugins}.tsx`

**修改**

- `packages/zn-agent-core/src/opencc-src/server/serverTypes.ts` — 新增 DTO 与 `OpenccPluginApi`，`OpenccRuntime` 加 `plugins` 字段
- `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime.ts` — 瘦门面同步类型
- `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts` — 组装 `plugins` 实现
- `packages/zai/src/server/index.ts` — 注册 `/api/plugins` 路由
- `packages/zai/src/web/src/components/ConfigStatusBar.tsx` — 挂入插件按钮
- `packages/zai/src/web/src/store/useAppStore.ts` — 新增 `pluginModalOpen` 与 action

## 后续迭代

- marketplace 源的增删改与自动更新开关（对应 TUI 的 `ManageMarketplaces` / `AddMarketplace`）
- 放开 `project` / `local` 作用域写入，弹框增加作用域选择器
- 插件详情视图（展示其提供的 commands / agents / skills 明细）
- 插件发现与 manifest 校验
