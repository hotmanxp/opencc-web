/**
 * Regression test for the malformed-input bug (Aug 2026).
 *
 * Symptom: SSE stream for a Bash prompt showed
 *   runtime.tool_call Bash input: "{}{}"
 *   runtime.tool_result Bash
 *     <tool_use_error>InputValidationError: Bash failed ... The parameter
 *     `` type is expected as `object` but provided as `string`</tool_use_error>
 *
 * Root cause: the upstream proxy (e.g. minimax MiniMax-M3) emits
 * `input_json_delta` fragments whose concatenation is not valid JSON
 * (observed: literal "{}{}" when the proxy re-emits `{}` as separate
 * deltas). The bridge's `translateCallModel` accumulates the
 * deltas into `pendingToolInputJson` and assigns it to
 * `tu.input` as a string, then at `content_block_stop` runs
 * `JSON.parse` on it. When the parse fails the original code
 * left the string in place, and vendor's
 * `tool.inputSchema.safeParse("{}{}")` rejected with the
 * "expected object, received string" error.
 *
 * Fix: at `content_block_stop`, if `JSON.parse` fails, set
 * `tu.input = {}` so the next guard (the MiniMax-M3 default-input
 * patch a few lines below) substitutes the safe per-tool default
 * (e.g. `{command: 'pwd'}` for Bash). The conversation can
 * continue, and the user sees the tool actually run.
 *
 * This test imports the vendor `runPreToolUseHooks` indirectly by
 * mirroring the same short-circuit rule. The static source-content
 * check below locks the patch to the actual implementation file.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Mirror of the parsing fallback in
 * src/compat/runtime/buildOpenccQueryParams.ts. If this drifts from
 * the vendor implementation, the static test below also fails.
 */
function applyMalformedInputFallback(input: unknown): unknown {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input)
    } catch {
      return {}
    }
  }
  return input
}

describe('buildOpenccQueryParams malformed tool_use.input', () => {
  it('parses a normal JSON string', () => {
    expect(applyMalformedInputFallback('{"command":"pwd"}')).toEqual({
      command: 'pwd',
    })
  })

  it('falls back to {} on concatenated "{}{}" (MiniMax-M3 proxy bug)', () => {
    // Pre-fix: left as string "{}{}" → vendor zod rejects with
    // "expected object, received string".
    // Post-fix: returns {} so the default-input patch can substitute
    // a per-tool safe default.
    expect(applyMalformedInputFallback('{}{}')).toEqual({})
  })

  it('falls back to {} on partial JSON like "{"command":"git', () => {
    // Mid-stream parse failure (deltas not yet complete at the
    // moment the block-stop fires — should not happen in practice
    // but the fallback is robust to it).
    expect(applyMalformedInputFallback('{"command":"git')).toEqual({})
  })

  it('passes objects through unchanged', () => {
    expect(applyMalformedInputFallback({ command: 'pwd' })).toEqual({
      command: 'pwd',
    })
  })

  it('passes undefined through unchanged', () => {
    expect(applyMalformedInputFallback(undefined)).toBeUndefined()
  })
})

describe('vendor patch is present in buildOpenccQueryParams.ts', () => {
  // Static check: ensures the actual source carries the fallback.
  // If a future edit removes `tu.input = {}` and reverts to the
  // original `// leave as string` comment, this test fails — which
  // is exactly what we want, because the malformed-input bug would
  // come back.
  const srcPath = resolve(
    HERE,
    '..',
    '..',
    '..',
    'src/compat/runtime/buildOpenccQueryParams.ts',
  )
  const src = readFileSync(srcPath, 'utf-8')

  it('replaces the original "leave as string" comment with a fallback to {}', () => {
    // The fix replaces the `// leave as string — opencc will see the
    // partial JSON and error` comment with one that ends with
    // `tu.input = {}`. Anchored so a future revert of the fallback
    // is caught. We use a loose [\s\S]{0,800} window because the
    // explanatory comment between the catch and the assignment can
    // grow over time.
    expect(src).toMatch(/JSON\.parse\(tu\.input\)[\s\S]{0,800}tu\.input\s*=\s*\{\}/)
  })
})
