/**
 * Static analyzer for workflow script source.
 *
 * Walks the script text with regex-based heuristics (no AST) to detect
 * top-level structural patterns the WorkflowDetailDialog renders as
 * phase chips: sequential `agent()`, `parallel([...])` fan-out, and
 * `for`/`while` loops wrapping `agent()`.
 *
 * The analyzer is intentionally conservative — false negatives (an
 * agent that we don't surface) are acceptable, false positives (a
 * synthetic "phase" with no real agent) are not. We dedupe identical
 * prompts within a phase so that recursing over a tree of `parallel`
 * calls doesn't blow up the dialog.
 *
 * Implementation note: we never invoke the script. The script string
 * may contain arbitrary code, including comments and template literals
 * with `${...}` interpolations — `stripStringsAndComments` neutralises
 * both before any regex match so `agent(` inside a string can't be
 * mistaken for a real call.
 */

export type ScriptPhase = {
  kind: 'sequential' | 'parallel' | 'loop'
  agents: Array<{ prompt: string }>
  annotation?: string
}

export type ScriptAnalysis = {
  phases: ScriptPhase[]
  estimatedAgents: number
  hasReturn: boolean
}

const PROMPT_MAX_LEN = 60
const LOOP_CONDITION_MAX_LEN = 40
const PARALLEL_WEIGHT = 3

export function analyzeScript(source: string): ScriptAnalysis {
  if (!source) {
    return { phases: [], estimatedAgents: 0, hasReturn: false }
  }

  const hasReturn = /\breturn\b/.test(source)

  const stripped = stripStringsAndComments(source)

  // Strip the userScript wrapper body so we can iterate the script's
  // top-level statements. Anything outside the wrapper is metadata
  // (type annotations, comments above the function) and must not
  // contribute phases.
  const strippedBody = extractFunctionBody(stripped, 'userScript') ?? stripped

  // We use the *stripped* body for structural context (so a
  // `parallel` inside a string can't be mistaken for real code), but
  // we still resolve agent-call positions on the *original* source
  // so the first string argument survives. To do that, we shift
  // every position in `strippedBody` back to its source equivalent.
  // `stripStringsAndComments` preserves length, so the mapping is
  // identity. We just keep two parallel views of the body.
  const originalBody = extractFunctionBody(source, 'userScript') ?? source
  const phases = extractPhases(strippedBody, originalBody)

  const estimatedAgents = phases.reduce((sum, p) => {
    if (p.kind === 'parallel') return sum + p.agents.length * PARALLEL_WEIGHT
    return sum + p.agents.length
  }, 0)

  return { phases, estimatedAgents, hasReturn }
}

/**
 * Replace string/template-literal contents and `// ...` / `/* ... *\/`
 * comment bodies with spaces so downstream regexes can't see them.
 * Single quotes, double quotes, backticks, and regex literals are all
 * handled. The replacement preserves character offsets (the source
 * length never changes) so position math elsewhere still lines up.
 */
export function stripStringsAndComments(source: string): string {
  let out = ''
  let i = 0
  const n = source.length

  while (i < n) {
    const ch = source[i]!
    const next = source[i + 1]

    // line comment
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }

    // block comment
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out += '  '
          i += 2
          break
        }
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }

    // string literals (single / double quote)
    if (ch === '"' || ch === "'") {
      const quote = ch
      out += ' '
      i++
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out += '  '
          i += 2
          continue
        }
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += ' '
        i++
      }
      continue
    }

    // template literal
    if (ch === '`') {
      out += ' '
      i++
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\' && i + 1 < n) {
          out += '  '
          i += 2
          continue
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          // emit a single space + open brace (so `${` is still
          // recognised as a brace) and step into the interpolation
          out += '${'
          i += 2
          // recurse through the interpolation body — strip inner
          // strings/comments too so nested quotes inside `${...}`
          // can't trick us
          let depth = 1
          while (i < n && depth > 0) {
            if (source[i] === '{') depth++
            else if (source[i] === '}') {
              depth--
              if (depth === 0) break
            }
            out += source[i] === '\n' ? '\n' : ' '
            i++
          }
          if (i < n) {
            out += '}'
            i++
          }
          continue
        }
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += ' '
        i++
      }
      continue
    }

    // regex literal — heuristic: slash following a context that
    // closes an expression (operator, keyword, opening punctuation).
    // We only need this to swallow the regex pattern so a `/.../`
    // doesn't accidentally split a comment; we keep it simple and
    // allow regexes only after `=`, `(`, `,`, `;`, `!`, `&`, `|`,
    // `?`, `{`, `}`, `[`, `]`, `:`, `>`, `<`, `+`, `-`, `*`, `%`,
    // `^`, `~`. Anything else, we treat the `/` as division.
    if (
      ch === '/' &&
      next !== undefined &&
      next !== '/' &&
      next !== '*' &&
      isRegexContext(out)
    ) {
      out += ' '
      i++
      // inside a character class `[...]`, `/` is literal
      let inClass = false
      while (i < n) {
        if (source[i] === '\\' && i + 1 < n) {
          out += '  '
          i += 2
          continue
        }
        if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        else if (source[i] === '/' && !inClass) {
          out += ' '
          i++
          // consume flags
          while (i < n && /[a-z]/i.test(source[i]!)) {
            out += ' '
            i++
          }
          break
        }
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }

    out += ch
    i++
  }

  return out
}

function isRegexContext(prefix: string): boolean {
  // walk backwards over whitespace and find the last non-space char
  for (let k = prefix.length - 1; k >= 0; k--) {
    const c = prefix[k]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
    return /[=(,;:!&|?{}[\]<>+\-*/%^~]/.test(c) || !/[\w$)]/.test(c)
  }
  return true
}

/**
 * Pull out the body of `function userScript(...) { ... }` so the
 * analyser only sees statements that actually run. Returns the raw
 * `{...}` contents (no braces) or null if no wrapper is found. We
 * intentionally keep nested braces intact so a phase detector can
 * still see the depth of `parallel([...]).
 */
function extractFunctionBody(stripped: string, name: string): string | null {
  const idx = stripped.search(new RegExp(`\\bfunction\\s+${name}\\b`))
  if (idx < 0) return null
  const open = stripped.indexOf('{', idx)
  if (open < 0) return null

  // balance braces from `open`, tracking nesting inside strings
  // (stripped already neutralises strings so we can balance purely
  // on `{`/`}`)
  let depth = 1
  let i = open + 1
  while (i < stripped.length && depth > 0) {
    const c = stripped[i]!
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) {
      return stripped.slice(open + 1, i)
    }
    i++
  }
  return null
}

type RawCall = {
  index: number
  endIndex: number
  prompt: string | null
}

/**
 * Find every `agent(...)` call in the body, capturing the index
 * range and the first string argument (if any). Calls are returned
 * in source order. The caller passes both the *stripped* body (for
 * index/balance work that must ignore strings) and the *original*
 * body (for reading the literal first argument).
 */
export function findAgentCalls(strippedBody: string, originalBody: string): RawCall[] {
  const calls: RawCall[] = []
  const re = /\bagent\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(strippedBody))) {
    const start = m.index
    const openParen = re.lastIndex - 1
    const closeParen = matchParen(strippedBody, openParen)
    if (closeParen < 0) continue

    const inside = originalBody.slice(openParen + 1, closeParen)
    const prompt = readFirstStringArg(inside)

    calls.push({
      index: start,
      endIndex: closeParen + 1,
      prompt,
    })
  }
  return calls
}

function matchParen(body: string, openAt: number): number {
  // assumes body[openAt] === '('
  let depth = 1
  let i = openAt + 1
  while (i < body.length) {
    const c = body[i]!
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/**
 * Return the first `"..."` / `'...'` / `` `...` `` literal text
 * inside `argSrc`, or null if the first argument is not a literal.
 * We don't try to evaluate template interpolations — if the prompt
 * is dynamic (e.g. `agent(angles[i])`), we surface null so the UI
 * shows a generic placeholder rather than guessing.
 */
export function readFirstStringArg(argSrc: string): string | null {
  // skip leading whitespace
  let trimmed = argSrc.replace(/^\s+/, '')
  if (!trimmed) return null

  // When called from `scanParallelSiblings`, `argSrc` is the whole
  // arrow sibling like `() => agent("p1")`, not just the first
  // argument. If we don't see a quote at the start, search for an
  // `agent(` call and use its first argument instead.
  const firstCh = trimmed[0]!
  if (firstCh !== '"' && firstCh !== "'" && firstCh !== '`') {
    const agentMatch = /\bagent\s*\(/.exec(trimmed)
    if (!agentMatch) return null
    const openParen = agentMatch.index + agentMatch[0].length - 1
    const closeParen = matchParen(trimmed, openParen)
    if (closeParen < 0) return null
    trimmed = trimmed.slice(openParen + 1, closeParen).replace(/^\s+/, '')
    if (!trimmed) return null
    if (trimmed[0] !== '"' && trimmed[0] !== "'" && trimmed[0] !== '`') return null
  }

  const ch = trimmed[0]!
  let i = 1
  let buf = ''
  while (i < trimmed.length && trimmed[i] !== ch) {
    if (trimmed[i] === '\\' && i + 1 < trimmed.length) {
      // For our purposes we don't decode escapes; preserve the raw
      // char. The dialog only uses this as a label.
      buf += trimmed[i + 1]
      i += 2
      continue
    }
    if (trimmed[i] === '$' && trimmed[i + 1] === '{') {
      // dynamic — bail
      return null
    }
    buf += trimmed[i]
    i++
  }
  return buf
}

/**
 * Decide whether the `agent(...)` call at `call.index` sits inside a
 * `parallel([...])` fan-out, a `for`/`while` loop, or just plain
 * sequential code. The prefix always extends from the function
 * body's first character to the call so that `for (...)` headers
 * and `parallel([` wrappers are visible even when nested several
 * statements deep.
 */
export function classifyContext(
  body: string,
  call: RawCall,
): { kind: 'parallel' | 'loop' | 'sequential'; siblingCount?: number; loopCondition?: string; nearestParallelIdx?: number } {
  const prefix = body.slice(0, call.index)

  // Find the *nearest* `parallel([` whose array hasn't yet closed
  // before the call. For nested parallel we want the innermost
  // sibling array — the outer parallel will treat the inner one
  // as a single sibling (see `extractPhases`).
  const nearest = findNearestParallel(prefix)
  if (nearest >= 0 && isInsideOpenArray(prefix, nearest)) {
    // Sibling count should reflect the *complete* array, not just
    // the prefix — otherwise an agent near the start of a
    // `parallel([ ... N siblings ... ])` reads as `×1`. Use the
    // full body for counting; the array close lies after the
    // prefix by definition here (it's still open at the call).
    const siblingCount = countParallelSiblings(body, nearest)
    return { kind: 'parallel', siblingCount, nearestParallelIdx: nearest }
  }

  // `for (... )` / `while (...)` — look for a loop header in the
  // prefix
  const loopCondition = findEnclosingLoop(prefix)
  if (loopCondition) {
    return { kind: 'loop', loopCondition }
  }

  return { kind: 'sequential' }
}

/**
 * Return true when the agent call at the end of `prefix` sits
 * inside the array opened by `parallelAt`'s `[` — i.e. we haven't
 * seen the matching `]` yet.
 */
function isInsideOpenArray(prefix: string, parallelAt: number): boolean {
  const openIdx = prefix.indexOf('[', parallelAt)
  if (openIdx < 0) return false
  let depth = 1
  for (let i = openIdx + 1; i < prefix.length; i++) {
    const c = prefix[i]!
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return false
    }
  }
  return depth > 0
}

/**
 * Return the index of the `parallel` keyword whose `(` opens the
 * array closest to (and before) the agent call, or -1 if no
 * `parallel([` appears in the prefix. Scanning with `lastIndex`
 * mutation keeps memory bounded for large scripts.
 */
function findNearestParallel(prefix: string): number {
  // Use a fresh RegExp each call so the global `lastIndex` can't
  // leak across invocations (we never know which prefix is longer
  // than the previous one)
  const re = new RegExp('\\bparallel\\s*\\(\\s*\\[', 'g')
  let best = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(prefix))) {
    best = m.index
  }
  return best
}

/**
 * Given the prefix text leading up to a `parallel([` and the index
 * where the `parallel` call begins, count how many top-level arrow
 * siblings appear inside the array. We re-balance `[` and `]` to
 * find the array close, then split on top-level commas.
 */
export function countParallelSiblings(prefix: string, parallelAt: number): number {
  const afterBracket = prefix.indexOf('[', parallelAt)
  if (afterBracket < 0) return 1

  let depth = 1
  let i = afterBracket + 1
  let closed = false
  while (i < prefix.length && depth > 0) {
    const c = prefix[i]!
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        closed = true
        break
      }
    }
    i++
  }

  // When the array is still open at the call site (we haven't
  // reached the closing `]` yet), slice to the end of the prefix;
  // sibling count is the top-level commas we *did* see plus one
  // for the in-progress sibling that contains the agent call.
  const innerEnd = closed ? i : prefix.length
  const inner = prefix.slice(afterBracket + 1, innerEnd)
  if (inner.trim() === '') return 0

  let commas = 0
  let nested = 0
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!
    if (c === '[' || c === '(' || c === '{') nested++
    else if (c === ']' || c === ')' || c === '}') nested--
    else if (c === ',' && nested === 0) commas++
  }
  // Strip a trailing comma — `[a, b, c,]` and `[a, b, c,\n  ]`
  // are still 3 siblings, not 4. We trim right whitespace and
  // check whether the array ends in a comma.
  const trimmedRight = inner.replace(/\s+$/, '')
  if (trimmedRight.endsWith(',')) commas--
  if (commas < 0) commas = 0
  return commas + 1
}

/**
 * Look backwards from the agent call and return the textual content
 * of the most recent `for (...)` or `while (...)` header, truncated
 * to LOOP_CONDITION_MAX_LEN so it fits in the dialog annotation.
 */
export function findEnclosingLoop(prefix: string): string | null {
  // search for the nearest loop header
  const forRe = /\bfor\s*\(([^)]*)\)/g
  const whileRe = /\bwhile\s*\(([^)]*)\)/g

  let best: { idx: number; cond: string } | null = null
  let m: RegExpExecArray | null
  while ((m = forRe.exec(prefix))) {
    const idx = m.index
    if (!best || idx > best.idx) best = { idx, cond: m[1] ?? '' }
  }
  while ((m = whileRe.exec(prefix))) {
    const idx = m.index
    if (!best || idx > best.idx) best = { idx, cond: m[1] ?? '' }
  }
  if (!best) return null

  const cond = best.cond.trim().replace(/\s+/g, ' ')
  if (cond.length <= LOOP_CONDITION_MAX_LEN) return cond
  return cond.slice(0, LOOP_CONDITION_MAX_LEN - 1) + '…'
}

/**
 * Walk the function body in statement order and group agent calls
 * into phases. Three rules govern grouping:
 *
 *  - Each outermost `parallel([...])` becomes exactly one phase;
 *    its agents list records the *top-level* siblings of the
 *    array, so a nested `parallel([...])` inside counts as a
 *    single "(parallel group)" sibling rather than expanding its
 *    children. That keeps the phase chip width bounded for deeply
 *    nested fan-outs.
 *  - Each `for (...)` / `while (...)` loop becomes one phase; the
 *    loop header is preserved as `annotation`.
 *  - Sequential calls each get their own phase, except that two
 *    adjacent sequential calls with identical prompts fold together
 *    (a tight `await agent(x); await agent(x);` shouldn't surface
 *    as two redundant chips).
 */
function extractPhases(strippedBody: string, originalBody: string): ScriptPhase[] {
  const calls = findAgentCalls(strippedBody, originalBody)
  const phases: ScriptPhase[] = []

  // First pass: identify the set of outermost parallel scopes
  // (parallels that aren't nested inside another parallel). For each
  // we materialise a `parallel` phase directly from the array's
  // top-level siblings, so the chip width reflects the outer fan-out
  // regardless of how the inner children are written.
  const outermostParallels = findOutermostParallels(strippedBody, originalBody)
  for (const op of outermostParallels) {
    phases.push({
      kind: 'parallel',
      agents: op.entries,
      annotation: op.siblingCount > 0 ? `×${op.siblingCount}` : undefined,
    })
  }

  // Mark every agent that lives inside any parallel scope as
  // absorbed (it already shows up via the top-level sibling entry
  // above) — only agents outside any parallel become sequential /
  // loop phases below.
  const absorbed = new Set<number>()
  for (const call of calls) {
    if (isInsideAnyParallel(strippedBody, call.index)) {
      absorbed.add(call.index)
    }
  }

  // Second pass: walk remaining (non-absorbed) calls as sequential
  // or loop phases.
  for (const call of calls) {
    if (absorbed.has(call.index)) continue
    const ctx = classifyContext(strippedBody, call)
    const prompt = normalisePrompt(call.prompt)

    if (ctx.kind === 'loop') {
      const last = phases[phases.length - 1]
      if (last && last.kind === 'loop' && last.annotation === ctx.loopCondition) {
        if (!last.agents.some(a => a.prompt === prompt)) {
          last.agents.push({ prompt })
        }
      } else {
        phases.push({
          kind: 'loop',
          agents: [{ prompt }],
          annotation: ctx.loopCondition ?? undefined,
        })
      }
      continue
    }

    // sequential
    const last = phases[phases.length - 1]
    if (
      last &&
      last.kind === 'sequential' &&
      last.agents[last.agents.length - 1]?.prompt === prompt
    ) {
      continue
    }
    phases.push({ kind: 'sequential', agents: [{ prompt }] })
  }

  return phases
}

type OutermostParallel = {
  siblingCount: number
  entries: Array<{ prompt: string }>
}

/**
 * Walk the function body and return a phase-shape for every
 * outermost `parallel([...])` invocation. Each parallel's
 * top-level siblings are scanned: `() => agent("literal")` adds the
 * literal prompt, `() => parallel([...])` adds a synthetic
 * "(parallel ×N)" entry derived from the inner sibling count.
 */
function findOutermostParallels(
  strippedBody: string,
  originalBody: string,
): OutermostParallel[] {
  const re = /\bparallel\s*\(\s*\[/g
  const result: OutermostParallel[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(strippedBody))) {
    const idx = m.index
    // outermost means no enclosing parallel whose `[` is strictly
    // before `idx` and whose `]` lies after `idx`
    if (isInsideAnyParallel(strippedBody, idx)) continue

    const openBracket = strippedBody.indexOf('[', idx)
    if (openBracket < 0) continue
    let depth = 1
    let closeBracket = -1
    for (let i = openBracket + 1; i < strippedBody.length; i++) {
      const c = strippedBody[i]!
      if (c === '[') depth++
      else if (c === ']') {
        depth--
        if (depth === 0) {
          closeBracket = i
          break
        }
      }
    }
    if (closeBracket < 0) continue

    const siblingCount = countParallelSiblings(strippedBody, idx)
    const entries = scanParallelSiblings(originalBody, openBracket, closeBracket)
    result.push({ siblingCount, entries })
  }
  return result
}

/**
 * Return true when `idx` sits inside *any* open `parallel([` whose
 * `[` is strictly before `idx` (and whose `]` is strictly after).
 */
function isInsideAnyParallel(body: string, idx: number): boolean {
  const re = /\bparallel\s*\(\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const openBracket = body.indexOf('[', m.index)
    if (openBracket < 0 || openBracket >= idx) continue
    let depth = 1
    for (let i = openBracket + 1; i < body.length; i++) {
      const c = body[i]!
      if (c === '[') depth++
      else if (c === ']') {
        depth--
        if (depth === 0) {
          // the `]` is past `idx` only if `i > idx`
          if (i >= idx) return true
          break
        }
      }
    }
  }
  return false
}

/**
 * Split the originalBody substring between `[` (exclusive) and `]`
 * (exclusive) on top-level commas, then for each sibling look for
 * either an `agent("...")` literal (prompt) or a nested
 * `parallel([...])` (counted as one synthetic entry). Siblings that
 * are neither contribute nothing — they are scaffolding the runner
 * cares about but the dialog doesn't surface.
 */
function scanParallelSiblings(
  originalBody: string,
  openBracket: number,
  closeBracket: number,
): Array<{ prompt: string }> {
  const inner = originalBody.slice(openBracket + 1, closeBracket)
  // split on top-level commas
  const siblings: string[] = []
  let buf = ''
  let nested = 0
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!
    if (c === '[' || c === '(' || c === '{') {
      nested++
      buf += c
    } else if (c === ']' || c === ')' || c === '}') {
      nested--
      buf += c
    } else if (c === ',' && nested === 0) {
      siblings.push(buf)
      buf = ''
    } else {
      buf += c
    }
  }
  if (buf.trim() !== '') siblings.push(buf)

  const entries: Array<{ prompt: string }> = []
  for (const sibling of siblings) {
    const agentPrompt = readFirstStringArg(sibling)
    if (agentPrompt !== null) {
      entries.push({ prompt: normalisePrompt(agentPrompt) })
      continue
    }
    const innerParallelMatch = /\bparallel\s*\(\s*\[/.exec(sibling)
    if (innerParallelMatch) {
      const innerCount = countParallelSiblings(sibling, innerParallelMatch.index)
      entries.push({ prompt: normalisePrompt(`(parallel ×${innerCount})`) })
      continue
    }
  }
  return entries
}

function normalisePrompt(prompt: string | null): string {
  if (!prompt) return '(dynamic)'
  if (prompt.length <= PROMPT_MAX_LEN) return prompt
  return prompt.slice(0, PROMPT_MAX_LEN - 1) + '…'
}