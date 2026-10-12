import { logForDebugging } from '../utils/debug.js'
import type { UserConfigSchema } from '../utils/plugins/mcpbHandler.js'
import type { LoadedMod } from './registry.js'
import {
  BUILTIN_ORIGIN,
  getLoadedMods,
  registerLoadedMod,
  noteDiscoveredMod,
} from './registry.js'
import { createModContext, type ModContext } from './engine.js'
import { isModEnabled, isModExplicitlyEnabled } from './pluginView.js'

/**
 * Built-in mod channel (docs/mods-plan.md §4.3 / §九 — upstream parity of
 * `Ne.registerScan()` / `plugin_bundled_register`): first-party mods compiled
 * into the bundle, registered in-memory and bypassing disk discovery, manifest
 * parsing and the security fence entirely. This is how opencc ships its own
 * features as mods — upstream ships `/diff` (cc-plugin-diff) the same way.
 *
 * Built-ins are ordinary mods once registered: same registry, same dispatch,
 * same /mods listing (marked `builtin`), same unload semantics.
 */

export type BuiltinModSpec = {
  name: string
  version?: string
  description?: string
  /**
   * Ship the mod without loading it unless the user turns it on in `/plugins`.
   *
   * For a diagnostic that is itself a listener: `mod-probe` subscribes to
   * every event, so leaving it on by default made `hasModHandlersFor` true
   * everywhere and turned the zero-subscription fast path off permanently —
   * every dispatch then paid a payload clone, a frozen copy and a budgeted
   * hook, in a session that asked for none of it. The mod is still listed, so
   * `/plugins` is where it gets switched on.
   */
  optIn?: boolean
  /**
   * User-configurable values, surfaced by `/plugins` → Installed as
   * "Configure options". Same schema and same storage as a disk mod's
   * `opencc-mod.json` → `userConfig`; see ModManifestSchema.
   */
  userConfig?: UserConfigSchema
  register(ctx: ModContext): void | Promise<void>
}

const builtinSpecs: BuiltinModSpec[] = []

/**
 * Declare a built-in mod. Call at module top level of the mod's file, then
 * import that file from `src/mods/builtin/index.ts` (the fixed manifest —
 * upstream parity of `wCe()`'s hardcoded chunk list).
 */
export function registerBuiltinMod(spec: BuiltinModSpec): void {
  builtinSpecs.push(spec)
}

/** Replace the whole spec list. For tests only — restores isolation between files. */
export function __setBuiltinSpecsForTesting(specs: BuiltinModSpec[]): void {
  builtinSpecs.length = 0
  builtinSpecs.push(...specs)
}

/** Marker used in LoadedMod.root/entryPath for in-memory mods. */
export { BUILTIN_ORIGIN }

export function isBuiltinMod(mod: LoadedMod): boolean {
  return mod.root === BUILTIN_ORIGIN
}

/**
 * zai patch (2026-10-10, mods 同步):这个名字是否是一个已声明的内置 mod
 * —— 不管它当前有没有被加载。插件列表需要它为一个被关掉的内置 mod 重建
 * `enabledPlugins` 键,因为被关掉的 mod 按设计不在注册表里,自身没有来源
 * 标记可查。
 *
 * 注意:这是**声明表**查询,不是注册表查询 —— 被停用的内置 mod 不在注册表里,
 * 但仍然要能通过 `isModEnabled(name, true)` 查到它的开关状态。
 */
export function isBuiltinModName(name: string): boolean {
  return builtinSpecs.some(spec => spec.name === name)
}

/**
 * Load all declared built-in mods into the registry. Idempotent per name:
 * an already-loaded built-in (or a disk mod with the same name) is skipped,
 * so /mods reload can call this again without duplicating handlers.
 */
export async function loadBuiltinMods(): Promise<{
  loaded: LoadedMod[]
  failed: Array<{ name: string; error: string }>
  disabled: string[]
}> {
  const loaded: LoadedMod[] = []
  const failed: Array<{ name: string; error: string }> = []
  const disabled: string[] = []
  const existingNames = new Set(getLoadedMods().map(m => m.manifest.name))

  for (const spec of builtinSpecs) {
    if (existingNames.has(spec.name)) continue
    // zai patch (2026-10-10, mods 同步):记录发现 + 停用门禁。
    // 即便被跳过也要记 —— 被停用的内置 mod 必须仍出现在插件列表里(灰态),
    // 否则用户关掉它就没有任何控件能再打开。
    noteDiscoveredMod(spec.name, true, spec.userConfig, {
      description: spec.description,
      version: spec.version,
      root: BUILTIN_ORIGIN,
    })
    // 门禁在 register() 之前:用户关掉的内置 mod 一次都不该跑 register,
    // 否则它的命令 / handler 会留在运行时里。
    // `optIn` inverts the default: an absent key means OFF, so a diagnostic
    // ships listed but dormant until someone turns it on.
    const enabled = spec.optIn
      ? isModExplicitlyEnabled(spec.name, true)
      : isModEnabled(spec.name, true)
    if (!enabled) {
      disabled.push(spec.name)
      continue
    }
    try {
      const mod: LoadedMod = {
        manifest: {
          name: spec.name,
          ...(spec.version ? { version: spec.version } : {}),
          ...(spec.description ? { description: spec.description } : {}),
          entry: BUILTIN_ORIGIN,
        },
        root: BUILTIN_ORIGIN,
        entryPath: BUILTIN_ORIGIN,
        handlers: [],
        commands: [],
        tools: [],
      }
      await spec.register(createModContext(mod))
      registerLoadedMod(mod)
      loaded.push(mod)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(
        `[mods] built-in mod "${spec.name}" failed to register: ${message}`,
      )
      failed.push({ name: spec.name, error: message })
    }
  }
  return { loaded, failed, disabled }
}

// ---------------------------------------------------------------------------
// The fixed built-in manifest (upstream parity of wCe()'s hardcoded list).
// Import the mod file here to ship it; no other wiring needed.
//
// zai patch (2026-10-06, mods 同步):**只注册非 TUI 的内置 mod**。
//
// opencc 侧当前注册四个,三个依赖终端 UI,搬到 zai 无意义(这三个仍未搬):
//   - `diff`    —— 注册一个实时 pane(`ctx.ui.pane`),ink 组件;zai 无 TUI,
//                 终端 UI 已被 `stub-ui-sources.ts` 就地 stub 成 `return null`
//   - `handoff` —— `local-jsx` 命令,交互式 JSX 文档选择器;zai 的 slash 命令
//                 走自己的 registry(services/commands/slashList.ts),不消费
//                 vendor `getCommands()` 的 local-jsx 分支
//   - `mermaid` —— 同为 `ui.render` 渲染点变换,而 `ui.render` 事件链
//                 (hasModRenderHandlers / runModRenderChainSync)已随 TUI 能力面
//                 一并删除,这个 mod 没有可挂载的通道
//
// `mod-probe` 是唯一搬过来的:它只 import `engine.js` / `protocol.js`,不 import
// 本文件,**因此不构成循环依赖**,可以顶层 import(与 modctl 的情况相反)。
// 它是 optIn 的 —— 默认关着、只在 `/plugins` 显式打开才加载 —— 所以常驻噪音
// 为零;打开后它订阅全部事件并报告哪些真的派发过。
//
// 注意:`/mod-probe` 本身**分不清「没接线」和「本次没调用」** —— op 事件要等对应
// 的 `$` 方法被调用才触发,一次只有 4 个内建 mod 的 session 里 `fs.read` /
// `store.get` / `clock.now` 都不会出现,而它们实现完好。静态分析才是准确判据,
// 探针只适合发现「跑着跑着哑掉」的事件。
//
// zai patch (2026-10-11):**`mods/builtin/modctl.ts` 刻意不注册** —— 它订阅全部
// 事件并向每轮对话回注 `[modctl] …`,常驻噪音对每个会话都是负担。文件与单测
// (`test/unit/mods-builtinModctl.test.ts`)仍在树上,其 import 自身会执行
// `registerBuiltinMod`,所以单测不依赖加载器。
//
// 将来要把 modctl 挂回来,注意**必须动态 import,不能写顶层 import**:顶层
// `import './builtin/modctl.js'` 会与本文件形成循环依赖 —— modctl.ts 要 import
// 本文件的 `registerBuiltinMod`,而本文件在求值末尾 import modctl。esbuild
// 打成单 bundle 后模块初始化顺序变成「modctl 的顶层代码先跑」,此刻
// `builtinSpecs` 还是 undefined,`registerBuiltinMod` 里的 `.push` 抛
// "Cannot read properties of undefined (reading 'push')"。
//
// **tsc 绿、build:core 绿、bundle 字节数不变,只有真 import bundle 才炸**
// —— 所以要走 `loadBuiltinMods` 里一次幂等的 `await import(...)`,不要
// 「简化」回顶层 import。
// ---------------------------------------------------------------------------
import { modProbeBuiltinMod } from './builtin/modProbe.js'

registerBuiltinMod(modProbeBuiltinMod)
