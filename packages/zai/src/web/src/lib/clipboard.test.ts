// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest'
import { copyToClipboard } from './clipboard.js'

// happy-dom 20.10.6 does not define document.execCommand, but vi.spyOn requires
// the property to exist before it can replace it. Install a no-op stub so the
// existing spyOn calls work without touching vitest.config.ts.
if (!('execCommand' in document)) {
  ;(document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = () => false
}

describe('copyToClipboard', () => {
  test('navigator.clipboard.writeText 可用时, 调用之并返回 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const ok = await copyToClipboard('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(ok).toBe(true)
  })

  test('writeText 抛错时 fallback 到 execCommand 并返回 true', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const ok = await copyToClipboard('hello')
    expect(execSpy).toHaveBeenCalledWith('copy')
    expect(ok).toBe(true)
  })

  test('writeText 抛错且 execCommand 返回 false 时, 返回 false 且不抛', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(false)
    await expect(copyToClipboard('hello')).resolves.toBe(false)
    expect(execSpy).toHaveBeenCalledWith('copy')
  })

  test('navigator.clipboard 整个不存在时, 直接走 execCommand', async () => {
    vi.stubGlobal('navigator', {})
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const ok = await copyToClipboard('plain')
    expect(execSpy).toHaveBeenCalledWith('copy')
    expect(ok).toBe(true)
  })

  test('execCommand 抛错时返回 false', async () => {
    vi.stubGlobal('navigator', {})
    vi.spyOn(document, 'execCommand').mockImplementation(() => {
      throw new Error('blocked')
    })
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })
})
