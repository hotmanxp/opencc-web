import { describe, expect, it, vi } from 'vitest'
import { readImageAsBase64, ImageReadError } from '../../src/web/src/lib/imageReader'

// 构造一个能在测试环境跑起来的最小 File polyfill.
// happy-dom / jsdom 没有内置 File, 但 vitest 在 test/web/* 默认走 happy-dom,
// 其 globalThis.File 是不可用的. 用 Blob + name/type 手搓一个最小版本.
function makeFile(content: string, name: string, type: string, sizeBytes?: number): File {
  // BlobPart 可以是 string 或 Uint8Array; 这里给 string, 浏览器会自动算 size
  return new Blob([content], { type }) as unknown as File
  // 上面丢 name 也没关系, 我们在测试里单独传 filename
}

// Mock FileReader (happy-dom 没有完整的 FileReader)
class MockFileReader {
  result: string | ArrayBuffer | null = null
  error: Error | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  abort() { this.onabort?.() }
  readAsDataURL(blob: Blob) {
    // 模拟 base64: 'data:' + blob.type + ';base64,' + btoa(content)
    blob.text().then(text => {
      this.result = `data:${blob.type};base64,${btoa(text)}`
      this.onload?.()
    })
  }
}

describe('readImageAsBase64', () => {
  it('returns dataURL for valid PNG', async () => {
    vi.stubGlobal('FileReader', MockFileReader)
    const f = makeFile('fake-png-bytes', 'shot.png', 'image/png')
    Object.defineProperty(f, 'name', { value: 'shot.png' })
    const r = await readImageAsBase64(f)
    expect(r.mime).toBe('image/png')
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(r.filename).toBe('shot.png')
    vi.unstubAllGlobals()
  })

  it('throws unsupported_mime for text/plain', async () => {
    const f = makeFile('hello', 'note.txt', 'text/plain')
    Object.defineProperty(f, 'name', { value: 'note.txt' })
    await expect(readImageAsBase64(f)).rejects.toThrowError(ImageReadError)
    try { await readImageAsBase64(f) } catch (e: any) {
      expect(e.reason).toBe('unsupported_mime')
    }
  })

  it('throws too_large when file > 10MB', async () => {
    // 用 11MB Buffer 模拟
    const big = new Uint8Array(11 * 1024 * 1024)
    const f = new Blob([big], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'big.png' })
    await expect(readImageAsBase64(f)).rejects.toThrowError(ImageReadError)
    try { await readImageAsBase64(f) } catch (e: any) {
      expect(e.reason).toBe('too_large')
    }
  })

  it('throws read_failed when signal is already aborted', async () => {
    const f = makeFile('x', 'x.png', 'image/png')
    Object.defineProperty(f, 'name', { value: 'x.png' })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(readImageAsBase64(f, ctrl.signal)).rejects.toThrowError(/已取消/)
  })
})
