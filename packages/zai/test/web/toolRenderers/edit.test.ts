// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { editRenderer } from '../../../src/web/src/components/toolRenderers/edit.js'
import React from 'react'

describe('editRenderer', () => {
  it('preview shows file path', () => {
    expect(editRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview appends (all) when replace_all=true', () => {
    expect(
      editRenderer.preview({ file_path: '/a.ts', replace_all: true }),
    ).toBe('/a.ts (all)')
  })
  it('preview does NOT append (all) when replace_all=false / absent', () => {
    expect(
      editRenderer.preview({ file_path: '/a.ts', replace_all: false }),
    ).toBe('/a.ts')
    expect(editRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview is empty when no file_path', () => {
    expect(editRenderer.preview({ old_string: 'x', new_string: 'y' })).toBe('')
  })
  it('renderInput returns a React element showing old/new strings', () => {
    const node = editRenderer.renderInput?.({
      file_path: '/a.ts',
      old_string: 'before',
      new_string: 'after',
    })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput is defined and returns node for plain output', () => {
    const node = editRenderer.renderOutput?.('Replaced 1 occurrence(s) in /a.ts', false)!
    expect(React.isValidElement(node)).toBe(true)
  })
})
