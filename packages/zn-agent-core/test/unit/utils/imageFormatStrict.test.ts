/**
 * Regression tests for detectImageFormatStrict — the magic-bytes gate
 * that blocks corrupt / non-image files from becoming image blocks.
 *
 * Backstory: in zai session `sess-1786262225380-3kcxoyim` the LLM wrote
 * `fs.writeFileSync(png, Buffer.from(await captureScreenshot(), 'base64'))`,
 * but ego-browser's captureScreenshot() returns a *file path*, not base64.
 * Buffer.from(path, 'base64') silently drops the non-base64 chars (`-`, `.`)
 * and produced a 57-byte corrupt "PNG". FileReadTool then read it as an
 * image and the API rejected it with
 * `400 invalid image content ... unknown format (2013)`.
 *
 * detectImageFormatFromBuffer defaults unknown data to 'image/png', so it
 * cannot catch this. detectImageFormatStrict returns null instead.
 */
import { describe, expect, it } from 'vitest'
import { detectImageFormatStrict } from '../../../src/opencc-src/utils/imageResizer.js'

describe('detectImageFormatStrict', () => {
  it('detects valid PNG / JPEG / GIF / WebP magic bytes', () => {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    expect(
      detectImageFormatStrict(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('image/png')
    // JPEG: FF D8 FF
    expect(detectImageFormatStrict(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      'image/jpeg',
    )
    // GIF: GIF89a
    expect(
      detectImageFormatStrict(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])),
    ).toBe('image/gif')
    // WebP: RIFF....WEBP
    expect(
      detectImageFormatStrict(
        Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp')
  })

  it('returns null for corrupt / non-image data (the path-string bug)', () => {
    // 真实 bug:截图路径字符串被 Buffer.from(path, 'base64') 解码后写盘
    const corrupt = Buffer.from(
      '/var/folders/xd/vb8tqxt55bn3wg3rz0mr3q600000gn/T/ego-browser-shot-46381-1.png',
      'base64',
    )
    expect(detectImageFormatStrict(corrupt)).toBeNull()

    expect(detectImageFormatStrict(Buffer.from('not an image at all'))).toBeNull()
    expect(detectImageFormatStrict(Buffer.alloc(0))).toBeNull()
  })
})
