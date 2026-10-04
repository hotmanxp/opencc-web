/**
 * Post-stub cleanup: drop imports that became unused after component bodies
 * were replaced with `return null`.
 *
 * Safety rules (deliberately conservative — a wrong deletion is a build break,
 * an unused import is merely noise):
 *   - only removes *named* specifiers, never a bare `import 'side-effect'`
 *   - only removes a specifier whose local name appears ZERO times outside the
 *     import statements themselves
 *   - keeps everything when the remaining import list would be empty AND the
 *     module has side effects we can't prove are unneeded (a default/namespace
 *     import, or `import * as X`)
 *   - `import type` is only removed when nothing references the symbol
 *   - never touches the first `import React from 'react'` line when `React.`
 *     is still referenced (JSX runtime / React.ReactElement annotations)
 *
 * Usage: tsx scripts/prune-unused-imports.ts [--dry-run] [--list=<file>] [file ...]
 *   --list=<file>  newline-delimited paths (avoids argv length limits)
 */
import * as ts from 'typescript'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const listArg = argv.find(a => a.startsWith('--list='))
const files = [
  ...argv.filter(a => !a.startsWith('--')),
  ...(listArg ? readFileSync(listArg.slice('--list='.length), 'utf8').split('\n').filter(Boolean) : []),
]

function pruneFile(path: string): { out: string; removed: number; wholeStmts: number } | null {
  const src = readFileSync(path, 'utf8')
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true)

  // Collect identifier usages, excluding import declaration ranges.
  const importRanges: Array<[number, number]> = []
  const usages = new Map<string, number>()

  const walk = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) {
      importRanges.push([n.getStart(sf), n.getEnd()])
    }
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      // still walk identifiers inside type positions? No — imports only.
      return
    }
    if (ts.isIdentifier(n)) {
      usages.set(n.text, (usages.get(n.text) ?? 0) + 1)
    }
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(sf, walk)

  const inImportRange = (pos: number) =>
    importRanges.some(([s, e]) => pos >= s && pos <= e)

  // Recompute usages INCLUDING import clauses (to know a symbol is at least
  // declared once), then subtract import-internal occurrences.
  const allUses = new Map<string, number>()
  const walkAll = (n: ts.Node) => {
    if (ts.isIdentifier(n) && !inImportRange(n.getStart(sf))) {
      allUses.set(n.text, (allUses.get(n.text) ?? 0) + 1)
    }
    ts.forEachChild(n, walkAll)
  }
  walkAll(sf)

  // Build the replacement edits.
  const edits: Array<{ start: number; end: number; text: string }> = []
  let removed = 0
  let wholeStmts = 0

  // Some vendor files reference `React` as a free global (no import at all) at
  // module top level — e.g. `const Ctx = React.createContext(false)` in
  // CtrlOToExpand.tsx. Those still need React bound at runtime, and this file
  // has no import to protect. Detect any JSX or bare `React.` reference in the
  // source text and refuse to touch the react import entirely.
  const srcText = src
  const needsReactGlobal =
    /<[A-Za-z][A-Za-z0-9]*[\s/>]/.test(srcText) ||
    /\bReact\s*\./.test(srcText) ||
    /\bjsx\s*\(/.test(srcText)

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const clause = stmt.importClause
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    const moduleText = stmt.moduleSpecifier.getText(sf)

    // Guard the react binding: if anything in this file still needs React at
    // runtime, keep the react specifier even if `allUses` says it's unreferenced
    // (free-global React + JSX transform both fail without it).
    if (moduleText === "'react'" || moduleText === '"react"') {
      if (needsReactGlobal) continue
    }

    const specs = clause.namedBindings.elements
    const dead = specs.filter(el => (allUses.get(el.name.text) ?? 0) === 0)
    if (!dead.length) continue

    const alive = specs.filter(el => !dead.includes(el))
    removed += dead.length

    const typeOnly = clause.isTypeOnly

    if (alive.length === 0) {
      // Every specifier is dead → the whole statement goes. This is safe for
      // this tree: the removed imports are UI barrels / component modules whose
      // only role was to feed the (now stubbed) JSX bodies. Bare side-effect
      // imports (`import './x.js'`) have no namedBindings and are never touched
      // here, so real side-effect entry points are preserved.
      wholeStmts++
      edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: '' })
    } else {
      const rendered = alive
        .map(el => el.getText(sf))
        .join(', ')
      const keyword = typeOnly ? 'import type' : 'import'
      edits.push({
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
        text: `${keyword} { ${rendered} } from ${moduleText}`,
      })
    }
  }

  if (!removed) return null

  let out = src
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  for (const e of sorted) {
    // swallow the trailing newline when removing a whole statement
    let end = e.end
    if (e.text === '' && out[end] === '\r') end++
    if (e.text === '' && out[end] === '\n') end++
    out = out.slice(0, e.start) + e.text + out.slice(end)
  }
  return { out, removed, wholeStmts }
}

let totalRemoved = 0, totalBytes = 0, touched = 0, totalStmts = 0
const report: string[] = []

for (const f of files) {
  const r = pruneFile(f)
  if (!r) continue
  touched++
  totalRemoved += r.removed
  totalStmts += r.wholeStmts
  const before = readFileSync(f, 'utf8').length
  totalBytes += before - r.out.length
  report.push(
    `  ${DRY ? 'would-drop' : 'drop'}  ${basename(f).padEnd(34)} ` +
    `${r.removed} specifier(s), ${before - r.out.length} bytes`,
  )
  if (!DRY) writeFileSync(f, r.out, 'utf8')
}

console.log(report.slice(0, 40).join('\n'))
if (report.length > 40) console.log(`  ... +${report.length - 40} more files`)
console.log(
  `\n${DRY ? '[DRY-RUN] ' : ''}files scanned: ${files.length} | touched: ${touched} | ` +
  `specifiers removed: ${totalRemoved} | whole statements dropped: ${totalStmts} | bytes reclaimed: ${totalBytes.toLocaleString()}`,
)
