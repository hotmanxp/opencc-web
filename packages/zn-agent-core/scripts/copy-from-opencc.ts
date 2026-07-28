#!/usr/bin/env tsx
/**
 * Copy opencc src/ → zn-agent-core src/opencc-src/, applying strip list.
 *
 * Usage:
 *   OPENCC_SRC=/Users/ethan/code/opencc pnpm copy-from-opencc
 *   OPENCC_SRC=/Users/ethan/code/opencc pnpm copy-from-opencc --dry-run
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import { STRIP_DIRS, STRIP_TOP_FILES, KEEP_HOOKS, KEEP_ENTRYPOINTS, KEEP_SERVICES } from './strip-list.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const OPENCC_SRC = process.env.OPENCC_SRC ?? '/Users/ethan/code/opencc/src'
const ZAI_PKG = join(__dirname, '..')
const DEST = join(ZAI_PKG, 'src', 'opencc-src')

const dryRun = process.argv.includes('--dry-run')

function shouldStrip(relPath: string): boolean {
  // Strip dirs: match by prefix
  for (const d of STRIP_DIRS) {
    if (relPath === d || relPath.startsWith(d + sep)) return true
  }
  // Strip top files: exact match
  if (STRIP_TOP_FILES.includes(relPath)) return true
  // Hooks: default strip, except explicit keepers
  if (relPath.startsWith('src/hooks/')) {
    return !KEEP_HOOKS.some((k) => relPath === k || relPath.startsWith(k.replace(/\*\*$/, '')))
  }
  // Services: default strip, except explicit keepers
  if (relPath.startsWith('src/services/')) {
    return !KEEP_SERVICES.some((k) => relPath === k || relPath.startsWith(k.replace(/\*\*$/, '')))
  }
  // Entrypoints: default strip (cli.tsx), except SDK
  if (relPath.startsWith('src/entrypoints/')) {
    return !KEEP_ENTRYPOINTS.some((k) => relPath === k || relPath.startsWith(k.replace(/\*\*$/, '')))
  }
  return false
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    const rel = relative(base, full).split(sep).join('/')
    if (st.isDirectory()) {
      if (shouldStrip(rel)) continue
      out.push(...listFiles(full, base))
    } else {
      if (shouldStrip(rel)) continue
      out.push(rel)
    }
  }
  return out
}

function main() {
  if (!existsSync(OPENCC_SRC)) {
    console.error(`OPENCC_SRC not found: ${OPENCC_SRC}`)
    process.exit(1)
  }

  const files = listFiles(OPENCC_SRC)
  console.log(`Found ${files.length} files to copy (after strip)`)

  if (dryRun) {
    for (const f of files.slice(0, 20)) console.log(`  ${f}`)
    if (files.length > 20) console.log(`  ... and ${files.length - 20} more`)
    return
  }

  if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true })

  for (const rel of files) {
    const src = join(OPENCC_SRC, rel)
    const dst = join(DEST, rel)
    mkdirSync(dirname(dst), { recursive: true })
    execSync(`cp "${src}" "${dst}"`)
  }
  console.log(`Copied ${files.length} files to ${DEST}`)

  // Write a MANIFEST.txt for traceability
  const manifest = files.sort().join('\n') + '\n'
  writeFileSync(join(DEST, 'MANIFEST.txt'), manifest)
  console.log(`Wrote MANIFEST.txt`)
}

main()
