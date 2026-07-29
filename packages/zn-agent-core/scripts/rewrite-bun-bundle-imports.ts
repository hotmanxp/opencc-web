#!/usr/bin/env tsx
/**
 * Rewrite `import { feature } from 'bun:bundle'` → `from '../shims/bun-bundle.js'`
 * across all .ts/.tsx files in src/opencc-src/.
 */
import { execSync } from 'child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..', 'src', 'opencc-src')
const SHIM_FILE = join(ROOT, 'shims', 'bun-bundle.js')

function walk(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(e) && full !== SHIM_FILE) {
      out.push(full)
    }
  }
  return out
}

let rewritten = 0
for (const f of walk(ROOT)) {
  const before = execSync(`grep -c "from 'bun:bundle'" "${f}" || true`).toString().trim()
  if (before === '0' || before === '') continue
  // Compute relative path from this file to shim
  let target = relative(dirname(f), join(ROOT, 'shims', 'bun-bundle.js')).replace(/\\/g, '/')
  if (!target.startsWith('.')) target = './' + target
  execSync(`sed -i.bak "s|from 'bun:bundle'|from '${target}'|g" "${f}"`)
  execSync(`rm "${f}.bak"`)
  rewritten++
}

console.log(`Rewrote bun:bundle imports in ${rewritten} files`)