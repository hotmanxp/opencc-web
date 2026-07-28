// src/tools/WorkflowTool/cliArgs.ts
//
// Parse a CLI-style args string into a plain object so workflow
// scripts can read `args.name`, `args.word`, `args.verbose` directly
// instead of writing `args[0].split('=')[1]` boilerplate.
//
// Used by:
//   - createWorkflowCommand.ts: keeps the raw string instead of
//     splitting into array, so the LLM sees it as a single string
//   - WorkflowTool.ts call(): when args is a string, runs parseCliArgs
//     before injecting into the worker script's `args` global

export type CliArgs = Record<string, string | boolean>

/**
 * Parse a CLI-style args string into a plain object.
 *
 *   "--name=ethan --word=hello --verbose"
 *     -> { name: 'ethan', word: 'hello', verbose: true }
 *
 * Rules:
 *   - `--key=value`         -> { key: 'value' }    (string value)
 *   - `--key="multi word"`  -> { key: 'multi word' }  (double-quoted)
 *   - `--key='multi word'`  -> { key: 'multi word' }  (single-quoted)
 *   - `--key` (no `=`)      -> { key: true }       (boolean flag)
 *   - Empty/whitespace str  -> {}
 *   - Tokens without `--`   -> ignored (e.g. `/path`, `-x`)
 *   - `--no-foo`            -> { 'no-foo': true } (NOT negation — use `--foo=false` instead)
 *   - Duplicate keys        -> last one wins (string overrides boolean)
 *
 * **No positional args.** A non-empty input without any `--`-prefixed
 * tokens (e.g. `parseCliArgs("What is X?")`) returns `{}` — positional
 * strings are silently dropped. Callers that need to accept a bare
 * question (like bundled/deepResearch.ts) must either check the empty
 * result and fall back to the raw input, or require callers to use an
 * explicit `--question="..."` flag.
 *
 * The parser is intentionally minimal — no env expansion (`$VAR`),
 * no escape sequences inside quoted values, no positional args.
 * Workflow scripts that need richer parsing should call a real CLI
 * parser like `commander`/`yargs` directly.
 */
export function parseCliArgs(input: string | null | undefined): CliArgs {
  if (!input) return {}
  const trimmed = input.trim()
  if (!trimmed) return {}

  const out: CliArgs = {}

  // Match one token at a time. Three value capture groups:
  //   1. double-quoted: "..."
  //   2. single-quoted: '...'
  //   3. bare value (until whitespace or quote char)
  // Boolean (no `=`) is the `=== undefined` branch below.
  // Note: bare value is `*` (not `+`) so `--key=` parses to `{key: ''}`
  // instead of falling through to the boolean branch.
  // Contract: only `--`-prefixed tokens are extracted. Positional
  // strings without `--` (e.g. `"What is X?"`) are silently dropped —
  // callers like bundled/deepResearch.ts handle the empty-result case
  // by falling back to a positional question.
  const TOKEN_RE = /--([a-zA-Z_][\w-]*)(?:=("([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s"']*)))?/g

  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(trimmed)) !== null) {
    const key = match[1]
    const doubleQuoted = match[3]
    const singleQuoted = match[4]
    const bareValue = match[5]

    if (doubleQuoted !== undefined) {
      out[key] = unescapeQuotes(doubleQuoted, '"')
    } else if (singleQuoted !== undefined) {
      out[key] = unescapeQuotes(singleQuoted, "'")
    } else if (bareValue !== undefined) {
      out[key] = bareValue
    } else {
      out[key] = true
    }
  }

  return out
}

/**
 * Process backslash escapes inside a quoted string value.
 * Only `\"` and `\'` are recognized — everything else is left as-is
 * (we don't want to interpret `\n` in workflow CLI args).
 * The `_quote` parameter is reserved for future per-quote strictness;
 * today the same replacement applies regardless of which quote wrapped
 * the value (callers usually want `\"` to unescape inside both).
 */
function unescapeQuotes(raw: string, _quote: '"' | "'"): string {
  return raw.replace(/\\(["'])/g, '$1')
}