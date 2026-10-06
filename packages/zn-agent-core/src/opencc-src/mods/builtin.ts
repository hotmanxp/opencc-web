import { logForDebugging } from '../utils/debug.js'
import type { LoadedMod } from './registry.js'
import {
  BUILTIN_ORIGIN,
  getLoadedMods,
  registerLoadedMod,
} from './registry.js'
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
 * Load all declared built-in mods into the registry. Idempotent per name:
 * an already-loaded built-in (or a disk mod with the same name) is skipped,
 * so /mods reload can call this again without duplicating handlers.
 */
export async function loadBuiltinMods(): Promise<{
  loaded: LoadedMod[]
  failed: Array<{ name: string; error: string }>
}> {
  const loaded: LoadedMod[] = []
  const failed: Array<{ name: string; error: string }> = []
  const existingNames = new Set(getLoadedMods().map(m => m.manifest.name))

  for (const spec of builtinSpecs) {
    if (existingNames.has(spec.name)) continue
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
  return { loaded, failed }
}

// ---------------------------------------------------------------------------
// The fixed built-in manifest (upstream parity of wCe()'s hardcoded list).
// Import the mod file here to ship it; no other wiring needed.
//
// zai patch (2026-10-06, mods 同步):**故意留空**。
//
// opencc 侧当前注册了两个内置 mod,两个都依赖终端 UI,搬到 zai 无意义:
//   - `diff`    —— 注册一个实时 pane(`ctx.ui.pane`),ink 组件;zai 无 TUI,
//                 终端 UI 已被 `stub-ui-sources.ts` 就地 stub 成 `return null`
//   - `handoff` —— `local-jsx` 命令,交互式 JSX 文档选择器;zai 的 slash 命令
//                 走自己的 registry(services/commands/slashList.ts),不消费
//                 vendor `getCommands()` 的 local-jsx 分支
//
// 通道本身(registerBuiltinMod / loadBuiltinMods)完整保留:第一方功能想用 mod
// 形态实现时,在这里 import + registerBuiltinMod 即可,不需要再动加载器。
// ---------------------------------------------------------------------------
