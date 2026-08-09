/**
 * Integration test: assertValidImageBuffer — the magic-bytes gate that
 * readImageWithTokenBudget (and attachment processing) uses before
 * producing an image block. Corrupt / non-image files must be rejected
 * with a readable error instead of generating an image block the API
 * rejects with `400 ... unknown format (2013)`.
 *
 * Backstory: sess-1786262225380-3kcxoyim — the LLM wrote
 * `Buffer.from(await captureScreenshot(), 'base64')` but captureScreenshot()
 * returns a *file path*; base64-decoding the path (silently dropping the
 * `-` / `.` chars) produced a 57-byte corrupt "PNG" that FileReadTool read
 * as an image and the API rejected.
 *
 * Unit coverage of the detection itself lives in
 * test/unit/utils/imageFormatStrict.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { assertValidImageBuffer } from '../../../src/opencc-src/utils/imageResizer.js'

describe('assertValidImageBuffer — corrupt image gate', () => {
  it('throws a readable error for a corrupt file (path-string base64 bug)', () => {
    // 真实 bug 产物:截图路径字符串被 Buffer.from(path, 'base64') 解码后的
    // 57 字节乱码,内容不是任何已知图片格式。
    const corrupt = Buffer.from(
      '/var/folders/xd/vb8tqxt55bn3wg3rz0mr3q600000gn/T/ego-browser-shot-46381-1.png',
      'base64',
    )
    expect(() => assertValidImageBuffer(corrupt, '/tmp/x.png')).toThrow(
      /not a valid image/,
    )
  })

  it('rejects empty buffers', () => {
    expect(() => assertValidImageBuffer(Buffer.alloc(0), '/tmp/x.png')).toThrow(
      /not a valid image/,
    )
  })

  it('accepts a real PNG (valid magic bytes)', () => {
    // 1x1 透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    expect(() => assertValidImageBuffer(png, '/tmp/ok.png')).not.toThrow()
  })
})
