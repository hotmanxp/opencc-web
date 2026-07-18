import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import type { LegacyTool } from '../Tool.js'
import { FileEditInputSchema, type FileEditInput } from './schema.js'
import { renderPrompt } from './prompt.js'
import { lastRead } from '../readState.js'
import {
  findActualString,
  preserveQuoteStyle,
  applyEditToFile,
  MAX_EDIT_FILE_SIZE,
} from './utils.js'

const NOTEBOOK_EDIT_BLOCKED =
  'File is a Jupyter Notebook. Use the NotebookEditTool to edit this file.'

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

export const FileEditTool: LegacyTool<typeof FileEditInputSchema, string> = {
  name: 'Edit',
  description: renderPrompt(),
  inputSchema: FileEditInputSchema,
  isDestructive: () => true,

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
        return { output: `File created successfully at: ${absPath}` }
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
      const found = findActualString(originalContent, input.old_string)
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

    const replaced = replaceAll ? matches : 1
    if (input.old_string === '' && matches === 0) {
      return { output: `The file ${absPath} has been updated successfully.` }
    }
    return { output: `Replaced ${replaced} occurrence(s) in ${absPath}` }
  },
}
