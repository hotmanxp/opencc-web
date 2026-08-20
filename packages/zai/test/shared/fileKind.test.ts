import { describe, expect, it } from 'vitest'
import { classifyKind, mimeFromExt } from '../../src/shared/fileKind.js'

describe('fileKind.classifyKind', () => {
  it('classifies image extensions as image', () => {
    expect(classifyKind('/tmp/photo.png')).toBe('image')
    expect(classifyKind('/tmp/photo.JPG')).toBe('image')
    expect(classifyKind('/tmp/photo.svg')).toBe('image')
  })

  it('classifies html extensions as html', () => {
    expect(classifyKind('/tmp/page.html')).toBe('html')
    expect(classifyKind('/tmp/page.HTM')).toBe('html')
  })

  it('classifies known text extensions as text', () => {
    expect(classifyKind('/tmp/code.ts')).toBe('text')
    expect(classifyKind('/tmp/data.json')).toBe('text')
    expect(classifyKind('/tmp/readme.md')).toBe('text')
  })

  it('classifies unknown / binary extensions as binary', () => {
    expect(classifyKind('/tmp/blob.zip')).toBe('binary')
    expect(classifyKind('/tmp/no-extension')).toBe('binary')
  })

  it('handles paths with multiple dots', () => {
    expect(classifyKind('/tmp/foo.bar.ts')).toBe('text')
    expect(classifyKind('/tmp/foo.bar.png')).toBe('image')
  })
})

describe('fileKind.mimeFromExt', () => {
  it('returns mime for known image extensions', () => {
    expect(mimeFromExt('/tmp/x.png')).toBe('image/png')
    expect(mimeFromExt('/tmp/x.jpg')).toBe('image/jpeg')
    expect(mimeFromExt('/tmp/x.svg')).toBe('image/svg+xml')
  })

  it('returns undefined for non-image / unknown', () => {
    expect(mimeFromExt('/tmp/x.ts')).toBeUndefined()
    expect(mimeFromExt('/tmp/x.bin')).toBeUndefined()
  })
})
