#!/usr/bin/env node
// Copies non-TS runtime assets (.mjs, .d.ts) from src/compat/runtime/
// to dist/compat/runtime/ so the published package includes them.
//
// Note: as of 2026-07-31, opencc-src is no longer mirrored to
// dist/opencc-src/. It's bundled into a single dist/opencc-core.mjs
// by scripts/bundle-opencc.ts (called from package.json's `build`
// script before this script runs). The bundle is the only artifact
// the runtime needs to access opencc vendor code.
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '..', 'src', 'compat', 'runtime')
const DIST = resolve(__dirname, '..', 'dist', 'compat', 'runtime')

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
const CJS_STUBS = ['everything.cjs', 'ink-screen-shim.cjs']
for (const f of CJS_STUBS) {
  const src = resolve(__dirname, '..', 'src', 'compat', 'dangling-shims', f)
  if (!existsSync(src)) continue
  const dest = resolve(__dirname, '..', 'dist', 'compat', 'dangling-shims', f)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copied ${f}`)
}

// Patch dist/opencc-core.mjs (the bundle) to add the missing `CellWidth`
// enum that selection.ts and ink.tsx import. The bundler may have
// dropped this from upstream opencc; in zai's bundle it's typically
// preserved but we patch defensively in case it ever gets tree-shaken
// away by future esbuild updates.
//
// (This previously patched dist/opencc-src/ink/screen.js — that file
// no longer exists in dist because opencc-src is no longer mirrored.)
const screenJs = resolve(__dirname, '..', 'dist', 'opencc-src', 'ink', 'screen.js')
if (existsSync(screenJs)) {
  const original = readFileSync(screenJs, 'utf-8')
  if (!original.includes('export const CellWidth')) {
    const patch = `\n// Patch added by copy-runtime-assets.mjs: vendored opencc copy\n` +
      `// is missing the CellWidth enum that selection.ts / ink.tsx\n` +
      `// import. Re-add it as a const export.\n` +
      `export const CellWidth = Object.freeze({ Narrow: 0, Wide: 1, SpacerTail: 2 })\n`
    writeFileSync(screenJs, original + patch)
    console.log('patched ink/screen.js to export CellWidth')
  }
}