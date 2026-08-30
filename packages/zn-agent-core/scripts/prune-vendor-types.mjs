#!/usr/bin/env node
/**
 * Prune dead vendor .d.ts files from dist/opencc-src/.
 *
 * `tsc -b` (main tsconfig.json) follows the transitive type graph even
 * for files under `src/opencc-src/` (composite: false disables the
 * "all referenced files must be in the project file list" enforcement
 * but does not stop tsc from walking imports). It then emits ~2151
 * .d.ts files into `dist/opencc-src/` — a 17 MB dead-type surface
 * that zai consumers never reference. The package's actual public
 * type surface comes from a small, well-defined set of paths:
 *
 *   1. Hand-written d.ts files emitted by `scripts/bundle-opencc.ts`
 *      via direct writeFileSync calls (see "Tool type declarations" +
 *      "Subagent registry barrel d.ts" + "printSessionRuntime types"
 *      + "Session API counter types" + "Generic model capabilities
 *      types" sections in bundle-opencc.ts).
 *   2. d.ts files emitted by `tsc -p tsconfig.server.json` and copied
 *      from `.server-types-tmp/opencc-src/server/` to
 *      `dist/opencc-src/server/` by bundle-opencc.ts. Self-containment
 *      of the server public surface is enforced by
 *      `verify-server-types-self-contained.mjs`.
 *
 * Everything else in dist/opencc-src/ is the transitive vendor type
 * emission and can be safely deleted — the package's main-entry
 * `dist/bundle-entry.d.ts` (hand-written mirror of bundle-entry.ts)
 * only references the kept paths; see the DTS_PATH_REWRITE map in
 * bundle-opencc.ts for the vendor paths that get redirected to
 * compat/index.js.
 *
 * Invoked as a step in `pnpm build` after `tsc -b` finishes its
 * (largely throwaway) emit. Mirrors the empty-directory cleanup
 * pattern in prune-dead-dist.mjs.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DIST_OPENCC_SRC = join(ROOT, 'dist', 'opencc-src')

/**
 * Load-bearing d.ts files in dist/opencc-src/ (the package's actual
 * public type surface for the vendor tree). Keep this list in sync
 * with the writeFileSync calls in bundle-opencc.ts + the copy loop
 * that materializes dist/opencc-src/server/*.d.ts.
 */
const KEEP_RELATIVE_PATHS = new Set([
  // Hand-written by bundle-opencc.ts. Source of truth lives in
  // scripts/bundle-opencc.ts at each `writeFileSync(...)` site.
  'Tool.d.ts',
  'utils/printSessionRuntime.d.ts',
  'utils/model/genericModelCapabilities.d.ts',
  'services/api/sessionApiCounter.d.ts',
])

/**
 * Subdirectories under dist/opencc-src/ that should be kept entirely.
 * The `server/` directory is a wholesale copy from
 * .server-types-tmp/opencc-src/server/ (see the copy loop in
 * bundle-opencc.ts); every file inside is part of the server public
 * surface or a transitively-required sibling. The
 * verify-server-types-self-contained script enforces the public files
 * specifically; the rest stay because they're already on disk and
 * tsc -p tsconfig.server.json will regenerate them on the next build.
 *
 * Add new wholesale-keep subdirs here if a future bundle-opencc.ts
 * change makes another vendor subtree load-bearing.
 */
const KEEP_SUBDIRS = new Set(['server'])

let deleted = 0

function walk(dir, relBase = '') {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    const rel = relBase ? `${relBase}/${name}` : name
    if (stat.isDirectory()) {
      walk(full, rel)
      // Empty directory cleanup — mirrors prune-dead-dist.mjs.
      const remaining = readdirSync(full).length
      if (remaining === 0) rmSync(full, { recursive: true })
      continue
    }
    if (!name.endsWith('.d.ts')) continue
    if (KEEP_RELATIVE_PATHS.has(rel)) continue
    // Files inside KEEP_SUBDIRS are kept; the parent directory is
    // walked recursively above and the dir itself is not deleted
    // because the keep check runs per-file. We must skip the
    // deletion here.
    if (relBase && KEEP_SUBDIRS.has(relBase)) continue
    rmSync(full)
    deleted++
    console.log(`[prune-vendor-types] removed ${rel}`)
  }
}

if (!existsSync(DIST_OPENCC_SRC)) {
  console.log('[prune-vendor-types] dist/opencc-src/ not found — nothing to prune')
  process.exit(0)
}

walk(DIST_OPENCC_SRC)
console.log(
  `[prune-vendor-types] done — removed ${deleted} dead vendor d.ts file(s); kept ${KEEP_RELATIVE_PATHS.size} hand-written + the server/ subtree`,
)