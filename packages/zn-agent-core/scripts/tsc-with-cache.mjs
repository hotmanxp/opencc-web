#!/usr/bin/env node
/**
 * Typecheck with input-hash stamp cache — runs `tsc --noEmit -p <config>`
 * only when the config file or its `include` set has changed. Output is
 * empty (tsc -p produces no files anyway), so the only side effect is
 * pass/fail. A stamp file at `dist/.tsc-<safe-config-name>.stamp`
 * records the last successful hash; matching hash → skip.
 *
 * Usage: `node scripts/tsc-with-cache.mjs <tsconfig.json> [tsc-flags...]`
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, basename, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const [, , configArg, ...rest] = process.argv
if (!configArg) {
  console.error('[tsc-cache] usage: tsc-with-cache.mjs <tsconfig.json> [tsc-flags...]')
  process.exit(1)
}
const configPath = join(process.cwd(), configArg)
const configDir = dirname(configPath)
const configText = readFileSync(configPath, 'utf8')
const includeMatch = configText.match(/"include"\s*:\s*\[([\s\S]*?)\]/)
const excludeMatch = configText.match(/"exclude"\s*:\s*\[([\s\S]*?)\]/)
const parseList = (raw) =>
  raw
    .split(',')
    .map((s) => s.replace(/[",\s]/g, ''))
    .filter(Boolean)
const includes = includeMatch ? parseList(includeMatch[1]) : []
const excludes = excludeMatch ? new Set(parseList(excludeMatch[1])) : new Set()

function walkTs(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = require('node:fs').readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) out.push(full)
    }
  }
  out.sort()
  return out
}

function inputHash() {
  const h = createHash('sha1')
  h.update(`config:${configPath}\0${statSync(configPath).mtimeMs}\0${statSync(configPath).size}\n`)
  for (const rel of includes) {
    const abs = join(configDir, rel)
    let files
    try {
      files = statSync(abs).isDirectory() ? walkTs(abs) : [abs]
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const r = relative(ROOT, f).split(sep).join('/')
        const st = statSync(f)
        h.update(`${r}\0${st.mtimeMs}\0${st.size}\n`)
      } catch {}
    }
  }
  return h.digest('hex').slice(0, 16)
}

const stampName = `.tsc-${basename(configArg, '.json')}.stamp`
const stampPath = join(ROOT, 'dist', stampName)
const currentHash = inputHash()
if (existsSync(stampPath)) {
  let cached = ''
  try {
    cached = readFileSync(stampPath, 'utf8').trim()
  } catch {}
  if (cached === currentHash) {
    console.log(`[tsc-cache] ${basename(configArg)}: cached (${currentHash}) — skipping tsc`)
    process.exit(0)
  }
}

const args = ['--noEmit', '-p', configPath, ...rest]
console.log(`[tsc-cache] ${basename(configArg)}: running tsc ${args.join(' ')}`)
const result = spawnSync(
  process.execPath,
  ['./node_modules/typescript/bin/tsc', ...args],
  { stdio: 'inherit' },
)
if (result.status === 0) {
  if (!existsSync(join(ROOT, 'dist'))) {
    require('node:fs').mkdirSync(join(ROOT, 'dist'), { recursive: true })
  }
  writeFileSync(stampPath, `${currentHash}\n`)
}
process.exit(result.status ?? 1)
