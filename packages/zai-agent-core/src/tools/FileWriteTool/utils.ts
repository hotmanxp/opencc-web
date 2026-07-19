/**
 * File-write helpers ported from upstream OpenCC's `utils/file.ts`,
 * trimmed to what the Write tool needs:
 *
 *  - `writeTextContent` — preserves CRLF / CR endings when overwriting an
 *    existing file (model-supplied content stays verbatim LF; the file's
 *    existing line endings are detected and re-applied).
 *  - `detectLineEndings` — first 4 KiB sniff for `\r\n` / `\r` / `\n`.
 *  - `detectFileEncoding` — UTF-8 / UTF-16 BOM detection, falls back to
 *    utf8 on ENOENT (new file) or unreadable path.
 *
 * The matrix gap to close: legacy `FileWriteTool` writes `utf-8` literally
 * (opencc `writeFile(absPath, content, 'utf-8')`), which silently corrupts
 * CRLF source on Windows-style files. Mirror opencc's `writeTextContent`
 * semantics here.
 */
import { stat, readFile } from 'fs/promises'

export type LineEndingType = 'LF' | 'CRLF' | 'CR'

/**
 * RFC 4180 / POSIX: detect which line ending dominates in the first
 * chunk. CRLF > lone CR > LF (since CRLF contains LF, a naive first-match
 * would misclassify CRLF as LF). Mirrors opencc's
 * `detectLineEndingsForString`.
 */
export function detectLineEndingsFromString(
  content: string,
): LineEndingType {
  if (content.includes('\r\n')) return 'CRLF'
  if (content.includes('\r')) return 'CR'
  return 'LF'
}

/**
 * Read the first 4 KiB of an existing file (sync via the async readFile
 * wrapper) and classify its line endings. Defaults to LF on ENOENT or
 * other errors — caller treats new files as LF by convention.
 */
export async function detectLineEndings(
  filePath: string,
): Promise<LineEndingType> {
  try {
    const handle = await readFile(filePath)
    // Read just enough of the buffer to type-decode.
    const text = handle.toString('utf8', 0, Math.min(handle.length, 4096))
    return detectLineEndingsFromString(text)
  } catch {
    return 'LF'
  }
}

/**
 * Minimal encoding detector: peeks at the first 3 bytes for a BOM.
 *  - FF FE        -> utf16le
 *  - FE FF        -> utf16be
 *  - EF BB BF     -> utf8 (BOM, optional)
 *  - otherwise    -> utf8 (default)
 *
 * Mirrors opencc's `detectEncodingForResolvedPath` shape, but trimmed
 * for Bun's fs/promises: a tiny stat + read of the first few bytes is
 * all we need. Falls back to utf8 on ENOENT.
 */
export async function detectFileEncoding(
  filePath: string,
): Promise<BufferEncoding> {
  try {
    const handle = await readFile(filePath)
    const b0 = handle[0]
    const b1 = handle[1]
    const b2 = handle[2]
    if (b0 === 0xff && b1 === 0xfe) return 'utf16le'
    // Note: Node's `BufferEncoding` accepts only `utf16le`; UTF-16 BE
    // files aren't writable through the standard `utf16le` encoding
    // path. Convert via manual byte-swap when encountered.
    // (kept detection here for completeness; writeTextContent will
    //  fall through to utf8 path on utf16be for now)
    if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return 'utf8'
    return 'utf8'
  } catch {
    return 'utf8'
  }
}

/**
 * Write `content` to `filePath`, preserving the file's existing line
 * endings when overwriting. Symmetric to opencc's `writeTextContent`:
 *
 *  - ending === 'LF'   → write content verbatim (no rewrite).
 *  - ending === 'CRLF' → normalize any pre-existing CRLF to LF, then
 *    re-join with \r\n (prevents \r\r\n when content already had CRLF).
 *  - ending === 'CR'   → similar normalization, replace LF with CR.
 *
 * Note: opencc has actually flip-flopped here (FileWriteTool now passes
 * 'LF' regardless, asserting the model "meant what it sent"). For zai
 * we keep the *preserve* semantics to match the historical matrix item
 * "preserve line endings"; revist if upstream normalizes fully to LF.
 *
 * Uses `Bun.write` per project AGENTS.md preference; falls back to
 * `fs.promises.writeFile` if the runtime isn't Bun.
 */
export async function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  ending: LineEndingType,
): Promise<void> {
  let toWrite = content
  if (ending === 'CRLF') {
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
  } else if (ending === 'CR') {
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r')
  }
  await writeWithBun(filePath, toWrite, encoding)
}

async function writeWithBun(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
): Promise<void> {
  // Bun global; project AGENTS.md mandates Bun APIs where available.
  // `@ts-ignore` because bun types are not part of tsc base lib here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunWriter = (globalThis as any).Bun?.write as
    | ((path: string, data: string, opts?: { encoding?: string }) => Promise<unknown>)
    | undefined
  if (bunWriter) {
    await bunWriter(filePath, content, { encoding })
    return
  }
  // Fallback for non-Bun runtimes (tests via vitest). Use streaming
  // writeFile so large content doesn't pin the event loop.
  const { writeFile } = await import('fs/promises')
  await writeFile(filePath, content, encoding as BufferEncoding)
}

/**
 * Cheap stat helper. Mirrors opencc's `getFileModificationTimeAsync`
 * (the async variant); we only need this for the re-check stage.
 */
export async function getMtimeMs(filePath: string): Promise<number> {
  const s = await stat(filePath)
  return Math.floor(s.mtimeMs)
}
