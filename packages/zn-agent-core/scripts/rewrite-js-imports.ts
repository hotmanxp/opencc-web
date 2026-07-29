#!/usr/bin/env tsx
/**
 * Rewrite `from './foo.js'` and `from '../bar/baz.js'` → `from './foo.ts'` /
 * `from '../bar/baz.ts'` across all .ts/.tsx files in src/opencc-src/.
 *
 * Why: opencc source uses `.js` suffix in import paths because tsc
 * with `module: NodeNext` requires it for ESM output. zai's bundler
 * config doesn't do `.js → .ts` fallback, so these imports fail at
 * resolve time. Static rewriting to `.ts` makes them work under
 * `moduleResolution: bundler`.
 *
 * Special cases:
 *   - `from '@anthropic-ai/sdk/...'` — these are real package paths, NOT touched
 *   - `from 'node:fs'` — untouched
 *   - `from './foo.js'` where `./foo.ts` doesn't exist — likely a generated
 *     file or test fixture; leave alone and log
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..', 'src', 'opencc-src')

function walk(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(e)) {
      out.push(full)
    }
  }
  return out
}

const RE_FROM_JS = /from ['"](\.\.?\/[^'"]+)\.js['"]/g

let rewritten = 0
let missing: string[] = []
for (const f of walk(ROOT)) {
  let src: string
  try {
    src = readFileSync(f, 'utf-8')
  } catch {
    continue
  }
  const matches = [...src.matchAll(RE_FROM_JS)]
  if (matches.length === 0) continue

  let modified = false
  const seen = new Set<string>()
  for (const m of matches) {
    const relImport = m[1]
    if (seen.has(relImport)) continue
    seen.add(relImport)
    const target = join(dirname(f), relImport + '.ts')
    if (!existsSync(target)) {
      missing.push(`${relImport}.js in ${f.replace(ROOT + '/', '')}`)
      continue
    }
    const re = new RegExp(`(${relImport.replace(/\./g, '\\.')})\\.js`, 'g')
    src = src.replace(re, `$1.ts`)
    modified = true
  }
  if (modified) {
    writeFileSync(f, src)
    rewritten++
  }
}

console.log(`Rewrote .js → .ts in ${rewritten} files`)
if (missing.length > 0) {
  console.log(`Missing .ts targets (${missing.length}):`)
  for (const m of missing.slice(0, 30)) console.log(`  ${m}`)
  if (missing.length > 30) console.log(`  ... and ${missing.length - 30} more`)
}