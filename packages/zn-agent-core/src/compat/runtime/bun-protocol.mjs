/**
 * Node loader hook to redirect `bun:` specifiers to local shims.
 *
 * zai's vendored opencc source uses `import { feature } from 'bun:bundle'`
 * (Bun-only built-in module). Under Node, this URL scheme is not supported
 * and crashes with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
 *
 * This loader:
 *   1. Intercepts `bun:bundle` and redirects to `bun-shim.ts`
 *   2. Intercepts `bun:feature` and redirects to a no-op shim (rare, but present)
 *   3. Lets all other specifiers through to the default resolver
 *
 * Usage (tsx --loader — recommended, works in Node 18+):
 *   tsx --loader ./bun-protocol.mjs src/cli/index.ts dev
 *
 * Usage (tsx --import):
 *   tsx --import ./bun-protocol.mjs src/cli/index.ts dev
 *
 * Usage (vitest setupFiles):
 *   vitest.config.ts: setupFiles: ['./bun-protocol.mjs']
 */

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHIM_DIR = __dirname

const REDIRECTS = {
  'bun:bundle': pathToFileURL(resolve(SHIM_DIR, 'bun-shim.ts')).href,
  // bun:feature is a separate Bun built-in not used in opencc-src/ as of 0.20.0,
  // but reserve a slot in case a future sync adds it.
  'bun:feature': pathToFileURL(resolve(SHIM_DIR, 'bun-feature-shim.ts')).href,
}

async function bunResolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(REDIRECTS, specifier)) {
    return { url: REDIRECTS[specifier], shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}

function bunLoad(url, context, nextLoad) {
  return nextLoad(url, context)
}

export { bunResolve as resolve, bunLoad as load }
