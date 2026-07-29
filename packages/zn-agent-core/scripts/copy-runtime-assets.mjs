#!/usr/bin/env node
// Copies non-TS runtime assets (.mjs, .d.ts) from src/compat/runtime/
// to dist/compat/runtime/ so the published package includes them.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
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
]

for (const f of ASSETS) {
  const src = resolve(SRC, f)
  if (!existsSync(src)) continue
  const dest = resolve(DIST, f)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copied ${f}`)
}
