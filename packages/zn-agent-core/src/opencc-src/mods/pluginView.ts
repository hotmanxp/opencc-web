import { BUILTIN_MARKETPLACE_NAME, MODS_MARKETPLACE_NAME } from '../plugins/builtinPlugins.js'
import type { LoadedPlugin } from '../types/plugin.js'
import { getUserConfigJson } from '../utils/userConfigJson.js'
import { BUILTIN_ORIGIN, getKnownMods, getLoadedMods } from './registry.js'

/**
 * Mod → plugin 投影(上游 docs/mods-plan.md §1.3)。
 *
 * 上游把 mod 当作「打包在 bundle 里的插件」来卖:`/diff` 是
 * `cc-plugin-diff`,AGENTS.md 支持是 `cc-plugin-agents-md`。它们在
 * `/plugins` → Installed 的「Built-in」分区里出现,可以在那里开关。
 * opencc 早期给 mod 开了私有的 `/mods` 命令,等于让一个扩展体系在用户
 * 面前有两套管理界面 —— 本模块就是那座桥:每个 mod 都投影成插件 UI 已经
 * 认识的 `LoadedPlugin`,于是它们渲染在同一张列表、同样的分区标题下,并
 * 且共用插件流水线已经在写的同一个 `settings.enabledPlugins` 键。
 *
 * 两个 id、两个分区(对齐上游「内置插件」与「市场安装」的切分):
 *
 *   内置 mod → `<name>@builtin`  →  "Built-in"  分区
 *   磁盘 mod → `<name>@mods`     →  "User"     分区
 *
 * 启用态就存在和真插件相同的 `settings.enabledPlugins` 里 —— 一个开关
 * 键、一个真相来源。
 *
 * 只读设计:本模块必须能被加载器 import(hooks.ts 用 `isModEnabled` 决定
 * 要不要加载),而不能反向把加载器拖进来。写的那一半 ——
 * `setModEnabled` / `reloadMods` —— 在 mods/hooks.ts。
 */

/**
 * 磁盘 mod 的市场标签(`<config-home>/mods/<name>/`)。
 *
 * 常量本身定义在 plugins/builtinPlugins.ts —— pluginLoader.ts 需要用它在
 * 市场解析路径里排除 mod 的条目,从这里 import 会成环。这里只做 re-export,
 * 调用方照旧从 mods/pluginView.js 取。
 */
export { MODS_MARKETPLACE_NAME }

/**
 * mod 传给插件详情视图的数据。`LoadedPlugin` 没有「这东西有几个 handler」
 * 这样的槽位,所以这些信息跟着对象一起传。
 */
export type ModPluginInfo = {
  /** Mod manifest name —— mod 注册表的键。 */
  modName: string
  /** mod 根目录绝对路径;内置 mod 为 `BUILTIN_ORIGIN`。 */
  root: string
  /** 随 bundle 发行,还是从 mods 目录发现。 */
  builtin: boolean
  /** 这个 mod 订阅了哪些事件(`PostToolUse`、`ui.render`、…)。 */
  handlerEvents: string[]
  /** 注册的工具名(运行时 `mods_<mod>_<tool>`)。 */
  toolNames: string[]
  /** 注册的命令名(`register` 里声明时的裸名字)。 */
  commandNames: string[]
}

/** mod 的启用态键。id 改名了它也保持稳定。 */
export function modPluginId(modName: string, builtin: boolean): string {
  return `${modName}@${builtin ? BUILTIN_MARKETPLACE_NAME : MODS_MARKETPLACE_NAME}`
}

/** 该 plugin id 是否属于内置 mod(而非磁盘上的 mod)。 */
export function isModBuiltinId(pluginId: string): boolean {
  return pluginId.endsWith(`@${BUILTIN_MARKETPLACE_NAME}`)
}

/**
 * 反查:某个插件 id 背后有没有 mod,返回它的 mod 名。不是 mod 则 undefined。
 *
 * 反查的是「已知 mod」而不是「已加载 mod」—— 被关掉的 mod 故意不在
 * 注册表里,但它仍然需要能通过开关被打开回来,那正是这个函数存在的理由。
 */
export function modNameForPluginId(pluginId: string): string | undefined {
  for (const [name, meta] of getKnownMods()) {
    if (modPluginId(name, meta.builtin) === pluginId) return name
  }
  return undefined
}

/** 把「可能是 mod 投影」的插件收窄成 mod 信息。 */
export function asModPlugin(plugin: LoadedPlugin): ModPluginInfo | undefined {
  return plugin.mod
}

/**
 * 读一个 mod 的启用态。键不存在 = 启用 —— 和插件流水线同一个默认值,
 * 所以全新安装时每个 mod 都是活的。
 *
 * zai patch (2026-10-10, mods 同步):读 `getUserConfigJson()`,不是上游的
 * `getSettings_DEPRECATED()` —— zai 的 user 作用域插件状态存在统一 user
 * config JSON 里(见 setModEnabled 的注释)。两端必须读同一个地方,否则
 * 加载器会永远按「启用」处理刚被关掉的 mod。
 */
export function isModEnabled(modName: string, builtin: boolean): boolean {
  const id = modPluginId(modName, builtin)
  return getUserConfigJson().enabledPlugins?.[id] !== false
}

/**
 * 把每个已知 mod 投影成插件形状。
 *
 * 「已知」≠「已加载」:被插件列表关掉的 mod 是**故意**不进注册表的
 * (它的代码不该跑),但它仍然需要一行 —— 否则关掉它就没有控件能再打开。
 * 这些行拿到空的组件列表,靠 `enabledPlugins[id] === false` 渲染列表本来
 * 就会画的灰态。
 */
export function getModsAsPlugins(): LoadedPlugin[] {
  const loaded = new Map(getLoadedMods().map(m => [m.manifest.name, m]))
  const plugins: LoadedPlugin[] = []
  for (const [name, meta] of getKnownMods()) {
    const mod = loaded.get(name)
    // 被禁用的 mod 没有 LoadedMod,所以它的 schema 来自发现结果。
    const userConfig = mod?.manifest.userConfig ?? meta.userConfig
    // 来源取自发现结果而非 mod 本身:已加载的 mod 它的 root 说的是同一件事,
    // 但被禁用的那个没有 mod 对象可问。
    const builtin = mod ? mod.root === BUILTIN_ORIGIN : meta.builtin
    const pluginId = modPluginId(name, builtin)
    // zai patch (2026-10-10, mods 同步):展示元信息优先取已加载的 mod,
    // 取不到就回退到发现层存的 manifest 值。后者是必需的 —— 被禁用的 mod
    // 没有已加载对象,若不回退,用户在 UI 上关掉一个 mod 就会看到那一行
    // 当场丢掉版本号和描述,像被抹掉了一样。
    const description = mod?.manifest.description ?? meta.description
    const version = mod?.manifest.version ?? meta.version
    // root 同理回退到发现层 —— 用户要停用/删除一个 mod,得先知道它的文件在哪。
    const root = mod?.root ?? meta.root ?? ''
    plugins.push({
      name,
      manifest: {
        name,
        ...(description ? { description } : {}),
        ...(version ? { version } : {}),
        // 和真插件声明配置项用的是同一个字段 —— 这正是重点所在:
        // 插件列表的「Configure options」由它渲染,savePluginOptions 也按
        // 上面的 id 写入,全程没有任何 mod 专属分支。
        ...(userConfig ? { userConfig: userConfig as LoadedPlugin['manifest']['userConfig'] } : {}),
      },
      // 内置 mod 没有文件系统路径(哨兵值,对齐 builtinPlugins);磁盘 mod
      // 指向自己的 root,报错文案才能说出一个真实位置。
      path: builtin ? BUILTIN_MARKETPLACE_NAME : root,
      source: pluginId,
      repository: pluginId,
      // 两个来源都不是「从市场装的」:不能被路由进安装/卸载/更新流程。
      isBuiltin: true,
      mod: {
        modName: name,
        root,
        builtin,
        handlerEvents: mod?.handlers.map(h => h.event) ?? [],
        toolNames: mod?.tools.map(t => t.name) ?? [],
        commandNames: mod?.commands.map(c => c.name) ?? [],
      },
    })
  }
  return plugins
}