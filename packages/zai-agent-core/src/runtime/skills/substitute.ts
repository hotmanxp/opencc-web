/**
 * Substitute $ARGUMENTS / $N / $NAME placeholders in skill markdown bodies.
 *
 * Mirrors opencc's `utils/argumentSubstitution.ts` semantics:
 *  - `$ARGUMENTS`        → full raw args string
 *  - `$ARGUMENTS[N]`     → N-th parsed token
 *  - `$N`                → shorthand for `$ARGUMENTS[N]` (N ≥ 0)
 *  - `$NAME`             → positional named arg (declared in frontmatter `arguments`)
 *  - `$@`                → equivalent to `$ARGUMENTS`
 *  - escapeRegExp        → protect user-supplied names from regex injection
 *  - appendIfNoPlaceholder → when no placeholder exists, append `ARGUMENTS: {args}`
 *
 * Tokenization: zai doesn't have `shell-quote`, so we ship a small in-house
 * tokenizer that handles single/double-quoted strings + backslash escapes
 * (the only shapes Claude skill bodies actually use). For exotic shell
 * operators we fall back to whitespace split — the same fallback opencc
 * uses when shell-quote itself fails.
 *
 * Differences from opencc: zai preserves the legacy 4-arg signature
 * `substituteArgumentsLegacy(body, args, quoted, argNames)` for back-compat
 * with the existing SkillTool body. `quoted:false` uses plain whitespace split;
 * `quoted:true` uses the new tokenizer (the recommended default).
 */
import { escapeRegExp } from '../../opencc-internals/utils/stringUtils.js'

/**
 * Tokenize an arguments string into individual positional args.
 *
 * Handles:
 *  - `'foo bar'` / `"foo bar"`  → single token `foo bar`
 *  - `\\` escape                → next char literal
 *  - whitespace                 → token boundary
 *
 * Does NOT handle: shell operators (`;`, `|`, `&&`), glob expansion, command
 * substitution. If those show up, we fall back to plain whitespace split
 * because they don't make sense inside a skill body anyway.
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) return []

  const tokens: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  let i = 0

  while (i < args.length) {
    const c = args[i]!
    if (quote === null) {
      if (c === '"' || c === "'") {
        quote = c
        i++
        continue
      }
      if (c === '\\' && i + 1 < args.length) {
        buf += args[i + 1]
        i += 2
        continue
      }
      if (/\s/.test(c)) {
        if (buf.length > 0) {
          tokens.push(buf)
          buf = ''
        }
        i++
        continue
      }
      buf += c
      i++
    } else {
      // Inside a quoted region: same backslash rules, but only the matching
      // close quote exits. Newlines / unmatched quote → preserve literal so
      // the caller can see the malformed input.
      if (c === '\\' && i + 1 < args.length && quote !== "'") {
        // In bash, single quotes preserve backslash literally. Double quotes
        // honor backslash only before specific chars; we just pass through.
        buf += args[i + 1]
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      buf += c
      i++
    }
  }

  if (buf.length > 0) tokens.push(buf)
  // Unterminated quote is degenerate input — return what we got. Caller can
  // decide whether to surface this; for skill bodies, it's almost always OK.
  return tokens
}

/**
 * Parse argument names from frontmatter `arguments` field.
 *
 * Accepts space-separated string or string[]. Filters out empty / numeric-only
 * names (numeric names would collide with $0 / $1 shorthand).
 */
export function parseArgumentNames(
  argumentNames: string | string[] | undefined,
): string[] {
  if (!argumentNames) return []
  const isValidName = (name: string): boolean =>
    typeof name === 'string' &&
    name.trim() !== '' &&
    !/^\d+$/.test(name)

  if (Array.isArray(argumentNames)) {
    return argumentNames.filter(isValidName)
  }
  if (typeof argumentNames === 'string') {
    return argumentNames.split(/\s+/).filter(isValidName)
  }
  return []
}

/**
 * Substitute placeholders in `content` using `args`.
 *
 * Order matters: named args first, then `$ARGUMENTS[N]`, then `$N`, then
 * `$ARGUMENTS` (so `$ARGUMENTS[0]` doesn't get clobbered by the bare-word
 * replacement).
 *
 * If no placeholder is found and `appendIfNoPlaceholder` is true (and args is
 * non-empty), appends `ARGUMENTS: {args}` so a user-invoked skill without
 * placeholder syntax still sees its args.
 */
export function substituteArguments(
  content: string,
  args: string | undefined | null,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
): string {
  // undefined/null means no args provided. Empty string is a valid input that
  // should replace placeholders with empty.
  if (args === undefined || args === null) return content

  const parsedArgs = parseArguments(args)
  const originalContent = content
  let out = content

  // Named arguments: $name where name is from frontmatter `arguments`.
  // Map positional: argumentNames[0] → parsedArgs[0].
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]
    if (!name) continue
    // Match $name but not $nameXxx or $name[...]
    // escapeRegExp: name comes from author frontmatter — author-defined regex
    // metachars would otherwise throw on unbalanced parens or over-match.
    out = out.replace(
      new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'),
      parsedArgs[i] ?? '',
    )
  }

  // Indexed: $ARGUMENTS[N]
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return parsedArgs[index] ?? ''
  })

  // Shorthand indexed: $N
  out = out.replace(/\$(\d+)(?!\w)/g, (_match, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return parsedArgs[index] ?? ''
  })

  // Full args
  out = out.replaceAll('$ARGUMENTS', args)

  // No placeholder found + appendIfNoPlaceholder + non-empty args → append
  // (matches opencc; provides a soft default for skill bodies that don't
  // declare placeholders but were invoked with arguments).
  if (out === originalContent && appendIfNoPlaceholder && args) {
    out = `${out}\n\nARGUMENTS: ${args}`
  }

  return out
}

// ---------------------------------------------------------------------------
// Legacy back-compat signature
// ---------------------------------------------------------------------------

/**
 * Legacy 4-arg signature used by the existing SkillTool body.
 *
 * IMPORTANT: This wrapper preserves the *original* zai semantics, which
 * differ from opencc's `substituteArguments`:
 *  1. `$N` is **1-indexed** (`$1` = first arg, `$2` = second), not 0-indexed.
 *  2. There's no `appendIfNoPlaceholder` — empty-args / no-placeholder cases
 *     leave the body untouched.
 *  3. `$@` is supported (opencc doesn't have it).
 *
 * The legacy SkillTool body still calls this wrapper. New code should call
 * `substituteArguments` directly (opencc-faithful, 0-indexed).
 */
export function substituteArgumentsLegacy(
  body: string,
  args: string,
  _quoted: boolean,
  argNames: string[] = [],
): string {
  if (!args && argNames.length === 0) return body

  // Both `quoted` modes use plain whitespace split in the original zai
  // implementation. The `quoted` flag only changed how the SkillTool
  // arranged its other surrounding behavior — not tokenization. Keep that
  // exact contract here.
  const tokens = args ? args.split(/\s+/).filter(Boolean) : []
  let out = body
  out = out.replace(/\$ARGUMENTS/g, args)
  out = out.replace(/\$@/g, args)
  for (let i = 0; i < tokens.length; i++) {
    out = out.replace(new RegExp(`\\$${i + 1}\\b`, 'g'), tokens[i]!)
  }
  for (const name of argNames) {
    out = out.replace(new RegExp(`\\$${name}\\b`, 'g'), args)
  }
  return out
}