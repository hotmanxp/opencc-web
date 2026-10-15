/**
 * Audit — report (do NOT mutate) dead declarations in the stubbed component tree.
 *
 * The naive version (count identifier occurrences inside the file) produces a
 * flood of FALSE POSITIVES:
 *   - Tool.ts `buildTool`: exported from bundle-entry.ts for external agents
 *   - `export const call` in the command modules: consumed via
 *     `load: () => import('./config.js')` dynamic import, never textually named
 *   - `export function X`: imported by other vendor modules
 *
 * So this version applies three filters:
 *   1. skip anything `export`ed  (exports are the module's public surface)
 *   2. skip anything referenced from ANOTHER file in src/ (cross-file usage)
 *   3. only flag non-exported, file-local declarations with zero references
 *
 * Output is advisory. Deleting is a separate deliberate step.
 */
import * as ts from 'typescript'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/', import.meta.url).pathname.replace(/\/scripts\/src\/$/, '/src/')
if (!existsSync(join(ROOT, 'opencc-src'))) {
  console.error(`FATAL: ROOT misresolved to ${ROOT}`)
  process.exit(1)
}
const listFile = process.argv[2]
if (!listFile) {
  console.error('usage: tsx scan-dead-code.ts <listfile>')
  process.exit(1)
}
// list entries look like `src/opencc-src/commands/x.tsx`; ROOT already ends
// in `/src/`, so strip that prefix before joining (or we'd get src/src/...).
const targets = readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
  .map(r => join(ROOT, r.replace(/^src\//, '')))
  .filter(p => existsSync(p))
if (!targets.length) {
  console.error(`FATAL: 0 targets resolved from ${listFile} (ROOT=${ROOT})`)
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

console.log(`scanning ${allSrc.length} source files for cross-file references...`)
/** name -> number of files (outside `self`) that mention it */
const externalRefs = new Map<string, Set<string>>()
for (const f of allSrc) {
  const text = readFileSync(f, 'utf8')
  const seen = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) seen.add(m[0])
  for (const name of seen) {
    if (!externalRefs.has(name)) externalRefs.set(name, new Set())
    externalRefs.get(name)!.add(f)
  }
}

interface Finding { file: string; line: number; kind: string; name: string }
const findings: Finding[] = []

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

  const isExported = (stmt: ts.Statement): boolean =>
    !!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)

  const check = (stmt: ts.Statement, name: string, kind: string, node: ts.Node) => {
    if (isExported(stmt)) return
    if ((counts.get(name) ?? 0) > 1) return
    const others = externalRefs.get(name)
    if (others && [...others].some(o => o !== abs)) return
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    findings.push({ file: rel, line: line + 1, kind, name })
  }

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) check(stmt, d.name.text, 'local-const', d)
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      check(stmt, stmt.name.text, 'local-fn', stmt)
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      check(stmt, stmt.name.text, 'type', stmt)
    } else if (ts.isInterfaceDeclaration(stmt)) {
      check(stmt, stmt.name.text, 'interface', stmt)
    } else if (ts.isEnumDeclaration(stmt)) {
      check(stmt, stmt.name.text, 'enum', stmt)
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      check(stmt, stmt.name.text, 'class', stmt)
    }
  }
}

const byKind = new Map<string, Finding[]>()
for (const f of findings) {
  if (!byKind.has(f.kind)) byKind.set(f.kind, [])
  byKind.get(f.kind)!.push(f)
}

console.log(`\n=== dead-code audit (exported + cross-file refs excluded) ===\n`)
for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`[${kind}] ${list.length}`)
  for (const f of list.slice(0, 15)) console.log(`   ${f.file}:${f.line}  ${f.name}`)
  if (list.length > 15) console.log(`   ... +${list.length - 15} more`)
  console.log()
}
console.log(`TOTAL (high-confidence dead declarations): ${findings.length}`)
