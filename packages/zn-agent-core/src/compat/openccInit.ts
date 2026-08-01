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

let enabled = false

export async function enableOpenccConfigs(): Promise<void> {
  if (enabled) return
  enabled = true
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