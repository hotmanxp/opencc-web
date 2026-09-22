import { describe, expect, it } from 'vitest'
import {
  classifyKind, mimeFromExt, DOCUMENT_KINDS, PREVIEWABLE_KINDS, DOCUMENT_MAX_BYTES,
} from '../../src/shared/fileKind.js'

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
    expect(classifyKind('/tmp/build.log')).toBe('text')
  })

  it('classifies unknown / binary extensions as binary', () => {
    expect(classifyKind('/tmp/blob.zip')).toBe('binary')
    expect(classifyKind('/tmp/no-extension')).toBe('binary')
  })

  it('handles paths with multiple dots', () => {
    expect(classifyKind('/tmp/foo.bar.ts')).toBe('text')
    expect(classifyKind('/tmp/foo.bar.png')).toBe('image')
  })

  // 文档预览(2026-09-21)。扩展名表是本特性的单一事实来源:服务端 /fs/raw
  // 白名单、前端 preflight、desktopFs 的 preview 标志都读它。
  it('classifies document extensions', () => {
    expect(classifyKind('/tmp/a.docx')).toBe('docx')
    expect(classifyKind('/tmp/a.DOCM')).toBe('docx')
    expect(classifyKind('/tmp/a.xlsx')).toBe('sheet')
    expect(classifyKind('/tmp/a.xlsm')).toBe('sheet')
    expect(classifyKind('/tmp/a.xlsb')).toBe('sheet')
    expect(classifyKind('/tmp/a.xls')).toBe('sheet')
    expect(classifyKind('/tmp/a.ods')).toBe('sheet')
    expect(classifyKind('/tmp/a.csv')).toBe('sheet')
    expect(classifyKind('/tmp/a.pptx')).toBe('ppt')
    expect(classifyKind('/tmp/a.pptm')).toBe('ppt')
    expect(classifyKind('/tmp/a.pdf')).toBe('pdf')
  })

  it('classifies legacy office extensions as legacy-office', () => {
    expect(classifyKind('/tmp/a.doc')).toBe('legacy-office')
    expect(classifyKind('/tmp/a.ppt')).toBe('legacy-office')
    expect(classifyKind('/tmp/a.rtf')).toBe('legacy-office')
    expect(classifyKind('/tmp/a.odt')).toBe('legacy-office')
    expect(classifyKind('/tmp/a.odp')).toBe('legacy-office')
  })
})

describe('fileKind document kind sets', () => {
  it('DOCUMENT_KINDS covers exactly the raw-byte kinds', () => {
    expect([...DOCUMENT_KINDS].sort()).toEqual(['docx', 'pdf', 'ppt', 'sheet'])
    for (const k of DOCUMENT_KINDS) expect(DOCUMENT_MAX_BYTES[k]).toBeGreaterThan(0)
    // .csv 归 sheet,.xls 也归 sheet(SheetJS 能读 BIFF)
    expect(DOCUMENT_MAX_BYTES.sheet).toBe(30 * 1024 * 1024)
    expect(DOCUMENT_MAX_BYTES.pdf).toBe(50 * 1024 * 1024)
  })

  it('PREVIEWABLE_KINDS adds legacy-office on top of the raw-byte kinds', () => {
    expect([...PREVIEWABLE_KINDS].sort()).toEqual(['docx', 'legacy-office', 'pdf', 'ppt', 'sheet'])
    expect(PREVIEWABLE_KINDS.has('text')).toBe(false)
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
