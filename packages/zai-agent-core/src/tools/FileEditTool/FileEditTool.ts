import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import type { LegacyTool } from '../Tool.js'
import {
  FileEditInputSchema,
  type FileEditInput,
  type FileEditOutput,
} from './schema.js'
import { renderPrompt } from './prompt.js'
import { lastRead } from '../readState.js'
import {
  adjustNewStringIndentation,
  areFileEditsInputsEquivalent,
  desanitizeMatchString,
  findActualString,
  findWhitespaceAgnosticMatch,
  MAX_EDIT_FILE_SIZE,
  preserveQuoteStyle,
  applyEditToFile,
} from './utils.js'

const NOTEBOOK_EDIT_BLOCKED =
  'File is a Jupyter Notebook. Use the NotebookEditTool to edit this file.'

/**
 * Deny-rule support is opt-in. zai's LegacyToolContext has no
 * toolPermissionContext slot; when the env flag is set we attempt to import
 * the opencc-internals permission matcher lazily so this module stays usable
 * in builds that don't ship permission code. Mirrors FileWriteTool's gate.
 */
const PERMISSION_DENY_RULES_ENABLED =
  process.env.ZAI_ENABLE_PERMISSION_DENY_RULES === '1' ||
  process.env.ZAI_ENABLE_PERMISSION_DENY_RULES === 'true'

type Encoding = 'utf8' | 'utf16le'

/** Probe BOM (utf-16le ff fe / utf-8 ef bb bf) and CRLF/CR/LF majority. */
function detectEncoding(buf: Buffer): Encoding {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  return 'utf8'
}

/**
 * Read file as Buffer + BOM-stripped string. Encoding is detected but
 * line-endings are not separately persisted — applyEditToFile preserves
 * whatever newlines the model's new_string contains, which is what upstream
 * opted into (full content replacement, model owns line endings).
 */
async function readFileForEdit(absPath: string): Promise<{
  buf: Buffer
  content: string
  encoding: Encoding
  size: number
}> {
  const buf = await readFile(absPath)
  const encoding = detectEncoding(buf)
  let content: string
  if (encoding === 'utf16le') {
    // Skip the 2-byte BOM
    content = buf.subarray(2).toString('utf16le')
  } else {
    // Skip the 3-byte UTF-8 BOM if present
    content =
      buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.subarray(3).toString('utf8')
        : buf.toString('utf8')
  }
  return { buf, content, encoding, size: buf.byteLength }
}

/**
 * Render the user-facing string we put into the model's `tool_result` block.
 * Mirrors upstream's `mapToolResultToToolResultBlockParam` so the assistant
 * sees consistent create/update/replace-all messages regardless of where the
 * Edit tool is invoked.
 */
function renderToolResultContent(
  type: 'create' | 'update',
  filePath: string,
  replaced: number,
  replaceAll: boolean,
): string {
  if (type === 'create') {
    return `File created successfully at: ${filePath}`
  }
  if (replaceAll) {
    return `The file ${filePath} has been updated successfully. All occurrences were successfully replaced.`
  }
  if (replaced > 1) {
    return `The file ${filePath} has been updated successfully. Replaced ${replaced} occurrence(s).`
  }
  return `The file ${filePath} has been updated successfully.`
}

export const FileEditTool: LegacyTool<typeof FileEditInputSchema, string> = {
  name: 'Edit',
  description: renderPrompt(),
  inputSchema: FileEditInputSchema,
  isDestructive: () => true,

  /**
   * Semantic check mirroring upstream validateInput. Catches deny-rule / UNC
   * / .ipynb / same-string / mtime-staleness / uniqueness problems early so
   * the runtime can surface them without invoking the destructive path. The
   * runtime still keeps the same checks in `call()` as a defensive fallback.
   */
  validateInput: async (rawInput: unknown, ctx) => {
    const input = rawInput as FileEditInput
    if (typeof input?.file_path !== 'string') {
      return { result: false, message: 'file_path is required', errorCode: 0 }
    }
    if (typeof input?.old_string !== 'string') {
      return { result: false, message: 'old_string is required', errorCode: 0 }
    }
    if (typeof input?.new_string !== 'string') {
      return { result: false, message: 'new_string is required', errorCode: 0 }
    }
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)

    // Same-string guard (mirrors upstream errorCode 1)
    if (input.old_string === input.new_string) {
      return {
        result: false,
        message: 'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
      }
    }

    // Deny rule (env-gated)
    if (PERMISSION_DENY_RULES_ENABLED) {
      try {
        const mod = (await import(
          '../../opencc-internals/utils/permissions/filesystem.js' as string
        ).catch(() => null)) as null | Record<string, unknown>
        if (mod && typeof mod.matchingRuleForInput === 'function') {
          const matched = await (mod.matchingRuleForInput as (
            p: string,
            c: unknown,
            a: string,
            b: string,
          ) => Promise<unknown>)(absPath, {}, 'edit', 'deny')
          if (matched !== null) {
            return {
              result: false,
              message:
                'File is in a directory that is denied by your permission settings.',
              errorCode: 2,
            }
          }
        }
      } catch {
        // Silent skip — env gate already required for activation.
      }
    }

    // UNC path short-circuit (mirrors upstream). Don't touch the filesystem
    // on // or \\ paths to avoid NTLM credential leakage.
    if (absPath.startsWith('\\\\') || absPath.startsWith('//')) {
      return { result: true }
    }

    // .ipynb redirect
    if (absPath.endsWith('.ipynb')) {
      return {
        result: false,
        message: NOTEBOOK_EDIT_BLOCKED,
        errorCode: 5,
      }
    }

    // Existence + size + read-first + mtime + uniqueness are checked in
    // call() since they all need the on-disk content. Returning
    // `{result: true}` here just means the deny-rule + same-string + UNC
    // preconditions pass.
    return { result: true }
  },

  /**
   * Adapter-transparent inputs-equivalence hook (opencc `Tool.inputsEquivalent`).
   * Two Edit calls are equivalent iff they'd produce the same post-edit file
   * content (modulo whitespace the LLM might have hallucinated). Used by the
   * runtime to coalesce redundant invocations inside the same turn.
   */
  inputsEquivalent: (a: unknown, b: unknown): boolean => {
    const x = a as FileEditInput
    const y = b as FileEditInput
    return areFileEditsInputsEquivalent(
      {
        file_path: x.file_path,
        edits: [
          {
            old_string: x.old_string,
            new_string: x.new_string,
            replace_all: x.replace_all ?? false,
          },
        ],
      },
      {
        file_path: y.file_path,
        edits: [
          {
            old_string: y.old_string,
            new_string: y.new_string,
            replace_all: y.replace_all ?? false,
          },
        ],
      },
    )
  },

  /**
   * Render the model's `tool_result` block content from the structured
   * output emitted by `call()`. Distinguishes create vs update and
   * replace_all vs single-shot for parity with upstream.
   */
  mapToolResultToToolResultBlockParam: (content: unknown, toolUseId: string) => {
    let parsed: Partial<FileEditOutput> = {}
    if (typeof content === 'string') {
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = {}
      }
    } else if (content && typeof content === 'object') {
      parsed = content as Partial<FileEditOutput>
    }
    const filePath = parsed.filePath ?? ''
    const replaceAll = parsed.replaceAll ?? false
    const replaced =
      parsed.oldString === '' ? 0 : parsed.oldString === parsed.newString ? 0 : 1
    const type: 'create' | 'update' =
      parsed.oldString === '' && parsed.originalFile === ''
        ? 'create'
        : 'update'
    return {
      tool_use_id: toolUseId,
      type: 'tool_result',
      content: renderToolResultContent(type, filePath, replaced, replaceAll),
    }
  },

  async call(rawInput, ctx) {
    const input = rawInput as FileEditInput
    const absPath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(ctx.cwd, input.file_path)
    const replaceAll = input.replace_all ?? false

    // --- pre-flight (allows awaits, no file write yet) ---
    let fileExists = true
    let fileSize = 0
    let fileMtimeMs = 0
    try {
      const s = await stat(absPath)
      fileSize = s.size
      fileMtimeMs = s.mtimeMs
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        fileExists = false
      } else {
        return { output: `Failed to access ${absPath}: ${err.message}`, isError: true }
      }
    }

    // .ipynb redirect — defensive copy of validateInput errorCode 5.
    if (fileExists && absPath.endsWith('.ipynb')) {
      return { output: NOTEBOOK_EDIT_BLOCKED, isError: true }
    }

    if (fileExists && fileSize > MAX_EDIT_FILE_SIZE) {
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(0)
      return {
        output: `File is too large to edit (${sizeMB} MiB). Maximum editable file size is 1024 MiB.`,
        isError: true,
      }
    }

    // Same-string guard — defensive copy of validateInput errorCode 1.
    if (input.old_string === input.new_string) {
      return {
        output: 'No changes to make: old_string and new_string are exactly the same.',
        isError: true,
      }
    }

    // Read-first / mtime staleness — mirrors upstream validateInput errorCodes 6 / 7.
    if (fileExists) {
      const recorded = lastRead(ctx.cwd, absPath)
      if (recorded === undefined) {
        return {
          output: 'File has not been read yet. Read it first before writing to it.',
          isError: true,
        }
      }
      const lastWriteTime = Math.floor(fileMtimeMs)
      if (lastWriteTime > recorded) {
        return {
          output:
            'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
          isError: true,
        }
      }
    }

    // --- critical section: read file once + write once, no awaits in between ---
    let originalContent = ''
    let encoding: Encoding = 'utf8'
    try {
      const r = await readFileForEdit(absPath)
      originalContent = r.content
      encoding = r.encoding
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        return { output: `Failed to read ${absPath}: ${err.message}`, isError: true }
      }
      // file disappeared between stat and read — treat as create path below
      fileExists = false
    }

    if (!fileExists) {
      // Upstream: empty old_string on a non-existent file = create. Anything
      // else = "File does not exist".
      if (input.old_string === '') {
        // Ensure parent dir then write new_string.
        try {
          await mkdir(dirname(absPath), { recursive: true })
          await writeFile(absPath, input.new_string, 'utf-8')
        } catch (e) {
          return { output: `Failed to write ${absPath}: ${(e as Error).message}`, isError: true }
        }
        const output: FileEditOutput = {
          filePath: absPath,
          oldString: '',
          newString: input.new_string,
          originalFile: '',
          structuredPatch: [],
          userModified: false,
          replaceAll: false,
        }
        return { output: JSON.stringify(output) }
      }
      return {
        output: `File does not exist. Note: your current working directory is ${ctx.cwd}.`,
        isError: true,
      }
    }

    // File exists. Empty old_string means "create new file" — but the file
    // already exists, so refuse (mirrors upstream errorCode 3).
    if (input.old_string === '') {
      if (originalContent.trim() === '') {
        // Empty file with empty old_string = valid (replacing empty with content)
      } else {
        return {
          output: 'Cannot create new file - file already exists.',
          isError: true,
        }
      }
    }

    // Quote-aware matching (curly ↔ straight quote round-trip). Empty
    // old_string path is special-cased above (create vs already-exists);
    // skip findActualString for it — empty string trivially matches itself.
    let actualOldString = input.old_string
    if (input.old_string !== '') {
      let found = findActualString(originalContent, input.old_string)
      if (!found) {
        // Try de-sanitize (the API may have stripped tokens Claude can't see)
        const { result: desanitized } = desanitizeMatchString(input.old_string)
        if (desanitized !== input.old_string) {
          found = findActualString(originalContent, desanitized)
          if (found) {
            // Mutate input.new_string with the same replacements so the
            // de-sanitized form lands in the file. We rebuild new_string via
            // a second pass through desanitizeMatchString on the existing
            // new_string — same logic, same replacements table.
            const { result: desanitizedNew } = desanitizeMatchString(
              input.new_string,
            )
            input.new_string = desanitizedNew
          }
        }
      }
      if (!found) {
        // Fall back to whitespace-agnostic match. Common when the LLM
        // hallucinated per-line indentation that doesn't match the file.
        const isMarkdown = /\.mdx?$/i.test(absPath)
        const fuzzy = findWhitespaceAgnosticMatch(
          originalContent,
          input.old_string,
          isMarkdown,
        )
        if (fuzzy) {
          const adjusted = adjustNewStringIndentation(
            input.old_string,
            fuzzy,
            input.new_string,
          )
          if (adjusted !== null) {
            found = fuzzy
            input.new_string = adjusted
          }
        }
      }
      if (!found) {
        return {
          output: `String to replace not found in file.\nString: ${input.old_string}`,
          isError: true,
        }
      }
      actualOldString = found
    }

    // When input.old_string === '' (and we passed the empty-file check above)
    // skip uniqueness counting — we're substituting the entire file content.
    let matches = 0
    if (input.old_string !== '') {
      matches = originalContent.split(actualOldString).length - 1
      if (matches === 0) {
        return {
          output: `String to replace not found in file.\nString: ${input.old_string}`,
          isError: true,
        }
      }
      if (matches > 1 && !replaceAll) {
        return {
          output: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${input.old_string}`,
          isError: true,
        }
      }
    }

    const actualNewString = preserveQuoteStyle(
      input.old_string,
      actualOldString,
      input.new_string,
    )

    const updatedContent = applyEditToFile(
      originalContent,
      actualOldString,
      actualNewString,
      replaceAll,
    )

    try {
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, updatedContent, encoding === 'utf16le' ? 'utf16le' : 'utf8')
    } catch (e) {
      return { output: `Failed to write ${absPath}: ${(e as Error).message}`, isError: true }
    }

    // Note: `matches` (= occurrences replaced) is intentionally not surfaced
    // in the structured output today — zai's LegacyTool consumers parse the
    // legacy "Replaced N occurrence(s) in <path>" string from
    // mapToolResultToToolResultBlockParam, which we wire off `replaceAll`.
    const output: FileEditOutput = {
      filePath: absPath,
      oldString: actualOldString,
      newString: actualNewString,
      originalFile: originalContent,
      structuredPatch: [],
      userModified: false,
      replaceAll: replaceAll,
    }
    return { output: JSON.stringify(output) }
  },
}
