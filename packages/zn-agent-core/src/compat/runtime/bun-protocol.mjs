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
 *   3. Intercepts `src/<stripped>/...` specifiers (BEFORE the generic `src/...`
 *      catch-all) and routes them to `dangling-shims/opencc-stripped.ts`.
 *      opencc's source still references these stripped directories via
 *      project-relative paths (e.g. `from 'src/memdir/paths.js'`); without
 *      this precedence, the catch-all would map them to <OPENCC_SRC_DIR>
 *      which doesn't have those dirs.
 *   4. Intercepts `src/...` specifiers (opencc's project-relative imports)
 *      and maps them to `<OPENCC_SRC_DIR>/...`. opencc's source uses
 *      `from 'src/services/...'` (NOT relative paths) — Node's default ESM
 *      resolution looks in node_modules for non-relative specifiers, which
 *      doesn't find `src/`. Without this redirect the bridge fails with
 *      `ERR_MODULE_NOT_FOUND: Cannot find package 'src'`.
 *   5. Intercepts npm packages opencc vendor references but that aren't in
 *      our dependencies (env-paths, lru-cache, jsonc-parser).
 *   6. Lets all other specifiers through to the default resolver
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
import { existsSync } from 'node:fs'
import { ABSOLUTE_RE, STRIPPED_DIRS } from './stripped-dirs.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHIM_DIR = __dirname
// opencc-src/ lives at <root>/src/opencc-src/. From this file (which lives
// at <root>/src/compat/runtime/), that's ../../opencc-src.
const OPENCC_SRC_DIR = resolve(__dirname, '..', '..', 'opencc-src')
const DANGLING_SHIM = resolve(SHIM_DIR, '..', 'dangling-shims')

const REDIRECTS = {
  'bun:bundle': pathToFileURL(resolve(SHIM_DIR, 'bun-shim.js')).href,
  // bun:feature is a separate Bun built-in not used in opencc-src/ as of 0.20.0,
  // but reserve a slot in case a future sync adds it.
  'bun:feature': pathToFileURL(resolve(SHIM_DIR, 'bun-feature-shim.js')).href,
  // npm packages opencc vendor references but that aren't in our
  // dependencies. Match the alias list in vitest.config.ts.
  'env-paths': pathToFileURL(resolve(DANGLING_SHIM, 'env-paths.js')).href,
  'lru-cache': pathToFileURL(resolve(DANGLING_SHIM, 'lru-cache.js')).href,
  // @orama/orama — Vite SSR wrapper (`__vite_ssr_import_0__`) can't
  // unwrap the CJS path's named exports. Stub instead. zai doesn't
  // read opencc's knowledge-graph state.
  '@orama/orama': pathToFileURL(resolve(DANGLING_SHIM, 'orama.js')).href,
  '@orama/plugin-data-persistence': pathToFileURL(resolve(DANGLING_SHIM, 'orama.js')).href,
  // opencc-src/ink/screen.js — vendored copy is missing the `CellWidth`
  // enum that selection.ts and ink.tsx import. Re-export real screen.js
  // and add the missing named export. See
  // compat/dangling-shims/ink-screen-shim.cjs.
  'ink/screen.js': pathToFileURL(resolve(DANGLING_SHIM, 'ink-screen-shim.cjs')).href,
  // jsonc-parser — installed as a real dep (see package.json). No
  // redirect needed; Node resolves from node_modules.
}

// Specific specifiers we redirect. Match vitest.config.ts modelCost.ts
// alias — opencc vendor has a circular import (utils/model/model.ts ↔
// utils/modelCost.ts) that throws under Node ESM. The stub breaks the
// cycle by using hardcoded string keys for MODEL_COSTS.
// See dangling-shims/modelCost-stub.ts for the trade-off.
const MODELCOST_RE = /modelCost\.(?:ts|js)$/

async function bunResolve(specifier, context, nextResolve) {
  // CRITICAL ORDER: stripped-dir `src/<stripped>/...` MUST come BEFORE the
  // generic `src/...` catch-all below. Without this precedence, project-
  // relative imports like `src/memdir/paths.js` would map to
  // <OPENCC_SRC_DIR>/memdir/paths.ts (doesn't exist; stripped at
  // vendoring) instead of the dangling-shim that exports safe defaults.
  //
  // Target paths use `.js` (not `.ts`) because this loader is run
  // from dist/ in production (`tsx --loader bun-protocol.mjs`), and
  // dist/ only has compiled `.js` files. Vitest's vite-node handles
  // .js → .ts source resolution via its own resolver, so this also
  // works in tests.
  if (ABSOLUTE_RE.test(specifier)) {
    const url = pathToFileURL(resolve(DANGLING_SHIM, 'opencc-stripped.js')).href
    return { url, shortCircuit: true, format: 'module' }
  }
  // modelCost.ts — circular-import stub (see above). Match BEFORE the
  // generic 'src/...' and REDIRECTS so it captures `../modelCost.ts`.
  if (MODELCOST_RE.test(specifier)) {
    const url = pathToFileURL(resolve(DANGLING_SHIM, 'modelCost-stub.js')).href
    return { url, shortCircuit: true, format: 'module' }
  }
  // opencc's generated integration artifacts (`integrations/generated/*.generated.js`,
  // `types/generated/*.ts`) live only in the opencc build output — they
  // don't exist in the vendored snapshot. Route to a stub that exports
  // safe defaults (ANTHROPIC_PROXY_DESCRIPTORS, GATEWAY_DESCRIPTORS,
  // ClaudeCodeInternalEvent, etc.) so transitive imports resolve.
  if (/(?:\.\.\/)+integrations\/generated\/.*\.generated\.js$/.test(specifier)
      || /(?:\.\.\/)+types\/generated\/.*\.ts$/.test(specifier)) {
    const url = pathToFileURL(resolve(DANGLING_SHIM, 'opencc-generated.js')).href
    return { url, shortCircuit: true, format: 'module' }
  }
  // Relative paths like `'../SessionMemory/sessionMemoryUtils.js'`
  // resolve to a stripped dir under dist/opencc-src/. Detect by
  // resolving the specifier against the parent (provided via
  // context.parentURL) and checking if the resolved path lives
  // under a stripped dir.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentURL = context.parentURL
    if (parentURL) {
      const parentPath = fileURLToPath(parentURL)
      // .js → .ts/.tsx fallback for vendored source.
      let resolved = resolve(dirname(parentPath), specifier)
      if (specifier.endsWith('.js') && !existsSync(resolved)) {
        for (const ext of ['.ts', '.tsx']) {
          const alt = resolved.replace(/\.js$/, ext)
          if (existsSync(alt)) { resolved = alt; break }
        }
      }
      resolved = resolved.replace(/\\/g, '/')
      // Strip OPENCC_SRC_DIR prefix to get the relative path
      // inside the vendored tree.
      const rel = resolved
        .replace(OPENCC_SRC_DIR, '')
        .replace(/^\/+/, '')
      // Match patterns like "services/SessionMemory/..." or
      // "memdir/..." (top-level stripped) or "utils/SessionMemory/..."
      // or top-level like "commands" (no trailing slash). The strip
      // may have a `.ts`/`.tsx`/`.js` extension we ignore. STRIPPED_DIRS
      // may also be multi-segment (e.g. "utils/task/framework") — match
      // the full path against the longest prefix in STRIPPED_DIRS.
      let matched = null
      for (const candidate of STRIPPED_DIRS) {
        const prefix = candidate
        if (rel === prefix
            || rel.startsWith(prefix + '/')
            || rel.startsWith(prefix + '.')
            || (rel.startsWith(prefix) && /[\.\/]/.test(rel[prefix.length] ?? ''))) {
          matched = candidate
          break
        }
      }
      // Catch-all for tool UI components: opencc's `**/UI.tsx` glob
      // strips every tool's React UI, but the tool's `index.tsx` still
      // references `./UI.js`. Route any `tools/*/UI*` import to
      // opencc-stripped (the bridge path doesn't need UI for streaming
      // SDKMessages).
      if (!matched && /^tools\/[^\/]+\/UI(?:\.[a-z]+)?$/.test(rel)) {
        matched = 'tools/*/UI'
      }
      // Last-resort catch-all: any import under dist/opencc-src/ that
      // resolves to a non-existent file (no .ts/.tsx fallback found)
      // gets routed to opencc-stripped. ESM named imports are static,
      // so we can't dynamically provide every missing name — instead
      // we maintain a curated list in opencc-stripped.ts of every
      // name opencc vendor's transitive imports need. The list is
      // grown as new names are surfaced (see error messages from
      // the bridge: "The requested module X does not provide an
      // export named Y" → add Y to opencc-stripped.ts).
      if (!matched) {
        // ink/screen.js — vendored copy is missing the `CellWidth`
        // enum that selection.ts and ink.tsx import. Re-export real
        // screen.js + add the missing enum. Match by absolute path
        // suffix so relative imports from selection.ts hit this.
        if (/\/ink\/screen\.(?:js|ts|tsx)$/.test(resolved)) {
          const url = pathToFileURL(resolve(DANGLING_SHIM, 'ink-screen-shim.cjs')).href
          return { url, shortCircuit: true, format: 'module' }
        }
        if (!existsSync(resolved)
            && !existsSync(resolved.replace(/\.js$/, '.ts'))
            && !existsSync(resolved.replace(/\.js$/, '.tsx'))) {
          const url = pathToFileURL(resolve(DANGLING_SHIM, 'opencc-stripped.js')).href
          return { url, shortCircuit: true, format: 'module' }
        }
      }
      if (matched) {
        const url = pathToFileURL(resolve(DANGLING_SHIM, 'opencc-stripped.js')).href
        return { url, shortCircuit: true, format: 'module' }
      }
    }
  }
  // opencc's vendored source uses project-relative `src/...` specifiers
  // (NOT relative paths). Node's default ESM resolution looks in
  // node_modules for non-relative specifiers, so without this redirect
  // every such import fails with `ERR_MODULE_NOT_FOUND: Cannot find
  // package 'src'`. Map `src/services/foo.js` → `<OPENCC_SRC_DIR>/services/foo.js`.
  //
  // Vendored source is `.ts` but imports use `.js` extension (opencc
  // is a TS project whose internal imports use `.js` per ESM
  // convention). tsc excludes `src/opencc-src` from compilation, so
  // dist only has `.ts` files. Substitute `.js` → `.ts` here.
  if (specifier.startsWith('src/')) {
    const stripped = specifier.slice('src/'.length)
    let resolved = resolve(OPENCC_SRC_DIR, stripped)
    if (stripped.endsWith('.js') && !existsSync(resolved)) {
      // Vendored source is `.ts` / `.tsx` but imports use `.js`
      // extension (opencc is a TS project). tsc excludes
      // `src/opencc-src` from compilation, so dist only has `.ts`
      // / `.tsx` files. Try both.
      for (const ext of ['.ts', '.tsx']) {
        const alt = resolved.replace(/\.js$/, ext)
        if (existsSync(alt)) { resolved = alt; break }
      }
    }
    // ink/screen.js is missing the `CellWidth` enum that selection.ts
    // and ink.tsx import. Route to the shim that re-exports the
    // real screen.js + adds CellWidth. Match by absolute path so
    // both `src/ink/screen.js` (project-relative) and resolved
    // absolute paths hit this.
    if (resolved.endsWith('/ink/screen.js') || resolved.endsWith('/ink/screen.ts') || resolved.endsWith('/ink/screen.tsx')) {
      const url = pathToFileURL(resolve(DANGLING_SHIM, 'ink-screen-shim.cjs')).href
      return { url, shortCircuit: true, format: 'module' }
    }
    const url = pathToFileURL(resolved).href
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
