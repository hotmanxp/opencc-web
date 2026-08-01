#!/usr/bin/env node
/**
 * verify-server-types-self-contained
 *
 * Post-build guard for the `@zn-ai/zn-agent-core/opencc-server` subpath.
 *
 * The public type surface for the server runtime MUST be self-contained —
 * `dist/opencc-src/server/{index,serverTypes}.d.ts` may not import from
 * any module outside the `dist/opencc-src/server/` directory. The compat
 * tree (`dist/compat/`) is not part of the published package's
 * `./opencc-server` subpath, so any cross-module import in those d.ts
 * files would fail to resolve when a downstream consumer does
 * `import { ... } from '@zn-ai/zn-agent-core/opencc-server'`.
 *
 * Why a custom script and not just `tsc --noEmit`:
 *   - `tsc --noEmit` with `--noResolve` would flag the missing
 *     `compat/*` imports, but also flags every other missing module
 *     and isn't a usable daily build signal.
 *   - `tsc --noEmit` without `--noResolve` silently drops unresolvable
 *     `import type` references — the typecheck PASSES even when the
 *     d.ts imports a missing module. That's the gap this script fills.
 *
 * The script is invoked as the last step of `pnpm build` (after
 * `copy-runtime-assets.mjs`) and as the body of `pnpm
 * typecheck:consumer` (replacing the previous `tsc --noEmit` pass).
 * Either path catches the bug.
 *
 * Bug reference: tasks 2026-08-01-opencc-server-runtime Task 1 — the
 * original `serverTypes.ts` imported from `compat/runtime/events.js` and
 * `compat/transcript/types.js`; the published d.ts referenced files
 * that did not exist; downstream consumers got a confusing resolve
 * failure that a plain `tsc --noEmit` did not catch.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIST_DIR = resolve(__dirname, '..', 'dist', 'opencc-src', 'server')

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm

let inspected = 0
let violations = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    if (!name.endsWith('.d.ts')) continue
    inspected++
    const src = readFileSync(full, 'utf8')
    const fromImportDir = dirname(full)
    for (const match of src.matchAll(IMPORT_RE)) {
      const specifier = match[1]
      // Skip sibling-file imports (./foo.js, ../foo.js within the
      // same dist tree) — `./serverTypes.js` is allowed because both
      // files live in `dist/opencc-src/server/`. Just confirm the
      // resolved target is inside `dist/opencc-src/server/`.
      if (!specifier.startsWith('.')) {
        // Bare specifier — anything except a sibling-directory
        // dependency is a violation. The package's published
        // `./opencc-server` subpath does not depend on any bare
        // module (no `react`, `zod`, etc. on the type side).
        console.error(
          `[verify-server-types] FAIL: ${relative(process.cwd(), full)} imports bare specifier "${specifier}" — opencc-server public types must be self-contained.`,
        )
        violations++
        continue
      }
      // Resolve relative import to an absolute path. The d.ts uses
      // `.js` extensions; the file at the resolved path may not
      // exist as a `.js` (it'd be a `.d.ts` here), but we only need
      // to prove the import targets a file inside the
      // `dist/opencc-src/server/` directory.
      const resolveImportsFrom = fromImportDir
      const specNoExt = specifier.replace(/\.js$/, '')
      const parts = specNoExt.split('/')
      let cursor = resolveImportsFrom
      for (const part of parts) {
        if (part === '.' || part === '') continue
        if (part === '..') {
          cursor = dirname(cursor)
          continue
        }
        cursor = resolve(cursor, part)
      }
      const target = cursor
      const rel = relative(SERVER_DIST_DIR, target)
      if (rel.startsWith('..') || rel.startsWith('/')) {
        console.error(
          `[verify-server-types] FAIL: ${relative(process.cwd(), full)} imports "${specifier}" — resolves outside the opencc-server dist tree (target: ${target}).`,
        )
        violations++
      }
    }
  }
}

walk(SERVER_DIST_DIR)

if (violations > 0) {
  console.error(
    `[verify-server-types] ${violations} cross-module import violation(s) found in dist/opencc-src/server/*.d.ts — public types must be self-contained.`,
  )
  process.exit(1)
}

console.log(
  `[verify-server-types] OK — ${inspected} d.ts file(s) in dist/opencc-src/server/ are self-contained (no cross-module imports).`,
)
