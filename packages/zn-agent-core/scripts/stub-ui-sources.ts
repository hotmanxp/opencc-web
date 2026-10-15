/**
 * One-shot source transformer: replace React component bodies with a stub.
 *
 * Two strategies, same detection rules:
 *
 *   --splice (default)
 *     Rewrite ONLY the character range of each component's body, leaving the
 *     rest of the file byte-identical. The AST printer reformats imports and
 *     expands blocks, which made ~10% of files GROW; splicing can't. This is
 *     the mode to use for the big component/ink tree.
 *
 *   --print (legacy, kept for reproducing earlier results)
 *     Full TS-printer re-emit. Kept only so the earlier measurement is
 *     reproducible; it inflates some files and those are skipped.
 *
 * Detection mirrors the build-time `commandImplStubPlugin`
 * (scripts/bundle-opencc.ts `isComponentFunction`), extended to the
 * arrow / memo() / forwardRef() forms the build-time rule misses.
 *
 * Return contracts preserved (both learned from real tsc failures):
 *   - `LocalJSXCommandCall` returns Promise<ReactNode>; a non-async `call`
 *     whose original body returned `Promise.resolve(<JSX/>)` must stub to
 *     `return Promise.resolve(null)`, not `return null`.
 *   - A declared return type that excludes null (`React.ReactElement`,
 *     `JSX.Element`) gets widened with `| null` — but ONLY for non-async
 *     functions. Widening an async one breaks `Promise<ReactNode>`.
 */
import * as ts from 'typescript'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const VENDOR = join(PKG, 'src', 'opencc-src')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const SPLICE = !argv.includes('--print')
const targets = argv.filter(a => !a.startsWith('--'))

const DEFAULT_DIRS = [
  join(VENDOR, 'commands'),
  join(VENDOR, 'components'),
  join(VENDOR, 'ink'),
]

// ── JSX detection ───────────────────────────────────────────────────────────
function bodyHasJsx(body: ts.Node | undefined): boolean {
  if (!body) return false
  let found = false
  const walk = (n: ts.Node) => {
    if (found) return
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true
      return
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'createElement'
    ) {
      found = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(body)
  return found
}

type FnLike = ts.ArrowFunction | ts.FunctionExpression

function returnsPromise(fn: FnLike | ts.FunctionDeclaration): boolean {
  if (fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return true
  const body = fn.body
  if (!body || !ts.isBlock(body)) return false
  for (const st of body.statements) {
    if (!ts.isReturnStatement(st) || !st.expression) continue
    const e = st.expression
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ts.isIdentifier(e.expression.expression) &&
      e.expression.expression.text === 'Promise'
    ) return true
  }
  return false
}

/**
 * Splice-friendly stub body text. No block braces here — the caller splices
 * between the original `{` and `}` so indentation stays whatever the file had.
 */
function stubReturn(promise: boolean): string {
  return promise ? 'return Promise.resolve(null);' : 'return null;'
}

// ── splice mode ─────────────────────────────────────────────────────────────
interface Edit { start: number; end: number; text: string }

function collectSpliceEdits(sf: ts.SourceFile): Edit[] {
  const edits: Edit[] = []

  /** Widen a non-null-returning annotation to `T | null`. */
  const widenType = (fn: FnLike | ts.FunctionDeclaration, promise: boolean): Edit | null => {
    if (promise) return null
    const t = fn.type
    if (!t) return null
    const text = t.getText(sf)
    if (/\bnull\b/.test(text)) return null
    if (
      t.kind === ts.SyntaxKind.UnionType &&
      (t as ts.UnionTypeNode).types.some(
        m => m.kind === ts.SyntaxKind.UndefinedKeyword || m.kind === ts.SyntaxKind.VoidKeyword,
      )
    ) return null
    return { start: t.getEnd(), end: t.getEnd(), text: ' | null' }
  }

  /** Replace the body. Handles both block bodies and JSX expression bodies. */
  const stubBody = (fn: FnLike | ts.FunctionDeclaration, promise: boolean): Edit[] => {
    const out: Edit[] = []
    const typeEdit = widenType(fn, promise)
    if (typeEdit) out.push(typeEdit)
    const body = fn.body
    if (!body) return out
    if (ts.isBlock(body)) {
      // replace inner statements only, keep original `{` `}`
      const inner = body.statements
      if (!inner.length) return out
      out.push({
        start: inner[0].getStart(sf),
        end: inner[inner.length - 1].getEnd(),
        text: stubReturn(promise),
      })
    } else {
      // concise body: `() => <Foo/>` -> `() => { return null; }`
      out.push({
        start: body.getStart(sf),
        end: body.getEnd(),
        text: `{ ${stubReturn(promise)} }`,
      })
    }
    return out
  }

  const visit = (node: ts.Node) => {
    // `export function Foo(...) {...jsx... }`
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (/^[A-Z]/.test(node.name.text) && bodyHasJsx(node.body)) {
        edits.push(...stubBody(node as ts.FunctionDeclaration, returnsPromise(node)))
        return // don't descend — the whole body is going away
      }
    }
    // `const X = () => <jsx/>` / `const X = memo(...)` / `export const call = ...`
    if (ts.isVariableStatement(node)) {
      let touched = false
      const hits: { fn: FnLike }[] = []
      for (const d of node.declarationList.declarations) {
        const init = d.initializer
        if (!init) continue
        if (
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          bodyHasJsx(init.body)
        ) {
          hits.push({ fn: init })
          touched = true
        } else if (ts.isCallExpression(init)) {
          const a = init.arguments[0]
          if (
            a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
            bodyHasJsx(a.body)
          ) {
            hits.push({ fn: a })
            touched = true
          }
        }
      }
      if (touched) {
        for (const h of hits) edits.push(...stubBody(h.fn, returnsPromise(h.fn)))
        return
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
  return edits
}

function applySplices(text: string, edits: Edit[]): string {
  // apply right-to-left so earlier offsets stay valid
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
  }
  return out
}

// ── print mode (legacy) ─────────────────────────────────────────────────────
function stubBlock(promise: boolean): ts.Block {
  const ret = promise
    ? ts.factory.createReturnStatement(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier('Promise'), 'resolve',
          ),
          undefined,
          [ts.factory.createNull()],
        ),
      )
    : ts.factory.createReturnStatement(ts.factory.createNull())
  return ts.factory.createBlock([ret], true)
}

function nullableReturnType(t: ts.TypeNode | undefined, isAsync: boolean): ts.TypeNode | undefined {
  if (!t) return t
  const text = t.getText?.() ?? ''
  if (/\bnull\b/.test(text)) return t
  if (t.kind === ts.SyntaxKind.UnionType) {
    const u = t as ts.UnionTypeNode
    if (u.types.some(m => m.kind === ts.SyntaxKind.UndefinedKeyword || m.kind === ts.SyntaxKind.VoidKeyword)) {
      return t
    }
  }
  if (isAsync) return t
  return ts.factory.createUnionTypeNode([t, ts.factory.createLiteralTypeNode(ts.factory.createNull())])
}

function arrowToken(): ts.EqualsGreaterThanToken {
  return ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken)
}

function stubFnLike(init: FnLike): FnLike {
  const p = returnsPromise(init)
  const block = stubBlock(p)
  if (ts.isArrowFunction(init)) {
    return ts.factory.updateArrowFunction(
      init, init.modifiers, init.typeParameters, init.parameters,
      nullableReturnType(init.type, p), arrowToken(), block,
    )
  }
  return ts.factory.updateFunctionExpression(
    init, init.modifiers, init.asteriskToken, init.name, init.typeParameters,
    init.parameters, nullableReturnType(init.type, p), block,
  )
}

function transformPrint(contents: string, filePath: string): string {
  const sf = ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, true)
  const tr: ts.TransformerFactory<ts.SourceFile> = (ctx) => (root) => {
    const fnStub = (node: ts.Node): ts.Node => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body &&
          /^[A-Z]/.test(node.name.text) && bodyHasJsx(node.body)) {
        const fn = node as ts.FunctionDeclaration
        const p = returnsPromise(fn)
        return ts.factory.updateFunctionDeclaration(
          fn, fn.modifiers, fn.asteriskToken, fn.name, fn.typeParameters,
          fn.parameters, nullableReturnType(fn.type, p), stubBlock(p),
        )
      }
      if (ts.isVariableStatement(node)) {
        let touched = false
        const decls = node.declarationList.declarations.map(d => {
          const init = d.initializer
          if (!init) return d
          if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && bodyHasJsx(init.body)) {
            touched = true
            return ts.factory.updateVariableDeclaration(d, d.name, d.exclamationToken, d.type, stubFnLike(init))
          }
          if (ts.isCallExpression(init)) {
            const a = init.arguments[0]
            if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && bodyHasJsx(a.body)) {
              touched = true
              return ts.factory.updateVariableDeclaration(
                d, d.name, d.exclamationToken, d.type,
                ts.factory.updateCallExpression(init, init.expression, init.typeArguments, [stubFnLike(a)], init.typeArguments),
              )
            }
          }
          return d
        })
        if (touched) {
          const vs = node as ts.VariableStatement
          return ts.factory.updateVariableStatement(
            vs, vs.modifiers,
            ts.factory.updateVariableDeclarationList(vs.declarationList, decls),
          )
        }
      }
      return ts.visitEachChild(node, fnStub, ctx)
    }
    return ts.visitNode(root, fnStub) as ts.SourceFile
  }
  const r = ts.transform(sf, [tr])
  const out = ts.createPrinter().printFile(r.transformed[0] as ts.SourceFile)
  r.dispose()
  return out
}

// ── driver ──────────────────────────────────────────────────────────────────
function collect(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) collect(f, out)
    else if (e.name.endsWith('.tsx')) out.push(f)
  }
  return out
}

const files = targets.length
  ? targets.map(t => (t.startsWith('/') ? t : join(VENDOR, t)))
  : [...new Set(DEFAULT_DIRS.flatMap(d => collect(d)))]

let tb = 0, ta = 0, stubbed = 0, skipped = 0, unchanged = 0, editCount = 0
const report: string[] = []

for (const f of files) {
  if (!existsSync(f)) { report.push(`  MISSING ${f}`); continue }
  const before = readFileSync(f, 'utf8')

  let after: string
  let nEdits = 0
  if (SPLICE) {
    const sf = ts.createSourceFile(f, before, ts.ScriptTarget.Latest, true)
    const edits = collectSpliceEdits(sf)
    nEdits = edits.length
    after = edits.length ? applySplices(before, edits) : before
  } else {
    after = transformPrint(before, f)
    if (after !== before) {
      const sf = ts.createSourceFile(f, after, ts.ScriptTarget.Latest, true)
      nEdits = collectSpliceEdits(
        ts.createSourceFile(f, before, ts.ScriptTarget.Latest, true),
      ).length
    }
  }

  tb += before.length
  ta += after.length
  if (after === before) { unchanged++; continue }
  if (after.length >= before.length) {
    skipped++
    report.push(`  skip(grew) ${basename(f).padEnd(28)} ${before.length} -> ${after.length}`)
    continue
  }
  stubbed++
  editCount += nEdits
  report.push(
    `  ${DRY ? 'would-stub' : 'stub'}  ${basename(f).padEnd(28)} ` +
    `${String(before.length).padStart(7)} -> ${String(after.length).padStart(6)}  ` +
    `(-${((1 - after.length / before.length) * 100).toFixed(0)}%, ${nEdits} edit${nEdits === 1 ? '' : 's'})`,
  )
  if (!DRY) writeFileSync(f, after, 'utf8')
}

console.log(report.join('\n'))
console.log(
  `\n[mode: ${SPLICE ? 'splice' : 'print'}]${DRY ? ' [DRY-RUN]' : ''} ` +
  `files: ${files.length} | stubbed: ${stubbed} | skipped(grew): ${skipped} | ` +
  `unchanged: ${unchanged} | total edits: ${editCount}`,
)
console.log(
  `bytes: ${tb.toLocaleString()} -> ${Math.min(ta, tb).toLocaleString()} ` +
  `(-${((1 - Math.min(ta, tb) / tb) * 100).toFixed(1)}%)`,
)
