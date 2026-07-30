/**
 * openccInit — bridges opencc vendor's `enableConfigs()` into zai's
 * startup flow. opencc vendor has a `configReadingAllowed` flag
 * (config.ts:1473) that throws on any getConfig() until set. The
 * flag is set by `enableConfigs()` which loads the global config
 * from disk (~/.claude.json by default).
 *
 * zai-server must call `enableOpenccConfigs()` BEFORE invoking the
 * DefaultAgentRuntime, otherwise the bridge's lazy import of
 * opencc-src/query.js → queryLoop → getConfig() throws
 * "Config accessed before allowed."
 *
 * Imported lazily on first call to avoid pulling opencc vendor
 * (~14MB vendored tree) into the zai-server boot path before
 * needed.
 */

import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

let enabled = false

export async function enableOpenccConfigs(): Promise<void> {
  if (enabled) return
  enabled = true
  // Compute the opencc vendor path the same way the bridge does:
  // dist/compat/openccInit.{js,ts} → ../opencc-src/ → dist/opencc-src/
  const here = fileURLToPath(import.meta.url)
  const openccSrc = join(dirname(here), '..', 'opencc-src')
  // Dynamic import by file URL — Bun and Node both accept this.
  const configUrl = pathToFileURL(join(openccSrc, 'utils', 'config.js')).href
  const configMod = await import(/* @vite-ignore */ configUrl as any) as any
  configMod.enableConfigs()
}