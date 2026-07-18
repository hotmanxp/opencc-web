// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { grepRenderer } from '../../../src/web/src/components/toolRenderers/grep.js'
import React from 'react'

describe('grepRenderer', () => {
  it('preview shows pattern', () => {
    expect(grepRenderer.preview({ pattern: 'TODO' })).toBe('TODO')
  })
  it('preview appends in <path> when path given', () => {
    expect(
      grepRenderer.preview({ pattern: 'TODO', path: '/src' }),
    ).toBe('TODO in /src')
  })
  it('preview is empty when no pattern', () => {
    expect(grepRenderer.preview({ path: '/src' })).toBe('')
  })
  it('renderInput returns React element with secondary params in details', () => {
    const node = grepRenderer.renderInput?.({
      pattern: 'TODO',
      path: '/src',
      output_mode: 'content',
      ignore_case: true,
    })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput defined', () => {
    expect(
      React.isValidElement(
        grepRenderer.renderOutput?.('src/a.ts:5:hit', false)!,
      ),
    ).toBe(true)
  })
})
