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
  return false
}

function listFiles(dir: string, base = dir, parentRel = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    const rel = relative(base, full).split(sep).join('/')
    if (st.isDirectory()) {
      // Strip if dir matches strip-list
      if (shouldStrip(rel)) continue
      // Strip if inside a default-strip section (hooks/services/entrypoints)
      // UNLESS the path matches a keep entry (only check at depth > 1)
      const section = rel.split('/')[0]
      if (rel.includes('/') && (section === 'hooks' || section === 'services' || section === 'entrypoints')) {
        const keepers = section === 'hooks' ? KEEP_HOOKS : section === 'services' ? KEEP_SERVICES : KEEP_ENTRYPOINTS
        // KEEP_* patterns are sub-paths (e.g. "mcp/**", not "services/mcp/**")
        // so compare against the sub-path after the section
        const sub = rel.slice(section.length + 1)
        const kept = keepers.some((k) => {
          if (k.endsWith('/**')) {
            const prefix = k.slice(0, -3) // strip /**
            return sub === prefix || sub.startsWith(prefix + '/')
          }
          return sub === k
        })
        if (!kept) continue
      }
      out.push(...listFiles(full, base, rel))
    } else {
      const section = rel.split('/')[0]
      if (section === 'hooks' || section === 'services' || section === 'entrypoints') {
        const keepers = section === 'hooks' ? KEEP_HOOKS : section === 'services' ? KEEP_SERVICES : KEEP_ENTRYPOINTS
        const sub = rel.slice(section.length + 1)
        const kept = keepers.some((k) => {
          if (k.endsWith('/**')) {
            const prefix = k.slice(0, -3)
            return sub === prefix || sub.startsWith(prefix + '/')
          }
          return sub === k
        })
        if (!kept) continue
      }
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
