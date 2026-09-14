import type {
  Base64ImageSource,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { readFile, stat } from 'fs/promises'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
/**
 * Strips leading and trailing lines that contain only whitespace/newlines.
 * Unlike trim(), this preserves whitespace within content lines and only removes
 * completely empty lines from the beginning and end.
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split('\n')

  // Find the first non-empty line
  let startIndex = 0
  while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
    startIndex++
  }

  // Find the last non-empty line
  let endIndex = lines.length - 1
  while (endIndex >= 0 && lines[endIndex]?.trim() === '') {
    endIndex--
  }

  // If all lines are empty, return empty string
  if (startIndex > endIndex) {
    return ''
  }

  // Return the slice with non-empty lines
  return lines.slice(startIndex, endIndex + 1).join('\n')
}

/**
 * Check if content is a base64 encoded image data URL
 */
export function isImageOutput(content: string): boolean {
  return /^data:image\/[a-z0-9.+_-]+;base64,/i.test(content)
}

const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/

/**
 * Parse a data-URI string into its media type and base64 payload.
 * Input is trimmed before matching.
 */
export function parseDataUri(
  s: string,
): { mediaType: string; data: string } | null {
  const match = s.trim().match(DATA_URI_RE)
  if (!match || !match[1] || !match[2]) return null
  return { mediaType: match[1], data: match[2] }
}

/**
 * Build an image tool_result block from shell stdout containing a data URI.
 * Returns null if parse fails so callers can fall through to text handling.
 */
export function buildImageToolResult(
  stdout: string,
  toolUseID: string,
): ToolResultBlockParam | null {
  const parsed = parseDataUri(stdout)
  if (!parsed) return null
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType as Base64ImageSource['media_type'],
          data: parsed.data,
        },
      },
    ],
  }
}

// Cap file reads to 20 MB — any image data URI larger than this is
// well beyond what the API accepts (5 MB base64) and would OOM if read
// into memory.
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024

/**
 * Resize image output from a shell tool. stdout is capped at
 * getMaxOutputLength() when read back from the shell output file — if the
 * full output spilled to disk, re-read it from there, since truncated base64
 * would decode to a corrupt image that either throws here or gets rejected by
 * the API. Caps dimensions too: compressImageBuffer only checks byte size, so
 * a small-but-high-DPI PNG (e.g. matplotlib at dpi=300) sails through at full
 * resolution and poisons many-image requests (CC-304).
 *
 * Returns the re-encoded data URI on success, or null if the source didn't
 * parse as a data URI (caller decides whether to flip isImage).
 */
export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let source = stdout
  if (outputFilePath) {
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_FILE_SIZE) return null
    source = await readFile(outputFilePath, 'utf8')
  }
  const parsed = parseDataUri(source)
  if (!parsed) return null
  const buf = Buffer.from(parsed.data, 'base64')
  const ext = parsed.mediaType.split('/')[1] || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(
    buf,
    buf.length,
    ext,
  )
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  const isImage = isImageOutput(content)
  if (isImage) {
    return {
      totalLines: 1,
      truncatedContent: content,
      isImage,
    }
  }

  const maxOutputLength = getMaxOutputLength()
  if (content.length <= maxOutputLength) {
    return {
      totalLines: countCharInString(content, '\n') + 1,
      truncatedContent: content,
      isImage,
    }
  }

  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`

  return {
    totalLines: countCharInString(content, '\n') + 1,
    truncatedContent: truncated,
    isImage,
  }
}

export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

/**
 * zai patch (2026-09-14, cwd-multi-session-persistence follow-up) — STUB.
 *
 * Upstream semantics: after every foreground Bash call, if the shell cwd
 * drifted outside the allowed working directories, pull it back to
 * `originalCwd` and append "Shell cwd was reset to ..." to the tool output.
 *
 * Why zai disables it: that pull-back runs INSIDE `BashTool.call`
 * (BashTool.tsx:819-824), i.e. before the cwd-sync wrap in
 * `compat/tools/opencc/bashCwdWrap.ts` reads `ctx.cwd`. So any `cd` that
 * leaves the project subtree is undone before it can be recorded into
 * `CwdStore` → the next turn restarts at the project root and
 * "working directory persists between commands" silently stops holding
 * (`cd /tmp && pwd` → /tmp, next call `pwd` → project root).
 *
 * zai deliberately does NOT confine the shell to the project dir —
 * see docs/superpowers/specs/2026-07-19-zai-bash-cwd-tracking-design.md
 * §1.3 && §6.3 ("resetCwdIfOutsideProject — 保持 stub false(不做权限
 * 限制)"). That stub lived in the pre-opencc `zai-agent-core` tree and was
 * lost when opencc 0.20.0 was copied in as full un-stripped source
 * (commit 98ee7e5a), which brought upstream's real implementation back.
 * This restores the 2026-07-19 decision.
 *
 * The parameter is kept (and the call sites at BashTool.tsx:821 /
 * PowerShellTool.tsx:794 untouched) so the vendor diff stays one line.
 *
 * NOTE: `stdErrAppendShellResetMessage` above is now unreachable (only the
 * two reset call sites use it) and is left as-is on purpose — the vendor
 * text is never emitted while this returns false.
 */
export function resetCwdIfOutsideProject(
  _toolPermissionContext: ToolPermissionContext,
): boolean {
  return false
}

/**
 * Creates a human-readable summary of structured content blocks.
 * Used to display MCP results with images and text in the UI.
 */
export function createContentSummary(content: ContentBlockParam[]): string {
  const parts: string[] = []
  let textCount = 0
  let imageCount = 0

  for (const block of content) {
    if (block.type === 'image') {
      imageCount++
    } else if (block.type === 'text' && 'text' in block) {
      textCount++
      // Include first 200 chars of text blocks for context
      const preview = block.text.slice(0, 200)
      parts.push(preview + (block.text.length > 200 ? '...' : ''))
    }
  }

  const summary: string[] = []
  if (imageCount > 0) {
    summary.push(`[${imageCount} ${plural(imageCount, 'image')}]`)
  }
  if (textCount > 0) {
    summary.push(`[${textCount} text ${plural(textCount, 'block')}]`)
  }

  return `MCP Result: ${summary.join(', ')}${parts.length > 0 ? '\n\n' + parts.join('\n\n') : ''}`
}

/**
 * Select the best failure body for a non-zero-exit Bash command (#1231).
 *
 * Sources, in order of preference:
 *   1. `accumulatedOutput` — the truncating accumulator's view after stripping
 *      the synthetic "Exit code N" marker. Non-empty when the success-path
 *      stdout was appended into the accumulator.
 *   2. `resultStdout` — `ExecResult.stdout` from the shell runner.
 *   3. `progressFullOutput` — the most recent `fullOutput` value yielded by
 *      the streaming generator. Recovers stdout when the shell runner
 *      streamed output through progress callbacks but the final result-slot
 *      stdout was left empty (e.g. flush-after-result race, exit before EOF,
 *      output persisted to a file path).
 *
 * Returns the first source whose trimmed length is non-zero, falling back to
 * `''` when all three sources are empty.
 */
export function selectFailureOutput(
  accumulatedOutput: string,
  resultStdout: string | undefined,
  progressFullOutput: string,
): string {
  if (accumulatedOutput.trim() !== '') return accumulatedOutput
  if (resultStdout && resultStdout.trim() !== '') return resultStdout
  if (progressFullOutput.trim() !== '') return progressFullOutput
  return ''
}
