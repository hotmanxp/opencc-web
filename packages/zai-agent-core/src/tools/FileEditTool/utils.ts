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

// ---------------------------------------------------------------------------
// Whitespace-agnostic matching helpers (ported from upstream opencc
// `tools/FileEditTool/utils.ts` — findWhitespaceAgnosticMatch /
// adjustNewStringIndentation / desanitizeMatchString). These let the Edit tool
// recover from mismatches when the model hallucinates indentation differences
// from the real file content (common with Markdown / deeply nested code).
// ---------------------------------------------------------------------------

const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

/**
 * Normalize a match string by reversing the sanitization done before the model
 * sees it (since Claude can't see the original tokens). Returns the result plus
 * a record of which replacements actually fired so the new_string can be
 * rewritten with the same substitutions.
 */
export function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)
    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

/**
 * Normalize leading indentation in a string for whitespace-agnostic
 * comparison. Keeps inline whitespace verbatim (so we don't corrupt regex
 * literals / string content) but drops leading per-line indentation, since
 * that's the most common hallucination source.
 *
 * Returns the normalized form plus a `mapping[]` array where
 * `mapping[normalizedIndex] = originalIndex`, letting us translate a match
 * back to the original byte offsets.
 */
function normalizeIndentation(
  str: string,
  isMarkdown: boolean,
): { normalized: string; mapping: number[] } {
  let normalized = ''
  const mapping: number[] = []

  let i = 0
  while (i < str.length) {
    const ch = str[i]!
    if (ch === '\n' || ch === '\r') {
      normalized += ch
      mapping.push(i)
      i++
      continue
    }
    if (ch === ' ' || ch === '\t') {
      const startWs = i
      while (i < str.length) {
        const c = str[i]!
        if (c !== ' ' && c !== '\t') break
        i++
      }
      const isLeading =
        startWs === 0 ||
        str[startWs - 1] === '\n' ||
        str[startWs - 1] === '\r'
      const isTrailing = i === str.length || str[i] === '\n' || str[i] === '\r'

      if (isLeading) {
        // Drop leading indentation — boundary logic recovers the real one.
      } else if (isTrailing && !isMarkdown) {
        // Drop trailing whitespace outside Markdown (which uses 2-space hard breaks).
      } else {
        for (let k = startWs; k < i; k++) {
          normalized += str[k]
          mapping.push(k)
        }
      }
      continue
    }
    normalized += ch
    mapping.push(i)
    i++
  }
  return { normalized, mapping }
}

/**
 * Find a substring in `fileContent` matching `searchString` modulo
 * per-line leading indentation. Returns the verbatim slice from
 * `fileContent` so we can do a clean .replace() against it, or null if no
 * unique match exists.
 *
 * Markdown files opt out of trailing-whitespace collapsing because the
 * two-space hard-break syntax is load-bearing.
 */
export function findWhitespaceAgnosticMatch(
  fileContent: string,
  searchString: string,
  isMarkdown = false,
): string | null {
  const search = normalizeIndentation(searchString, isMarkdown)
  if (search.normalized.trim().length === 0) return null

  const file = normalizeIndentation(fileContent, isMarkdown)
  const matchIndex = file.normalized.indexOf(search.normalized)
  if (matchIndex === -1) return null

  // Reject ambiguous matches — replacing two different blocks would be unsafe.
  const nextMatchIndex = file.normalized.indexOf(
    search.normalized,
    matchIndex + 1,
  )
  if (nextMatchIndex !== -1) return null

  const originalStart = file.mapping[matchIndex]
  const originalEnd = file.mapping[matchIndex + search.normalized.length - 1]
  if (originalStart === undefined || originalEnd === undefined) return null

  let start = originalStart
  let end = originalEnd

  // Mirror leading whitespace from the caller so we don't duplicate/misplace
  // indentation when the search starts with whitespace.
  if (/^[ \t]/.test(searchString)) {
    while (start > 0 && /[ \t]/.test(fileContent[start - 1]!)) start--
  } else if (/^\s/.test(searchString)) {
    while (start > 0 && /\s/.test(fileContent[start - 1]!)) start--
  }

  // Trailing boundary: don't bleed into the next line's indentation if the
  // caller ends with a newline.
  if (/(?:\r?\n)$/.test(searchString)) {
    while (end > start && /[ \t]/.test(fileContent[end]!)) end--
  } else if (/[ \t]$/.test(searchString)) {
    while (end + 1 < fileContent.length && /[ \t]/.test(fileContent[end + 1]!))
      end++
  } else if (/\s$/.test(searchString)) {
    while (end + 1 < fileContent.length && /\s/.test(fileContent[end + 1]!))
      end++
  }

  return fileContent.substring(start, end + 1)
}

/**
 * Rewrite the absolute indentation of `newString` to match the true file
 * indentation discovered via `fileMatch` (the whitespace-agnostic hit). This
 * stops the model from accidentally over-/under-indenting the replacement
 * block when its old_string hallucinated different nesting.
 *
 * Returns `null` if the same hallucinated indent maps to two different actual
 * indents — that means the LLM fused lines from different structural blocks
 * and re-indenting would corrupt the file.
 */
export function adjustNewStringIndentation(
  oldString: string,
  fileMatch: string,
  newString: string,
): string | null {
  if (oldString === fileMatch) return newString

  const oldNorm = normalizeIndentation(oldString, false)
  const actualNorm = normalizeIndentation(fileMatch, false)

  const matchIndex = actualNorm.normalized.indexOf(oldNorm.normalized)
  if (matchIndex === -1) return newString

  const indentMap = new Map<string, string>()
  const oldLines = oldString.split('\n')
  let oldCharIndex = 0

  for (let i = 0; i < oldLines.length; i++) {
    const line = oldLines[i]!
    const indentMatch = line.match(/^[ \t]*/)
    const oldIndent = indentMatch ? indentMatch[0] : ''
    const nonWsMatch = line.match(/\S/)
    if (!nonWsMatch) {
      oldCharIndex += line.length + 1
      continue
    }
    const nonWsIndexInLine = nonWsMatch.index!
    const nonWsIndexInOldString = oldCharIndex + nonWsIndexInLine

    let normIndex = -1
    for (let k = 0; k < oldNorm.mapping.length; k++) {
      if (oldNorm.mapping[k] === nonWsIndexInOldString) {
        normIndex = k
        break
      }
    }

    if (normIndex !== -1) {
      const actualNormIndex = matchIndex + normIndex
      if (actualNormIndex < actualNorm.mapping.length) {
        const actualCharIndex = actualNorm.mapping[actualNormIndex]!

        let startOfLine = actualCharIndex
        while (startOfLine > 0 && fileMatch[startOfLine - 1] !== '\n') {
          startOfLine--
        }

        let actualIndent = ''
        for (let k = startOfLine; k < actualCharIndex; k++) {
          const c = fileMatch[k]!
          if (c === ' ' || c === '\t') actualIndent += c
          else break
        }

        const existingIndent = indentMap.get(oldIndent)
        if (existingIndent !== undefined && existingIndent !== actualIndent) {
          // Same hallucinated indent → different actual indent = merged blocks. Refuse.
          return null
        }
        indentMap.set(oldIndent, actualIndent)
      }
    }
    oldCharIndex += line.length + 1
  }

  if (indentMap.size === 0) return newString

  const newLines = newString.split('\n')
  const adjustedLines = newLines.map(line => {
    if (line.trim() === '') return line
    const indentMatch = line.match(/^[ \t]*/)
    const newIndent = indentMatch ? indentMatch[0] : ''

    if (indentMap.has(newIndent)) {
      return indentMap.get(newIndent)! + line.slice(newIndent.length)
    }

    // Unknown indent depth — extend from the longest known prefix we have a
    // mapping for, preserving the relative whitespace the model added.
    let longestPrefix = ''
    let mappedPrefix = ''
    for (const [oldInd, actualInd] of indentMap.entries()) {
      if (
        newIndent.startsWith(oldInd) &&
        oldInd.length > longestPrefix.length
      ) {
        longestPrefix = oldInd
        mappedPrefix = actualInd
      }
    }
    if (longestPrefix !== '') {
      const remaining = newIndent.slice(longestPrefix.length)
      return mappedPrefix + remaining + line.slice(newIndent.length)
    }
    return line
  })

  return adjustedLines.join('\n')
}

// ---------------------------------------------------------------------------
// `inputsEquivalent` helper — used by the adapter to detect two tool invocations
// that would produce identical file edits, so the runtime can dedupe them.
// Mirrors upstream opencc `areFileEditsInputsEquivalent`.
// ---------------------------------------------------------------------------

type FileEditForEquiv = {
  old_string: string
  new_string: string
  replace_all: boolean
}

/**
 * Compare two sets of edits by applying them in-memory and comparing the
 * resulting file content. Both sets are applied against `originalContent`;
 * if both throw the same error, they're considered equivalent.
 */
function areFileEditsEquivalent(
  edits1: FileEditForEquiv[],
  edits2: FileEditForEquiv[],
  originalContent: string,
): boolean {
  // Fast path: literal equality
  if (
    edits1.length === edits2.length &&
    edits1.every((e1, i) => {
      const e2 = edits2[i]
      return (
        e2 !== undefined &&
        e1.old_string === e2.old_string &&
        e1.new_string === e2.new_string &&
        e1.replace_all === e2.replace_all
      )
    })
  ) {
    return true
  }

  let result1: string | null = null
  let error1: string | null = null
  let result2: string | null = null
  let error2: string | null = null

  try {
    result1 = applyEdits(originalContent, edits1)
  } catch (e) {
    error1 = (e as Error).message
  }
  try {
    result2 = applyEdits(originalContent, edits2)
  } catch (e) {
    error2 = (e as Error).message
  }

  if (error1 !== null && error2 !== null) return error1 === error2
  if (error1 !== null || error2 !== null) return false
  return result1 === result2
}

function applyEdits(
  originalContent: string,
  edits: FileEditForEquiv[],
): string {
  let updated = originalContent
  for (const edit of edits) {
    const previous = updated
    updated =
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(
            updated,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )
    if (updated === previous) {
      throw new Error('String not found in file. Failed to apply edit.')
    }
  }
  if (updated === originalContent) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }
  return updated
}

/**
 * Returns true iff the two tool invocations, when applied to the same file,
 * produce identical post-edit content. Used by the runtime to coalesce
 * redundant Edit calls in a single turn.
 *
 * `fileContent` should be the on-disk content (empty string for ENOENT).
 */
export function areFileEditsInputsEquivalent(
  input1: { file_path: string; edits: FileEditForEquiv[] },
  input2: { file_path: string; edits: FileEditForEquiv[] },
  fileContent = '',
): boolean {
  if (input1.file_path !== input2.file_path) return false

  if (
    input1.edits.length === input2.edits.length &&
    input1.edits.every((e1, i) => {
      const e2 = input2.edits[i]
      return (
        e2 !== undefined &&
        e1.old_string === e2.old_string &&
        e1.new_string === e2.new_string &&
        e1.replace_all === e2.replace_all
      )
    })
  ) {
    return true
  }

  return areFileEditsEquivalent(input1.edits, input2.edits, fileContent)
}

// ---------------------------------------------------------------------------
// `getPatchForEdit` — small wrapper used by `call()` to keep parity with
// upstream's structured-patch generation. We don't currently surface the
// structured patch to the model (zai's contract is a plain string result),
// but having this lets the structured-output migration land incrementally.
// ---------------------------------------------------------------------------

export function getPatchForEdit(_args: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: unknown[]; updatedFile: string } {
  // zai returns plain-text results; no structured patch to ship today.
  // Surface a minimal stub so callers/tests can wire it up incrementally.
  return { patch: [], updatedFile: _args.fileContents }
}
