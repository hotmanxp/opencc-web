/**
 * openccInit — bridges opencc vendor's `enableConfigs()` into zai's
 * startup flow. opencc vendor has a `configReadingAllowed` flag
 * (config.ts:1473) that throws on any getConfig() until set. The
 * flag is set by `enableConfigs()` which loads the global config
 * from disk (~/.claude.json by default).
 *
 * zai-server must call `enableOpenccConfigs()` BEFORE invoking the
 * DefaultAgentRuntime, otherwise the bridge's lazy import of the
 * bundled opencc-core.mjs → queryLoop → getConfig() throws
 * "Config accessed before allowed."
 *
 * Imported lazily on first call to avoid pulling the opencc vendor
 * bundle (~18MB) into the zai-server boot path before needed.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Imported via the package's `./opencc-core` subpath export (see
// package.json `exports`). All opencc vendor code is bundled into
// this single .mjs by scripts/bundle-opencc.ts.
const BUNDLE_URL = '@zn-ai/zn-agent-core/opencc-core'

/**
 * zai patch: pre-populate `globalThis.MACRO` before the opencc bundle
 * evaluates. vendor's built-time macro substitutions are normally
 * injected via `bun --define MACRO=...` (see opencc-src/main.tsx:2554,
 * utils/sessionStorage.ts:100, tools/AgentTool/built-in/
 * claudeCodeGuideAgent.ts:94 and 181 other unrguarded call sites).
 * zai-server doesn't pass `--define`, so the first time vendor code
 * touches `MACRO.VERSION` (e.g. when the bridge yields
 * `claudeCodeGuideAgent.prompt` for an Explore sub-agent's system
 * prompt at runAgent.ts:1011) we hit `ReferenceError: MACRO is not
 * defined` and the user gets `<tool_result>MACRO is not
 * defined</tool_result>` for every sub-agent dispatch.
 *
 * Injecting a runtime stub here — before the dynamic-import of the
 * bundle — guarantees the global is in place when bundle evaluation
 * encounters those 182 unrguarded MACRO.X references. Three vendor
 * sites already use `typeof MACRO !== 'undefined' ? MACRO.X :
 * 'unknown'` (utils/doctorDiagnostic.ts:599, utils/sessionStorage.ts:
 * 100, commands/insights.ts:2507) — those would degrade gracefully;
 * the rest throw if MACRO isn't defined. The stub covers all 9
 * fields discovered via `grep -rho "MACRO\\.[A-Z_]\\+" src/opencc-src
 * | sort -u`.
 *
 * Values mirror what zai's product surface exposes:
 *   - VERSION: this package's own version (we are the vendor from
 *     zai-server's perspective — main.tsx:2554 treats MACRO.VERSION
 *     as the running product's identifier)
 *   - others: simple fallback strings / booleans; revisit when
 *     /feedback command is wired through.
 */
export function installMacroStub(): void {
  const g = globalThis as any
  if (g.MACRO && typeof g.MACRO === 'object' && typeof g.MACRO.VERSION === 'string') {
    return
  }
  // zai's own pkg version is a reasonable proxy; build-time
  // reflection isn't worth the bundle-size cost here.
  const VERSION = '0.1.0'
  const DISPLAY_VERSION = '0.1.0'
  const BUILD_TIME = new Date().toISOString()
  const IS_DEVELOPMENT_BUILD = true
  const PACKAGE_URL = 'https://www.npmjs.com/package/@zn-ai/zn-agent-core'
  const ISSUES_EXPLAINER =
    '请通过 `/feedback` 命令提交 bug 或建议,或在仓库 issue tracker 中报告。'
  const FEEDBACK_CHANNEL = '/feedback'
  const VERSION_CHANGELOG =
    'https://github.com/zn-ai/opencc-web/blob/main/packages/zn-agent-core/CHANGELOG.md'
  g.MACRO = {
    VERSION,
    DISPLAY_VERSION,
    BUILD_TIME,
    IS_DEVELOPMENT_BUILD,
    PACKAGE_URL,
    // ant-only field; absent in zai builds. Use undefined rather
    // than '' so truthy-checks (e.g. `if (MACRO.NATIVE_PACKAGE_URL)`)
    // behave the same as if the global hadn't been populated.
    NATIVE_PACKAGE_URL: undefined,
    ISSUES_EXPLAINER,
    FEEDBACK_CHANNEL,
    VERSION_CHANGELOG,
  }
}

let enabled = false

export async function enableOpenccConfigs(): Promise<void> {
  if (enabled) return
  enabled = true
  // zai patch: pre-populate globalThis.MACRO BEFORE importing the
  // bundle (see comment on installMacroStub). The bundle evaluates
  // top-level code that references MACRO.X — without this stub the
  // first reference throws ReferenceError and aborts startup.
  installMacroStub()
  // Pre-flight resolve so the error points to the build step rather
  // than a deep "Cannot find module" from Node's resolver.
  try {
    const url = (await import.meta.resolve?.(BUNDLE_URL)) ?? BUNDLE_URL
    if (url.startsWith('file://') && !existsSync(fileURLToPath(url))) {
      throw new Error('bundle path does not exist on disk')
    }
  } catch {
    throw new Error(
      `[openccInit] cannot resolve ${BUNDLE_URL}. ` +
      `Run \`pnpm --filter @zn-ai/zn-agent-core build\` to (re)generate the bundle.`,
    )
  }
  // The bundle re-exports config.ts (opencc vendor's global config
  // module). Importing config.ts on its own sets
  // `configReadingAllowed = true` via the top-level await in
  // opencc's enableConfigs() entry, but only if we trigger the
  // import side-effect. To be safe we explicitly call enableConfigs
  // if it's exposed by the bundle.
  const bundle = (await import(/* @vite-ignore */ BUNDLE_URL as any)) as any
  if (typeof bundle.enableConfigs === 'function') {
    bundle.enableConfigs()
  }
}