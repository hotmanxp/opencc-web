// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { writeRenderer } from '../../../src/web/src/components/toolRenderers/write.js'
import React from 'react'

describe('writeRenderer', () => {
  it('preview shows file path', () => {
    expect(writeRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview appends (N lines) when content present', () => {
    expect(
      writeRenderer.preview({ file_path: '/a.ts', content: 'a\nb\nc' }),
    ).toBe('/a.ts (3 lines)')
  })
  it('preview appends (0 lines) for empty content', () => {
    expect(
      writeRenderer.preview({ file_path: '/a.ts', content: '' }),
    ).toBe('/a.ts (0 lines)')
  })
  it('preview is empty when no file_path', () => {
    expect(writeRenderer.preview({ content: 'x' })).toBe('')
  })
  it('renderInput returns React element with content pre', () => {
    const node = writeRenderer.renderInput?.({ file_path: '/a', content: 'hi' })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput is defined', () => {
    const node = writeRenderer.renderOutput?.('Wrote 5 bytes to /a', false)!
    expect(React.isValidElement(node)).toBe(true)
  })
})
