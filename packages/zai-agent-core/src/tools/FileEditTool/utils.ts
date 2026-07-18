/**
 * Quote + edit-application helpers ported from upstream OpenCC's
 * `opencc-worktree/src/tools/FileEditTool/utils.ts`. We keep only the slice
 * the Edit tool itself needs (no notebook / streaming / patch-utils / patch
 * snippets), and we deliberately drop TUI-only fanciness.
 *
 * All quote helpers target the *typography* round-trip that breaks when
 * Claude emits straight quotes / model-output content uses curly quotes.
 */

export const LEFT_SINGLE_CURLY_QUOTE = '\u2018'
export const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'
export const LEFT_DOUBLE_CURLY_QUOTE = '\u201c'
export const RIGHT_DOUBLE_CURLY_QUOTE = '\u201d'

/**
 * Curly → straight quote normalization. Claude's output uses ASCII `"`/`'`
 * exclusively, but real-world files (especially Markdown / docs) embed curly
 * variants. Without this, a model query for `"foo"` misses `'foo'` in the
 * target file.
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * When the file uses curly quotes but the model's old_string uses straight
 * quotes (or vice versa), this returns the verbatim slice actually in the
 * file at the match location, so we can apply the replacement against the
 * real file bytes rather than the normalized form.
 *
 * Returns null when no match is found even after quote normalization.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString
  }
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex === -1) {
    return null
  }
  return fileContent.substring(searchIndex, searchIndex + searchString.length)
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em dash
    prev === '\u2013' // en dash
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // Don't convert apostrophes in contractions: "don't", "it's" — both
      // sides are letters, treat as apostrophe (right single curly).
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * If the file uses curly quotes but the model's new_string uses straight
 * quotes, mirror the file's typography. No-op when no normalization happened.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString
  }
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }
  let result = newString
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result)
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result)
  return result
}

/**
 * Apply one edit in-memory. Mirrors upstream's applyEditToFile semantics,
 * including the `newString === ''` corner case where stripping a trailing
 * newline alongside the matched region prevents a leftover empty line.
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)
  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }
  // Deletion case: if file has "<oldString>\n" remove that too, otherwise the
  // deletion leaves a dangling empty line behind.
  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')
  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

/**
 * Strip trailing whitespace from each line while preserving the line-ending
 * characters themselves. Mirrors upstream's stripTrailingWhitespace.
 */
export function stripTrailingWhitespace(str: string): string {
  const parts = str.split(/(\r\n|\n|\r)/)
  let result = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    if (i % 2 === 0) {
      // Even indices are line content — strip trailing whitespace
      result += part.replace(/\s+$/, '')
    } else {
      // Odd indices are line endings — preserve verbatim
      result += part
    }
  }
  return result
}

/**
 * Hard ceiling on file size the Edit tool will attempt to modify. Mirrors
 * upstream's MAX_EDIT_FILE_SIZE = 1 GiB (stat bytes). Going beyond this risks
 * OOM on read-modify-write since we hold the file in memory.
 */
export const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024
