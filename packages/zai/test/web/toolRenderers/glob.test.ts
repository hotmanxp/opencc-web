// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { globRenderer } from '../../../src/web/src/components/toolRenderers/glob.js'
import React from 'react'

describe('globRenderer', () => {
  it('preview shows pattern only', () => {
    expect(globRenderer.preview({ pattern: 'src/**/*.ts' })).toBe('src/**/*.ts')
  })
  it('preview appends in <path> when path present', () => {
    expect(
      globRenderer.preview({ pattern: '**/*.json', path: '/tmp' }),
    ).toBe('**/*.json in /tmp')
  })
  it('preview is empty when no pattern', () => {
    expect(globRenderer.preview({ path: '/tmp' })).toBe('')
  })
  it('renderInput returns React element', () => {
    expect(
      React.isValidElement(globRenderer.renderInput?.({ pattern: '*.ts' })!),
    ).toBe(true)
  })
  it('renderOutput defined', () => {
    expect(
      React.isValidElement(
        globRenderer.renderOutput?.('Found 2 matches:\nfile.ts\nfile2.ts', false)!,
      ),
    ).toBe(true)
  })
})
