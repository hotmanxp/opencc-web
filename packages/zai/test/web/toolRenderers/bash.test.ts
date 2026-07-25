// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { bashRenderer } from '../../../src/web/src/components/toolRenderers/bash.js'
import { renderToString } from 'react-dom/server'
import React from 'react'

describe('bashRenderer', () => {
  it('preview prefers description over command', () => {
    expect(
      bashRenderer.preview({
        command: 'git status',
        description: '检查当前 git 状态',
      }),
    ).toBe('检查当前 git 状态')
  })
  it('preview falls back to command when no description', () => {
    expect(bashRenderer.preview({ command: 'pwd' })).toBe('pwd')
  })
  it('preview is empty when neither field is a non-empty string', () => {
    expect(bashRenderer.preview({ command: '', description: '' })).toBe('')
    expect(bashRenderer.preview({})).toBe('')
  })
  it('preview truncates long values at 80', () => {
    const long = 'a'.repeat(120)
    expect(
      bashRenderer.preview({ command: long }),
    ).toBe('a'.repeat(80) + '…')
  })
  it('renderInput is a ReactNode element (non-null)', () => {
    const node = bashRenderer.renderInput?.({
      command: 'ls',
      description: 'list',
      timeout: 30000,
    })
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput returns null/undefined when output is undefined', () => {
    // Returning null is allowed; caller treats null as "nothing"
    const node = bashRenderer.renderOutput?.(undefined, false)
    expect(node == null || React.isValidElement(node)).toBe(true)
  })
  it('renderOutput returns a ReactNode for parsed output', () => {
    const node = bashRenderer.renderOutput?.(
      '<stdout>hello</stdout><stderr>oops</stderr>',
      false,
    )
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput strips ANSI escapes from rendered output', () => {
    const node = bashRenderer.renderOutput?.(
      '<stdout>\x1b[31mred\x1b[0m text</stdout>',
      false,
    )
    const html = renderToString(node as any)
    expect(html).not.toContain('\x1b')
    expect(html).toContain('red')
    expect(html).toContain(' text')
    // Color span should be present (AnsiText applied the SGR code)
    expect(html).toMatch(/<span[^>]*color:/)
  })
})
