import {
  BUILTIN_MARKETPLACE_NAME,
  MODS_MARKETPLACE_NAME,
} from '../../plugins/builtinPlugins.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { PluginIdSchema } from './schemas.js'

/**
 * zai patch (2026-10-10, mods 同步):从 `enabledPlugins` 里挑出真正要走市场
 * 加载路径的条目。
 *
 * 独立成模块而不是留在 pluginLoader.ts,是为了能单独测:pluginLoader 的
 * import 链会拖进整个工具注册表(其中多处用顶层 `require()` 动态取模块),
 * 在 vitest 的 ESM 下无法解析。
 *
 * `PluginIdSchema` 从 schemas.js 复用而非本地重写 —— 校验规则只有一处定义,
 * 抄一份迟早会漂移。
 */
export function filterMarketplacePluginEntries(
  enabledPlugins: Record<string, boolean | string[] | undefined>,
): Array<[string, boolean | string[]]> {
  return Object.entries(enabledPlugins).filter(
    (entry): entry is [string, boolean | string[]] => {
      const [key, value] = entry
      // Check if it's in plugin@marketplace format (includes both enabled and disabled)
      const isValidFormat = PluginIdSchema().safeParse(key).success
      if (!isValidFormat || value === undefined) return false
      // Skip built-in plugins — handled separately by getBuiltinPlugins()
      const { marketplace } = parsePluginIdentifier(key)
      if (marketplace === BUILTIN_MARKETPLACE_NAME) return false
      // mod 与真插件共用同一个 `enabledPlugins`(见 mods/pluginView.ts ——
      // 这是刻意的,一个开关键一个真相来源),所以 mod 的条目也会流到市场
      // 解析路径。但 mod 不是市场插件:这里若不排除,它会被拿去解析一个叫
      // `mods` 的市场并失败,在插件弹窗里留下一条常驻的红色错误
      // "Plugin X not found in marketplace mods"。mod 的加载完全由
      // mods/hooks.ts 负责,不需要市场这一跳 —— 与 builtin 同理。
      return marketplace !== MODS_MARKETPLACE_NAME
    },
  )
}