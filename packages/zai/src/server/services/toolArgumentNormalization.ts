/**
 * Tool argument normalization — ported from OpenCC's openaiShim.
 *
 * Background — string-arg tools:
 * OpenCC upstream (`services/api/toolArgumentNormalization.ts`) marks tools
 * whose input is dominated by a single string field (Write/Bash/Read/Edit/
 * Glob/Grep) and treats them differently on truncation:
 *
 *   1. While streaming, deltas for these tools are buffered until the
 *      finish_reason arrives. Eagerly emitting each delta lets the consumer
 *      attempt JSON.parse on a half-formed literal — which can succeed by
 *      accident when the buffer ends mid-key (the JSON_REPAIR_SUFFIXES path
 *      appends `"}` and produces a syntactically valid object whose `content`
 *      or `command` is the half-string). For Write/Bash that means writing
 *      garbage to disk before any error surfaces.
 *
 *   2. On `finish_reason='length'`, the raw buffer is normalized via
 *      `normalizeToolArguments`: if it looks like a structured object literal
 *      but won't parse, return `{}` so the downstream zod schema rejects it
 *      with a clean "Required" error (loud failure). Otherwise wrap the raw
 *      string under the tool's field name — that always fails zod for a
 *      string-arg tool but keeps the buffer round-trippable for tools that
 *      accept arbitrary strings (Bash's `command` actually passes zod, but
 *      the wrapped value preserves enough for an explicit error message).
 *
 * zai: only the helper is needed here. The "buffer until stop" / "eager
 * emit" branch lives in `chunksToAnthropicEvents` (see openaiClient.ts).
 */

/**
 * Own-key lookup to avoid Object.prototype pollution. `toolName in obj` or
 * plain indexing would leak inherited keys like `constructor`, `toString`,
 * `valueOf` as truthy fallbacks.
 */
const STRING_ARGUMENT_TOOL_FIELDS: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
}

export function hasToolFieldMapping(toolName: string): boolean {
  return Object.hasOwn(STRING_ARGUMENT_TOOL_FIELDS, toolName)
}

function getPlainStringToolArgumentField(toolName: string): string | null {
  return Object.hasOwn(STRING_ARGUMENT_TOOL_FIELDS, toolName)
    ? STRING_ARGUMENT_TOOL_FIELDS[toolName]!
    : null
}

function isBlankString(value: string): boolean {
  return value.trim().length === 0
}

function isLikelyStructuredObjectLiteral(value: string): boolean {
  // Match object-like patterns: {"key":, {key:, {'key':, { "key" :, etc.
  // But NOT bash compound commands like { pwd; } or { echo hi; }
  return /^\s*\{\s*['"]?\w+['"]?\s*:/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wrapPlainStringToolArguments(
  toolName: string,
  value: string,
): Record<string, string> | null {
  const field = getPlainStringToolArgumentField(toolName)
  if (!field) return null
  return { [field]: value }
}

/**
 * Normalize a raw `tool_calls[].function.arguments` buffer for a tool whose
 * input is dominated by a single string field.
 *
 * Returns one of:
 *   - An object parsed from `rawArguments` if it was valid JSON
 *   - `{ [field]: rawArguments }` if the buffer looks like a bare string
 *     (wrapping it under the tool's primary field name preserves the
 *     round-trippable raw text for diagnostics while zod rejects it)
 *   - `{}` if the buffer looks structured but is unrecoverable (e.g.
 *     truncated mid-string). Returning `{}` makes the downstream zod
 *     validation throw "Required" loudly rather than writing a half file.
 *
 * Critically: this function NEVER returns a partially-repaired literal
 * object. The previous zai behavior of appending `"}` to a buffer that ends
 * mid-string silently produced `{ content: "<half string>" }` which then
 * passed zod and was written to disk. That is the bug this port prevents.
 */
export function normalizeToolArguments(
  toolName: string,
  rawArguments: string | undefined,
): unknown {
  if (rawArguments === undefined) return {}

  try {
    const parsed = JSON.parse(rawArguments)
    if (isRecord(parsed)) {
      return parsed
    }
    // Parsed as a non-object JSON value (string, number, boolean, null, array)
    if (typeof parsed === 'string' && !isBlankString(parsed)) {
      return wrapPlainStringToolArguments(toolName, parsed) ?? parsed
    }
    return parsed
  } catch {
    // rawArguments is not valid JSON — treat as a plain string
    if (isBlankString(rawArguments) || isLikelyStructuredObjectLiteral(rawArguments)) {
      // Blank or looks like a malformed object literal — don't wrap into
      // a tool field; let zod reject as missing required fields.
      return {}
    }
    return wrapPlainStringToolArguments(toolName, rawArguments) ?? {}
  }
}