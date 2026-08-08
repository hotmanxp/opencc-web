import { existsSync, readFileSync } from 'node:fs'
import { sealForVmBoundary, isVmBoundaryError } from './vmSealer.js'
import { createWorkflowVmContext, runWorkflowScript, type WorkflowApi } from './vmContext.js'
import { stripStringsAndComments } from '../staticAnalyzer.js'
import { parseMetaFromScript, type ParsedWorkflowMeta } from '../parseMetaFromScript.js'
import { assertResumeSafe } from '../resumeSafety.js'

export type VmRunnerOpts = {
  /** File path to a workflow script, OR inline source code. */
  script: string
  args: unknown
  api: WorkflowApi
  timeoutMs?: number
}

export type VmRunnerResult = {
  report: string
  events: Array<{ kind: string; payload: unknown }>
  budgetSpent: number
  meta?: ParsedWorkflowMeta
}

/**
 * Pull the body of `async function userScript(...) { ... }` out of
 * the source. Returns the raw `{...}` contents (no braces) or null
 * if the wrapper is missing. We balance braces on the *stripped*
 * source so a `{` inside a string literal can't mislead the parser
 * — `stripStringsAndComments` already neutralises strings/regex/
 * comments while preserving length, so the slice back to the
 * original source is a simple offset.
 */
function extractUserScriptBody(source: string): string | null {
  const stripped = stripStringsAndComments(source)
  const idx = stripped.search(/\bfunction\s+userScript\b/)
  if (idx < 0) return null
  const open = stripped.indexOf('{', idx)
  if (open < 0) return null
  let depth = 1
  let i = open + 1
  while (i < stripped.length && depth > 0) {
    const c = stripped[i]!
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) {
      return source.slice(open + 1, i)
    }
    i++
  }
  return null
}

/**
 * Strip ESM `export` keywords from a workflow source so it parses as
 * a plain script inside the VM. This is the regression fix for Plan6
 * Task2: Plan5's VM migration (commit 57887ab7) dropped the legacy
 * workerScript.ts stripper, so the 4 of 6 user workflows in
 * `.zai/workflows/` that start with `export const meta = {...}`
 * crashed with `SyntaxError: Unexpected token 'export'`.
 *
 * Mirrors the chain in `workerScript.ts` lines 41-45:
 *   - `export default async function` → `async function`
 *   - `export default function`        → `function`
 *   - `export default `                → ``
 *   - `export const `                  → `const `
 *   - `export (let|var) `              → `$1 `
 *
 * Before applying the general strip, we special-case
 * `export const meta = <obj>`: the `meta` binding becomes a
 * function-local variable inside the wrapped `userScript()` —
 * invisible to the parent. To keep the `__setMeta(meta)` channel
 * working, we hoist a capture call onto the declaration line so the
 * parent's WorkflowDetailDialog can render the declared phases.
 *
 * We use `stripStringsAndComments` to find safe boundaries (so a
 * brace inside a string literal can't mislead the parser), but
 * replacements always happen on the *original* source so string
 * contents are preserved verbatim.
 */
export function stripEsmExports(source: string): string {
  // Meta special case: locate `export const meta = <obj>` on the
  // *stripped* source so strings/comments can't trick the regex,
  // then slice back to the *original* source by offset (length
  // is preserved by `stripStringsAndComments`).
  const stripped = stripStringsAndComments(source)
  const metaRe = /export\s+const\s+meta\s*=/g
  let result = source
  let m: RegExpExecArray | null
  // Walk matches in reverse so splicing earlier matches doesn't
  // invalidate later offsets. We only handle the first hit — the
  // project style is one `meta` declaration per workflow.
  const metaMatches: Array<{ start: number; afterEquals: number }> = []
  while ((m = metaRe.exec(stripped))) {
    const start = m.index
    const afterEquals = metaRe.lastIndex
    metaMatches.push({ start, afterEquals })
  }
  for (let k = metaMatches.length - 1; k >= 0; k--) {
    const { start, afterEquals } = metaMatches[k]!
    // Balance braces from `afterEquals` to find the closing `}` of
    // the object literal. We work on the stripped buffer so strings/
    // regex/comments can't mislead the depth count.
    let i = afterEquals
    // Skip whitespace to find the opening `{`.
    while (i < stripped.length && /\s/.test(stripped[i]!)) i++
    if (stripped[i] !== '{') continue
    const open = i
    let depth = 1
    i = open + 1
    let close = -1
    while (i < stripped.length && depth > 0) {
      const c = stripped[i]!
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
      i++
    }
    if (close < 0) continue
    // Slice the original source: `export const meta = <obj>` plus
    // a trailing `;` if present. The injected `__setMeta(meta);`
    // call must be a separate statement — without a separator the
    // parser would see `const meta = {...} __setMeta(meta);` and
    // choke on the missing `;` after the variable declaration
    // (V8 reports `Unexpected identifier '__setMeta'` here). When
    // the source omits the semicolon (the fixture does), we add a
    // newline separator; ASI would handle it, but a hard newline
    // is unambiguous and matches the rest of the file's style.
    const hasSemicolon = source[close + 1] === ';'
    const endIdx = hasSemicolon ? close + 2 : close + 1
    const originalDecl = result.slice(start, endIdx)
    const sep = hasSemicolon ? ' ' : '\n'
    const replaced = `${originalDecl}${sep}__setMeta(meta);`
    result = result.slice(0, start) + replaced + result.slice(endIdx)
  }

  // General export-strip chain. Apply on the (possibly meta-mutated)
  // result, in the same order as workerScript.ts so the
  // `export default async function` arm is tried before the broader
  // `export default ` arm.
  return result
    .replace(/export\s+default\s+async\s+function/g, 'async function')
    .replace(/export\s+default\s+function/g, 'function')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+(let|var)\s+/g, '$1 ')
}

/**
 * Run a workflow script in a Node `vm` context. Replaces the
 * worker_threads path with a faster, tighter sandbox.
 *
 * Lifecycle:
 * 1. Resolve script source: if `opts.script` is a path that exists
 *    on disk, read it; otherwise treat the string as inline source.
 *    The `existsSync` check is preferred over a content heuristic
 *    because a file path is always distinguishable from a script
 *    that happens to be one long line — a script with no newlines
 *    is still legal.
 * 2. Re-shape the source so the runtime contract is uniform: if the
 *    source declares `async function userScript(args) { ... }`, pull
 *    out the body and re-emit it inside a fresh wrapper that is
 *    invoked with `args`. This matches the contract that
 *    `workerScript.ts` and `staticAnalyzer.ts` already expect, so
 *    existing workflow scripts run unchanged. If no `userScript` is
 *    declared, the source is run verbatim.
 * 3. Build a VM context that wraps the script API and captures
 *    `log()` / `phase()` calls into the returned `events` array
 *    while still forwarding them to the host.
 * 4. Run the script with `runWorkflowScript` (codeGeneration:false,
 *    timeout-bounded).
 * 5. Seal the result across the VM boundary (drop functions, cap
 *    array lengths, strip prototype pollution keys).
 * 6. Return {report, events, budgetSpent}. Non-string reports are
 *    JSON-stringified.
 */
export async function runWorkflowInVm(opts: VmRunnerOpts): Promise<VmRunnerResult> {
  const source = existsSync(opts.script) ? readFileSync(opts.script, 'utf-8') : opts.script

  // Plan14 Task 1: reject Date.now() / new Date() / Math.random() at the
  // source level so the user gets the upstream error string verbatim.
  // (import() is caught separately via vm.runInContext's
  // importModuleDynamically, see vmContext.ts.) Breaks resume because
  // these globals make workflow output non-deterministic across replays.
  assertResumeSafe(source)

  // Plan7 Task3: parse the script's `export const meta = {...}` declaration
  // up front so we can return a structured meta alongside the report.
  // The parser is strict (mirrors upstream's `OG()`): TS syntax, computed
  // keys, spread, template interpolation, reserved keys (`__proto__` etc.),
  // and missing/empty `name` or `description` are hard errors → refuse
  // to run. Missing meta declaration falls through: legacy scripts may
  // call `__setMeta()` at runtime, captured by the VM API below.
  let parsedMeta: ParsedWorkflowMeta | undefined
  const parseResult = parseMetaFromScript(source)
  if (parseResult.ok) {
    parsedMeta = parseResult.value.meta
  } else if (!/FIRST statement/.test(parseResult.error)) {
    // Hard error: TS type annotations, computed/spread/template,
    // reserved keys, missing name, etc.
    throw new Error(`Invalid workflow script: ${parseResult.error}`)
  }

  const events: Array<{ kind: string; payload: unknown }> = []

  const ctx = createWorkflowVmContext({
    ...opts.api,
    log: (...msgs: unknown[]) => {
      events.push({ kind: 'log', payload: msgs.map(m => String(m)).join(' ') })
      opts.api.log(...msgs)
    },
    phase: (title: string) => {
      events.push({ kind: 'phase', payload: title })
      opts.api.phase(title)
    },
    __setMeta: (meta: unknown) => {
      // Mirror the legacy workerScript.ts wire shape: parent
      // receives `{ kind: 'meta', payload: meta }` (the test
      // asserts on this event, and WorkflowDetailDialog listens
      // for the same kind upstream).
      events.push({ kind: 'meta', payload: meta })
      // Forward to the host so a log sink can surface the
      // declared metadata even if the consumer doesn't iterate
      // the events array.
      try {
        opts.api.log('[meta]', meta as unknown)
      } catch {
        // Never let a logging failure mask the script's own
        // errors — events are already captured above.
      }
      // Plan6 Task 2: also forward to the host's __setMeta so it
      // can persist the payload to its own state. The pre-Plan6
      // runner only logged the metadata, which meant a script
      // calling `__setMeta({phases: [...]})` at the top never
      // reached the LocalWorkflowTask state.meta slot. Host is
      // optional (callers that only care about the events array
      // can omit it), matching the agent/parallel/pipeline
      // forwarding pattern a few lines above.
      try {
        opts.api.__setMeta?.(meta)
      } catch {
        // best-effort; never let a host forwarding failure
        // mask the script's own errors
      }
    },
  })

  // Plan6 Task2: strip ESM `export` keywords before the body
  // extractor runs. `export const meta = {...}` becomes
  // `const meta = {...} __setMeta(meta);` so the parent's meta
  // channel keeps working. Strip must run on the raw source —
  // `extractUserScriptBody` and `runWorkflowScript` expect
  // script-flavor code.
  const cleanedSource = stripEsmExports(source)

  const body = extractUserScriptBody(cleanedSource)
  const wrappedSource = body !== null
    ? `async function userScript(args) { 'use strict';\n${body}\n}\nreturn await userScript(args);`
    : cleanedSource

  try {
    const raw = await runWorkflowScript(wrappedSource, ctx, { timeout: opts.timeoutMs ?? 30000 })
    const sealed = sealForVmBoundary(raw) as unknown
    const report = typeof sealed === 'string'
      ? sealed
      : sealed === null || sealed === undefined
        ? ''
        : JSON.stringify(sealed, null, 2)
    return { report, events, budgetSpent: opts.api.budget.spent(), meta: parsedMeta }
  } catch (e) {
    if (isVmBoundaryError(e)) {
      throw new Error(`VM boundary violation: ${e instanceof Error ? e.message : String(e)}`)
    }
    throw e
  }
}
