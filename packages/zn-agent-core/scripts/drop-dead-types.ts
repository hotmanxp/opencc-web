/**
 * Delete dead `type` aliases and `interface` declarations from the stubbed
 * component tree.
 *
 * Scope is deliberately narrow: ONLY type aliases and interfaces that
 *   - are not exported
 *   - have zero identifier references inside their own file
 *   - are not mentioned by name in any other src/ file
 *
 * Constants, functions, and classes are intentionally left alone: even though
 * they are equally dead at runtime, they record what the original component
 * did, which is worth keeping for anyone restoring it or reading upstream.
 * Types carry no such information once the component body is `return null` —
 * they only exist to type props nothing passes anymore.
 *
 * Leading JSDoc / comments attached to the declaration are removed with it.
 *
 * Usage: tsx scripts/drop-dead-types.ts [--dry-run] --list=<file>
 */
import * as ts from 'typescript'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/', import.meta.url).pathname.replace(/\/scripts\/src\/$/, '/src/')
if (!existsSync(join(ROOT, 'opencc-src'))) {
  console.error(`FATAL: ROOT misresolved to ${ROOT}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const listArg = argv.find(a => a.startsWith('--list='))
if (!listArg) {
  console.error('usage: tsx scripts/drop-dead-types.ts [--dry-run] --list=<file>')
  process.exit(1)
}
const targets = readFileSync(listArg.slice('--list='.length), 'utf8').split('\n').filter(Boolean)
  .map(r => join(ROOT, r.replace(/^src\//, '')))
  .filter(p => existsSync(p))
if (!targets.length) {
  console.error(`FATAL: 0 targets resolved (ROOT=${ROOT})`)
  process.exit(1)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) walk(f, out)
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(f)
  }
  return out
}
const allSrc = walk(ROOT)

/** name -> files (excluding `self`) whose TEXT mentions the name */
const external = new Map<string, Set<string>>()
for (const f of allSrc) {
  const seen = new Set<string>()
  for (const m of readFileSync(f, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g)) seen.add(m[0])
  for (const n of seen) {
    if (!external.has(n)) external.set(n, new Set())
    external.get(n)!.add(f)
  }
}

interface Edit { start: number; end: number; text: string }
let totalTypes = 0, touched = 0, totalBytes = 0
const report: string[] = []

for (const abs of targets) {
  const src = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const rel = abs.replace(ROOT, '')

  const counts = new Map<string, number>()
  const walkAll = (n: ts.Node) => {
    if (ts.isIdentifier(n)) counts.set(n.text, (counts.get(n.text) ?? 0) + 1)
    ts.forEachChild(n, walkAll)
  }
  walkAll(sf)

  const edits: Edit[] = []
  for (const stmt of sf.statements) {
    const isType = ts.isTypeAliasDeclaration(stmt)
    const isIface = ts.isInterfaceDeclaration(stmt)
    if (!isType && !isIface) continue
    if (stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue

    const name = stmt.name.text
    if ((counts.get(name) ?? 0) > 1) continue
    const others = external.get(name)
    if (others && [...others].some(o => o !== abs)) continue

    // Pull in any leading JSDoc / line comments directly attached above.
    const full = sf.getFullStart()
    const start = stmt.getStart(sf)
    const leading = src.slice(full, start)
    const docMatch = leading.match(/(?:^|\n)([ \t]*(?:\/\*\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))+)[ \t]*$/)
    const realStart = docMatch ? full + docMatch.index! + (docMatch[0].startsWith('\n') ? 1 : 0) : start

    let end = stmt.getEnd()
    // swallow the trailing newline so we don't leave a blank line
    if (src[end] === '\r') end++
    if (src[end] === '\n') end++

    edits.push({ start: realStart, end, text: '' })
    totalTypes++
  }

  if (!edits.length) continue
  edits.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  if (out === src) continue

  touched++
  totalBytes += src.length - out.length
  report.push(`  ${DRY ? 'would-drop' : 'drop'}  ${rel}  (${edits.length})`)
  if (!DRY) writeFileSync(abs, out, 'utf8')
}

console.log(report.join('\n'))
console.log(
  `\n${DRY ? '[DRY-RUN] ' : ''}files: ${targets.length} | touched: ${touched} | ` +
  `types removed: ${totalTypes} | bytes: ${totalBytes.toLocaleString()}`,
)
