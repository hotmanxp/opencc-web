// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { readRenderer } from '../../../src/web/src/components/toolRenderers/read.js'
import React from 'react'

describe('readRenderer', () => {
  it('preview shows the file path', () => {
    expect(readRenderer.preview({ file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts')
  })
  it('preview appends L{start}-{end} when offset and limit are numeric', () => {
    expect(
      readRenderer.preview({ file_path: '/a.ts', offset: 10, limit: 20 }),
    ).toBe('/a.ts L10-29')
  })
  it('preview treats offset=0 as present (not "no offset")', () => {
    expect(
      readRenderer.preview({ file_path: '/a.ts', offset: 0, limit: 50 }),
    ).toBe('/a.ts L0-49')
  })
  it('preview omits line range when only one of offset/limit given', () => {
    expect(readRenderer.preview({ file_path: '/a.ts', offset: 5 })).toBe('/a.ts')
    expect(readRenderer.preview({ file_path: '/a.ts', limit: 30 })).toBe('/a.ts')
  })
  it('preview coerces string-numeric offset/limit', () => {
    expect(
      readRenderer.preview({
        file_path: '/a',
        offset: '10',
        limit: '5',
      }),
    ).toBe('/a L10-14')
  })
  it('preview is empty when no file_path', () => {
    expect(readRenderer.preview({})).toBe('')
  })
  it('renderInput / renderOutput return React elements', () => {
    expect(React.isValidElement(readRenderer.renderInput?.({ file_path: '/x' })!)).toBe(true)
    expect(React.isValidElement(readRenderer.renderOutput?.('Read N lines', false)!)).toBe(true)
  })
})
