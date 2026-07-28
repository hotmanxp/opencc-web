/**
 * Pre-flight safety check for workflow script source.
 *
 * Upstream claude-code 2.1.170's binary contains three explicit error
 * messages that gate workflow execution:
 *
 *   - "Date.now() / new Date() are unavailable in workflow scripts
 *     (breaks resume). Stamp results after the workflow returns, or
 *     pass timestamps via args."
 *   - "Math.random() is unavailable in workflow scripts (breaks resume).
 *     For N independent samples, include the index in the agent label
 *     or prompt."
 *   - "import() is not available in workflow scripts." (handled in
 *     vmContext.ts via vm.runInContext's importModuleDynamically)
 *
 * The first two break resume because Date.now() and Math.random()
 * make workflow output non-deterministic across replays — the upstream
 * cache hashes (prompt, opts) and would happily return stale results
 * that depend on values that have changed.
 *
 * We strip line/block comments and string-literal contents before
 * matching so a prompt template that *mentions* `Date.now()` as
 * documentation (e.g. `` `try not to call ${'Date.now()'}` ``) doesn't
 * trigger a false positive. We intentionally do NOT use the canonical
 * `stripStringsAndComments` from `staticAnalyzer.ts` because that
 * stripper blanks out template-literal `${...}` interpolation bodies
 * too — which would let `` `${Date.now()}` `` slip past the safety
 * check. Resume-safety wants the *opposite* policy: interpolation
 * bodies are real runtime code, so any `Date.now()` inside `${...}`
 * must remain visible to the regex. The local `stripForResumeSafety`
 * below mirrors the staticAnalyzer version but keeps interpolation
 * bodies intact.
 */

export const DATE_ERROR =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). ' +
  'Stamp results after the workflow returns, or pass timestamps via args.'
export const MATH_ERROR =
  'Math.random() is unavailable in workflow scripts (breaks resume). ' +
  'For N independent samples, include the index in the agent label or prompt.'

/**
 * Replace line/block comment bodies and string-literal contents
 * (including the *quasi* parts of template literals) with spaces,
 * while keeping `${...}` interpolation bodies verbatim so a
 * `Date.now()` hidden inside an interpolation is still detected.
 * Total length is preserved so position math is still meaningful.
 */
function stripForResumeSafety(source: string): string {
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

    // string literal (single / double quote)
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
        out += ' '
        i++
      }
      out += ' '
      i++
      continue
    }

    // template literal — blank the quasi parts, but keep the
    // `${...}` interpolation bodies so e.g. `${Date.now()}` is
    // still detected as a resume-breaking call.
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
          out += '${'
          i += 2
          let depth = 1
          while (i < n && depth > 0) {
            if (source[i] === '{') depth++
            else if (source[i] === '}') {
              depth--
              if (depth === 0) break
            }
            // preserve real characters in the interpolation body
            out += source[i] === '\n' ? '\n' : source[i]!
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

    out += ch
    i++
  }
  return out
}

/**
 * Throws with the upstream error string if `source` uses any
 * resume-breaking global. Idempotent and side-effect-free.
 */
export function assertResumeSafe(source: string): void {
  if (!source) return
  const stripped = stripForResumeSafety(source)
  if (/\bDate\s*\.\s*now\s*\(/.test(stripped)) throw new Error(DATE_ERROR)
  if (/\bnew\s+Date\s*\(/.test(stripped)) throw new Error(DATE_ERROR)
  if (/\bMath\s*\.\s*random\s*\(/.test(stripped)) throw new Error(MATH_ERROR)
}
