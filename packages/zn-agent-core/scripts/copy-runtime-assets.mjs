#!/usr/bin/env node
// Copies non-TS runtime assets (.mjs, .d.ts) from src/compat/runtime/
// to dist/compat/runtime/ so the published package includes them.
//
// Also recursively copies src/opencc-src/ → dist/opencc-src/ so the
// bridge's `import(<OPENCC_SRC_DIR>/query.js)` resolves at runtime
// (in production). The vendored tree is already strip-listed by
// copy-from-opencc.ts (run separately); we just mirror it.
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '..', 'src', 'compat', 'runtime')
const DIST = resolve(__dirname, '..', 'dist', 'compat', 'runtime')
const SRC_OPENCC_DIR = resolve(__dirname, '..', 'src', 'opencc-src')
const DIST_OPENCC_DIR = resolve(__dirname, '..', 'dist', 'opencc-src')

const ASSETS = [
  'bun-protocol.mjs',
  'bun-shim.ts',
  'bun-feature-shim.ts',
  'bun-bundle.d.ts',
  // Shared alias regex source for vitest.config.ts + bun-protocol.mjs.
  'stripped-dirs.mjs',
  // CJS Proxy stub for last-resort catch-all in bun-protocol.mjs.
  // Provides any named import dynamically.
  'everything.cjs',
]

for (const f of ASSETS) {
  const src = resolve(SRC, f)
  if (!existsSync(src)) continue
  const dest = resolve(DIST, f)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copied ${f}`)
}

// Also copy the CJS Proxy stub from dangling-shims/. This is a
// CommonJS module (uses module.exports = new Proxy(...)) so it
// must be copied as-is to dist (not compiled to .js by tsc, since
// tsc only handles .ts).
const CJS_STUBS = ['everything.cjs']
for (const f of CJS_STUBS) {
  const src = resolve(__dirname, '..', 'src', 'compat', 'dangling-shims', f)
  if (!existsSync(src)) continue
  const dest = resolve(__dirname, '..', 'dist', 'compat', 'dangling-shims', f)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copied ${f}`)
}

/**
 * Recursively copy src/opencc-src/ → dist/opencc-src/. Skip .test.* files
 * (opencc vendor tests have bun:test imports that break under Node —
 * already stripped by 512dcbde, but be defensive).
 */
function copyDirRecursive(srcDir, destDir) {
  if (!existsSync(srcDir)) return 0
  let count = 0
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir)) {
    const srcPath = resolve(srcDir, entry)
    const destPath = resolve(destDir, entry)
    const st = statSync(srcPath)
    if (st.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath)
    } else if (/\.test\.[mc]?[jt]s$/.test(entry)) {
      continue
    } else {
      copyFileSync(srcPath, destPath)
      count++
    }
  }
  return count
}

const copied = copyDirRecursive(SRC_OPENCC_DIR, DIST_OPENCC_DIR)
console.log(`copied ${copied} files from src/opencc-src → dist/opencc-src`)
