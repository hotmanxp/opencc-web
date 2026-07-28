// src/tools/StructuredOutputTool/textJsonExtractor.ts
//
// Find the first balanced JSON value (object / array / string scalar)
// embedded in a prose string. Used by the WorkflowTool runtime as the
// text-fallback path for `agent(prompt, { schema })` calls — non-firstParty
// LLMs commonly emit their structured answer wrapped in natural-language
// prose ("The answer is {\"type\": \"node\"} because I read package.json")
// instead of via the bound StructuredOutput tool. Without this, JSON.parse
// would fail on the leading prose and the workflow would surface the
// failure envelope even though the answer is recoverable.
//
// Distinct from JSON repair (closing-brace repair for truncated JSON):
// this only finds the FIRST balanced value, doesn't attempt to fix
// unbalanced JSON, and returns a substring (not a parsed value) so the
// caller retains full control over JSON.parse + schema validation.

/**
 * Scan `text` for the first character that opens a JSON value (`{`, `[`,
 * or `"`) and return the substring up to and including the matching close.
 * Tracks string state and `\\` escapes so braces inside JSON strings don't
 * unbalance the depth count. Returns `undefined` if no balanced value is
 * found — caller should treat this as "no JSON in the text" and fall through
 * to whatever its no-answer path is.
 *
 * For bare scalars like `42` or `true` (no opening quote/brace), returns
 * `undefined` — the caller's `JSON.parse(trimmedText)` handles those in
 * O(1) without needing the extractor.
 *
 * The returned substring is structurally balanced (not necessarily valid
 * JSON — caller must `JSON.parse` it).
 */
export function findFirstBalancedJsonValue(text: string): string | undefined {
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{' || c === '[' || c === '"') {
      start = i
      break
    }
  }
  if (start === -1) return undefined

  // String scalar: find matching close quote, skipping \" and \\.
  if (text[start] === '"') {
    let i = start + 1
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '"') {
        return text.slice(start, i + 1)
      }
      i++
    }
    return undefined
  }

  // Object or array: balance braces/brackets, tracking string state.
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
    } else if (c === '{' || c === '[') {
      depth++
    } else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return undefined
}
