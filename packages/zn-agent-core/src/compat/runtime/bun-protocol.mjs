/**
 * Node loader hook for zai compat layer.
 *
 * As of 2026-07-31 the bulk of opencc vendor is bundled into a single
 * `dist/opencc-core.mjs` (see scripts/bundle-opencc.ts). This loader is
 * now ONLY needed for the few compatibility-layer .ts files that
 * still reference opencc's bare-specifier imports (e.g. `import { feature }
 * from 'bun:bundle'`) and a handful of npm packages opencc's loose
 * files reference that aren't in our deps.
 *
 * Redirects:
 *   - bun:bundle → bun-shim (no-op for non-Bun runtimes)
 *   - bun:feature → bun-feature-shim
 *   - npm packages opencc vendor references but that aren't in our
 *     dependencies (env-paths, lru-cache, @orama/*)
 *   - modelCost.{ts,js} → modelCost-stub (breaks circular import)
 *   - ink/screen.* → ink-screen-shim (adds missing CellWidth enum)
 *
 * Other branches (relative `.js` → `.ts`/`.tsx` substitution,
 * STRIPPED_DIRS matching, UI.tsx catch-all, `src/...` redirects)
 * were removed — they're only needed if the loader handles opencc-src
 * imports, but the bundle handles those now.
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
const DANGLING_SHIM = resolve(SHIM_DIR, '..', 'dangling-shims')

const REDIRECTS = {
  'bun:bundle': pathToFileURL(resolve(SHIM_DIR, 'bun-shim.js')).href,
  'bun:feature': pathToFileURL(resolve(SHIM_DIR, 'bun-feature-shim.js')).href,
  'env-paths': pathToFileURL(resolve(DANGLING_SHIM, 'env-paths.js')).href,
  'lru-cache': pathToFileURL(resolve(DANGLING_SHIM, 'lru-cache.js')).href,
  // @orama/orama — Vite SSR wrapper (`__vite_ssr_import_0__`) can't
  // unwrap the CJS path's named exports. Stub instead. zai doesn't
  // read opencc's knowledge-graph state.
  '@orama/orama': pathToFileURL(resolve(DANGLING_SHIM, 'orama.js')).href,
  '@orama/plugin-data-persistence': pathToFileURL(resolve(DANGLING_SHIM, 'orama.js')).href,
  // ink/screen.js — vendored copy is missing the `CellWidth` enum
  // that selection.ts and ink.tsx import. Re-export real screen.js
  // + add the missing named export.
  'ink/screen.js': pathToFileURL(resolve(DANGLING_SHIM, 'ink-screen-shim.cjs')).href,
  'ink/screen': pathToFileURL(resolve(DANGLING_SHIM, 'ink-screen-shim.cjs')).href,
  // jsonc-parser — installed as a real dep. No redirect needed.
}

// Specific specifiers we redirect. opencc vendor has a circular
// import (utils/model/model.ts ↔ utils/modelCost.ts) that throws
// under Node ESM. The stub breaks the cycle by using hardcoded
// string keys for MODEL_COSTS.
const MODELCOST_RE = /modelCost\.(?:ts|js)$/

async function bunResolve(specifier, context, nextResolve) {
  if (MODELCOST_RE.test(specifier)) {
    const url = pathToFileURL(resolve(DANGLING_SHIM, 'modelCost-stub.js')).href
    return { url, shortCircuit: true, format: 'module' }
  }
  if (Object.prototype.hasOwnProperty.call(REDIRECTS, specifier)) {
    return { url: REDIRECTS[specifier], shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}

function bunLoad(url, context, nextLoad) {
  return nextLoad(url, context)
}

export { bunResolve as resolve, bunLoad as load }