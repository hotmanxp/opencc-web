// src/tools/WorkflowTool/parseMetaFromScript.ts
import { parse, type Node } from 'acorn'

/**
 * Parsed meta shape (matches upstream claude-code2.1.170's `Cq3` output).
 * `phases` is `undefined` if not declared, otherwise the validated array.
 */
export type ParsedWorkflowMeta = {
 name: string
 description: string
 title?: string
 whenToUse?: string
 phases?: Array<{ title: string; detail?: string; model?: string }>
}

export type ParseSuccess = {
 ok: true
 value: { meta: ParsedWorkflowMeta; scriptBody: string }
}
export type ParseFailure = { ok: false; error: string }
export type ParseResult = ParseSuccess | ParseFailure

const SCRIPT_BYTE_LIMIT =52_428_800 // 50 MB; matches upstream's _I

// Reject any of these AST node types inside the meta value — matches
// upstream's strict literal-only policy. (FunctionExpression,
// ArrowFunctionExpression, NewExpression, etc. are NOT in this set
// because the value-side check via `j2K` already throws "non-literal
// node type" on them; this set is a fast pre-filter.)
const REJECTED_NODE_TYPES = new Set<string>([
 'FunctionExpression',
 'ArrowFunctionExpression',
 'ClassExpression',
 'NewExpression',
 'TaggedTemplateExpression',
 'ImportExpression',
])

/**
 * Parse a workflow script and extract its `export const meta = {...}`
 * declaration + remaining script body. Mirrors upstream's `OG()`
 * function (binary-verified) but using acorn directly rather than
 * the inlined bundled copy.
 *
 * Rules (from upstream `Eq3`/`f2K`/`j2K`/`Sq3`/`Cq3`):
 * 1. First top-level statement MUST be `export const meta = {...}`.
 * 2. Meta value MUST be a pure object literal — no computed keys,
 * no spread, no template interpolation, no functions, no `__proto__`/
 * `constructor`/`prototype` keys.
 * 3. `name` and `description` are required non-empty strings.
 * 4. Script body = everything after the meta declaration, with
 * leading `;`/whitespace/newlines stripped.
 *
 * Returns `{ok: true, value: {meta, scriptBody}}` or
 * `{ok: false, error: string}`. Never throws.
 */
export function parseMetaFromScript(source: string): ParseResult {
 if (source.length > SCRIPT_BYTE_LIMIT) {
 return { ok: false, error: `Script exceeds ${SCRIPT_BYTE_LIMIT} bytes` }
 }

 //1. Parse with acorn (module sourceType for `export` keyword).
 let ast: Node
 try {
 ast = parse(source, {
 ecmaVersion: 'latest',
 sourceType: 'module',
 allowAwaitOutsideFunction: true,
 allowReturnOutsideFunction: true,
 })
 } catch (e) {
 return {
 ok: false,
 error: `Script parse error: ${e instanceof Error ? e.message : String(e)}. Workflow scripts must be plain JavaScript \u2014 TypeScript syntax (type annotations like \`: string[]\`, interfaces, generics) fails to parse.`,
 }
 }

 //2. Find the first `export const meta = {...}` declaration. Helper
 // `const`/`function` statements are allowed before it (the upstream
 // binary's parser is more permissive than "first statement" implies —
 // it scans for the first matching export).
 const program = ast as unknown as { type: 'Program'; body: Node[] }
 const first = program.body.find(
 n => n.type === 'ExportNamedDeclaration' && isExportConstMeta(n),
 )
 if (!first) {
 return {
 ok: false,
 error: '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
 }
 }

 //3. Convert ObjectExpression → plain JS object.
 const metaNode = (first as unknown as {
 declaration: { declarations: Array<{ init: Node }> }
 }).declaration.declarations[0]?.init

 let rawMeta: Record<string, unknown>
 try {
 rawMeta = extractObjectExpression(metaNode)
 } catch (e) {
 return {
 ok: false,
 error: `meta must be a pure literal: ${e instanceof Error ? e.message : String(e)}`,
 }
 }

 //4. Validate + normalize.
 const validated = validateMeta(rawMeta)
 if ('error' in validated) return { ok: false, error: validated.error }

 //5. Extract script body.
 const scriptBody = source
 .slice((first as unknown as { end: number }).end)
 .replace(/^[;\s]*\n/, '')
 .trimStart()

 return { ok: true, value: { meta: validated, scriptBody } }
}

// --- helpers ---

function isExportConstMeta(node: Node): boolean {
 // node is ExportNamedDeclaration
 const decl = (node as unknown as { declaration?: Node }).declaration
 if (!decl || decl.type !== 'VariableDeclaration') return false
 const varDecl = decl as unknown as {
 kind: string
 declarations: Array<{ id: Node; init: Node | null }>
 }
 if (varDecl.kind !== 'const' || varDecl.declarations.length !==1) return false
 const id = varDecl.declarations[0]?.id
 const init = varDecl.declarations[0]?.init
 if (!id || id.type !== 'Identifier' || (id as unknown as { name: string }).name !== 'meta') return false
 if (!init || init.type !== 'ObjectExpression') return false
 return true
}

function extractObjectExpression(node: Node | null | undefined): Record<string, unknown> {
 if (!node || node.type !== 'ObjectExpression') {
 throw new Error('expected ObjectExpression')
 }
 const out: Record<string, unknown> = Object.create(null)
 const props = (node as unknown as { properties: Node[] }).properties
 for (const prop of props) {
 if (prop.type === 'SpreadElement') {
 throw new Error('spread not allowed in meta')
 }
 if (prop.type !== 'Property') {
 throw new Error('only plain properties allowed in meta')
 }
 const p = prop as unknown as {
 key: Node
 value: Node
 computed: boolean
 method: boolean
 kind: string
 shorthand: boolean
 }
 if (p.computed) throw new Error('computed keys not allowed in meta')
 if (p.method || p.kind !== 'init') throw new Error('methods/accessors not allowed in meta')
 const key = extractKey(p.key)
 if (['__proto__', 'constructor', 'prototype'].includes(key)) {
 throw new Error(`reserved key name not allowed in meta: ${key}`)
 }
 out[key] = extractValue(p.value)
 }
 return out
}

function extractKey(node: Node): string {
 if (node.type === 'Identifier') return (node as unknown as { name: string }).name
 if (node.type === 'Literal') return String((node as unknown as { value: unknown }).value)
 throw new Error(`unsupported key type in meta: ${node.type}`)
}

function extractValue(node: Node): unknown {
 if (REJECTED_NODE_TYPES.has(node.type)) {
 throw new Error(`non-literal node type in meta: ${node.type}`)
 }
 switch (node.type) {
 case 'Literal':
 return (node as unknown as { value: unknown }).value
 case 'ArrayExpression': {
 const elements = (node as unknown as { elements: Array<Node | null> }).elements
 return elements.map(el => {
 if (el === null) throw new Error('sparse arrays not allowed')
 if (el.type === 'SpreadElement') throw new Error('spread not allowed in meta')
 return extractValue(el)
 })
 }
 case 'ObjectExpression':
 return extractObjectExpression(node)
 case 'TemplateLiteral': {
 const t = node as unknown as {
 expressions: Node[]
 quasis: Array<{ value: { cooked: string | null } }>
 }
 if (t.expressions.length >0) throw new Error('template interpolation not allowed in meta')
 return t.quasis.map(q => q.value.cooked ?? '').join('')
 }
 case 'UnaryExpression': {
 const u = node as unknown as { operator: string; argument: Node }
 if (u.operator === '-' && u.argument.type === 'Literal' && typeof (u.argument as unknown as { value: unknown }).value === 'number') {
 return -(u.argument as unknown as { value: number }).value
 }
 throw new Error('only negative-number unary allowed in meta')
 }
 default:
 throw new Error(`non-literal node type in meta: ${node.type}`)
 }
}

function validateMeta(raw: Record<string, unknown>): ParsedWorkflowMeta | { error: string } {
 if (typeof raw.name !== 'string' || raw.name.length ===0) {
 return { error: 'meta.name must be a non-empty string' }
 }
 if (typeof raw.description !== 'string' || raw.description.length ===0) {
 return { error: 'meta.description must be a non-empty string' }
 }
 const title = typeof raw.title === 'string' && raw.title.length >0 ? raw.title : undefined
 const whenToUse = typeof raw.whenToUse === 'string' ? raw.whenToUse : undefined
 const phasesResult = validatePhases(raw.phases)
 if (phasesResult && 'error' in phasesResult) return phasesResult
 // Preserve all valid-literal fields (e.g. `maxRetries: -1`); upstream
 // does not white-list — it accepts any literal-typed key.
 return { ...raw, name: raw.name, description: raw.description, title, whenToUse, phases: phasesResult } as ParsedWorkflowMeta
}

function validatePhases(raw: unknown): ParsedWorkflowMeta['phases'] | { error: string } {
 if (raw === undefined) return undefined
 if (!Array.isArray(raw)) return undefined
 const out: NonNullable<ParsedWorkflowMeta['phases']> = []
 for (const item of raw) {
 if (!item || typeof item !== 'object' || !('title' in item)) continue
 const obj = item as { title: unknown; detail?: unknown; model?: unknown }
 if (typeof obj.title !== 'string') continue
 out.push({
 title: obj.title,
 detail: typeof obj.detail === 'string' ? obj.detail : undefined,
 model: typeof obj.model === 'string' ? obj.model : undefined,
 })
 }
 return out.length >0 ? out : undefined
}
