import { readFile, stat } from 'fs/promises'
import { isAbsolute, resolve, basename } from 'path'
import type { LegacyTool } from '../Tool.js'
import { FileReadInputSchema, type FileReadInput } from './schema.js'
import { renderPrompt } from './prompt.js'
import { markRead } from '../readState.js'
import {
  findSimilarFile,
  suggestPathUnderCwd,
  getFileModificationTimeAsync,
  FILE_NOT_FOUND_CWD_NOTE,
} from './fileUtils.js'
import { FILE_UNCHANGED_STUB } from './constants.js'

const MAX_LINES_DEFAULT = 2000

/**
 * Device files that would hang the process (infinite output / blocking input).
 * Path-based check (no I/O). Mirrors opencc FileReadTool.BLOCKED_DEVICE_PATHS.
 * Safe devices like /dev/null are intentionally omitted.
 */
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true
  return false
}

// Narrow no-break space (U+202F) used by some macOS versions in screenshot
// filenames. Matches opencc FileReadTool.getAlternateScreenshotPath.
const THIN_SPACE = String.fromCharCode(8239)
function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = basename(filePath)
  const match = filename.match(/^(.+)([ \u202F])(AM|PM)(\.png)$/)
  if (!match) return undefined
  const currentSpace = match[2]
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' '
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  )
}

/**
 * Capability detection — zai doesn't bundle sharp / poppler-utils, so PDF /
 * image / notebook rich output is opt-in. Text read is always supported.
 * Keep these exported so callers (UI / tests) can probe support.
 */
export function isImageProcessingAvailable(): boolean {
  // zai currently ships without sharp; if you `bun add sharp`, flip this.
  return false
}
export function isPDFSupportAvailable(): boolean {
  // zai currently ships without poppler-utils; if installed, flip this.
  return false
}
function isNotebookSupportAvailable(): boolean {
  // .ipynb parsing uses Node built-ins only, but we keep the flag for symmetry
  // with the opencc pattern so callers can feature-detect.
  return true
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const PDF_EXTENSIONS = new Set(['pdf'])
const NOTEBOOK_EXTENSIONS = new Set(['ipynb'])

/**
 * Resolve a file path to an absolute path. LegacyTool contract only gives
 * us `ctx.cwd`, so we do the relative-to-cwd resolution here.
 */
function resolveAbsPath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
}

/**
 * Read the file content with offset/limit applied.
 * Note: zai keeps 0-based offset (opencc uses 1-based). The schema comment
 * documents this divergence.
 */
async function readTextSlice(
  absPath: string,
  offset: number,
  limit: number,
): Promise<string> {
  const content = await readFile(absPath, 'utf-8')
  const allLines = content.split('\n')
  const slice = allLines.slice(offset, offset + limit)
  return slice.map((line, i) => `${offset + i}: ${line}`).join('\n')
}

export const FileReadTool: LegacyTool<typeof FileReadInputSchema, string> = {
  name: 'Read',
  description: renderPrompt(),
  inputSchema: FileReadInputSchema,
  isReadOnly: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as FileReadInput
    const absPath = resolveAbsPath(input.file_path, ctx.cwd)
    const offset = input.offset ?? 0
    const limit = input.limit ?? MAX_LINES_DEFAULT

    // ---- Path-only validation (no I/O) ----
    if (isBlockedDevicePath(absPath)) {
      return {
        output: `Cannot read '${input.file_path}': this device file would block or produce infinite output.`,
        isError: true,
      }
    }

    // ---- Capability-gated rich content (image / PDF / notebook) ----
    const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext) && !isImageProcessingAvailable()) {
      return {
        output: `Image support is not enabled in zai. Install sharp (or set ZAI_ENABLE_IMAGE_READ=1) to read images.`,
        isError: true,
      }
    }
    if (PDF_EXTENSIONS.has(ext) && !isPDFSupportAvailable()) {
      return {
        output: `PDF support is not enabled in zai. Install poppler-utils (or set ZAI_ENABLE_PDF_READ=1) to read PDFs.`,
        isError: true,
      }
    }
    if (NOTEBOOK_EXTENSIONS.has(ext) && !isNotebookSupportAvailable()) {
      return {
        output: `Notebook support is not enabled in zai.`,
        isError: true,
      }
    }

    // ---- file_unchanged dedup ----
    // If we read this exact (offset, limit) within the last few calls and
    // the file's mtime hasn't changed, return a stub. Mirrors opencc's
    // `readFileState` dedup path — zai's readState is mtime-only (no content
    // stored), so we use the lastRead mtime as the dedup signal.
    const previousMtime = ctx.state?.['__lastReadMtime_'+absPath] as
      | { mtimeMs: number; offset: number; limit: number }
      | undefined
    if (
      previousMtime &&
      previousMtime.offset === offset &&
      previousMtime.limit === limit
    ) {
      try {
        const currentMtime = await getFileModificationTimeAsync(absPath)
        if (Math.floor(currentMtime) === previousMtime.mtimeMs) {
          return { output: FILE_UNCHANGED_STUB }
        }
      } catch {
        // stat failed — fall through to full read
      }
    }

    // ---- macOS thin-space screenshot fallback ----
    // Some macOS versions use U+202F before AM/PM; if the path doesn't exist,
    // try the alternate-space variant.
    const tryPaths: string[] = [absPath]
    const alt = getAlternateScreenshotPath(absPath)
    if (alt && alt !== absPath) tryPaths.push(alt)

    let content: string | null = null
    let usedPath = absPath
    for (const p of tryPaths) {
      try {
        content = await readTextSlice(p, offset, limit)
        usedPath = p
        break
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') {
          continue
        }
        return {
          output: `Failed to read ${absPath}: ${err.message}`,
          isError: true,
        }
      }
    }

    if (content === null) {
      // ---- ENOENT: try to suggest a similar file / cwd-relative path ----
      const similarFilename = await findSimilarFile(absPath)
      const cwdSuggestion = await suggestPathUnderCwd(absPath, ctx.cwd)
      let message = `File not found: ${absPath}. ${FILE_NOT_FOUND_CWD_NOTE} ${ctx.cwd}.`
      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }
      return { output: message, isError: true }
    }

    // ---- Persist mtime + dedup snapshot ----
    try {
      const s = await stat(usedPath)
      markRead(ctx.cwd, usedPath, s.mtimeMs)
      if (ctx.state) {
        ctx.state['__lastReadMtime_'+usedPath] = {
          mtimeMs: Math.floor(s.mtimeMs),
          offset,
          limit,
        }
      }
    } catch {
      // stat can race with concurrent deletes; the read itself succeeded.
    }

    // ---- Header / truncation message ----
    // Compute total lines only when needed (cheap; we already have content).
    const total = content.split('\n').length
    const end = offset + total
    const truncated = total === limit // likely more content exists
    const header = truncated
      ? `Read ${total} lines (${offset}-${end - 1}). Use offset to read more.`
      : `Read ${total} lines (${total} total).`

    return { output: `${header}\n${content}` }
  },
}