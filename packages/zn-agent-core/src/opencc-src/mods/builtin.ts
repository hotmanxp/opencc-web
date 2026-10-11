import { logForDebugging } from '../utils/debug.js'
import type { UserConfigSchema } from '../utils/plugins/mcpbHandler.js'
import type { LoadedMod } from './registry.js'
import {
  BUILTIN_ORIGIN,
  getLoadedMods,
  registerLoadedMod,
  noteDiscoveredMod,
} from './registry.js'
import { isModEnabled } from './pluginView.js'
import { createModContext, type ModContext } from './engine.js'

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
   * zai patch (2026-10-10, mods 同步):用户可配置项,与磁盘 mod 的
   * `opencc-mod.json` → `userConfig` 同 schema 同存储,复用同一套配置对话框。
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
    if (!isModEnabled(spec.name, true)) {
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
// zai patch (2026-10-06, mods 同步):**故意留空**。
//
// opencc 侧当前注册了两个内置 mod,两个都依赖终端 UI,搬到 zai 无意义(这两个仍未搬):
//   - `diff`    —— 注册一个实时 pane(`ctx.ui.pane`),ink 组件;zai 无 TUI,
//                 终端 UI 已被 `stub-ui-sources.ts` 就地 stub 成 `return null`
//   - `handoff` —— `local-jsx` 命令,交互式 JSX 文档选择器;zai 的 slash 命令
//                 走自己的 registry(services/commands/slashList.ts),不消费
//                 vendor `getCommands()` 的 local-jsx 分支
//
// 通道本身(registerBuiltinMod / loadBuiltinMods)完整保留:第一方功能想用 mod
// 形态实现时,在这里 import + registerBuiltinMod 即可,不需要再动加载器。
//
// zai patch (2026-10-11):**再次留空** —— `mods/builtin/modctl.ts` 与它的单测
// (`test/unit/mods-builtinModctl.test.ts`)**仍在树上,但不再注册**。
//
// 它曾经是第一个(也是唯一一个)内置 mod,订阅全部 7 个非 ui 事件并向每轮对话
// 回注 `[modctl] …`。当时的用途是自检 + 给内置 mod 这条路径找真实数据验;hook
// 管线的接线(工作区信任门修复,`server/createHeadlessContext-impl.ts`)
// 收尾后使命结束,而常驻噪音对每个会话都是负担,故摘掉。
//
// 单测不依赖加载器:它顶层直接 `import modctl.js`,那条 import 自己就执行了
// `registerBuiltinMod`,所以 `builtinSpecs` 仍有数据可测。
//
// 将来要重新挂上时,注意**必须动态 import,不能写顶层 import**:顶层
// `import './builtin/modctl.js'` 会与本文件形成循环依赖 —— modctl.ts 要 import
// 本文件的 `registerBuiltinMod`,而本文件在求值末尾 import modctl。esbuild
// 打成单 bundle 后模块初始化顺序变成「modctl 的顶层代码先跑」,此刻
// `builtinSpecs` 还是 undefined,`registerBuiltinMod` 里的 `.push` 抛
// "Cannot read properties of undefined (reading 'push')"。
//
// **tsc 绿、build:core 绿、bundle 字节数不变,只有真 import bundle 才炸**
// —— 所以要走 `loadBuiltinMods` 里一次幂等的 `await import(...)`(原实现是
// 这个形状,函数名 `ensureBuiltinManifest`),不要「简化」回顶层 import。
