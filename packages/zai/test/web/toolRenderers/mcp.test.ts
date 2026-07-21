// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import React from 'react'
import {
  mcpRenderer,
  isMcpToolName,
  actionSegment,
  shortName,
} from '../../../src/web/src/components/toolRenderers/mcp.js'

describe('isMcpToolName / shortName / actionSegment', () => {
  it('isMcpToolName matches mcp_ prefix', () => {
    expect(isMcpToolName('mcp_zinai_browser_navigate')).toBe(true)
    expect(isMcpToolName('mcp_foo')).toBe(true)
    expect(isMcpToolName('Bash')).toBe(false)
    expect(isMcpToolName('mcpfoo')).toBe(false) // 没下划线
    expect(isMcpToolName('')).toBe(false)
  })
  it('shortName strips mcp_ prefix', () => {
    expect(shortName('mcp_zinai_browser_navigate')).toBe('zinai_browser_navigate')
    expect(shortName('mcp_foo')).toBe('foo')
    expect(shortName('Bash')).toBe('Bash') // non-mcp keeps full
  })
  it('actionSegment returns last underscore-separated segment', () => {
    expect(actionSegment('mcp_zinai_browser_navigate')).toBe('navigate')
    expect(actionSegment('mcp_foo')).toBe('foo')
    expect(actionSegment('mcp_a_b_c_d_e')).toBe('e')
  })
})

describe('mcpRenderer', () => {
  it('preview shows first input string value', () => {
    expect(mcpRenderer.preview({ url: 'https://example.com' })).toBe(
      'https://example.com',
    )
  })
  it('preview stringifies non-string first value', () => {
    expect(mcpRenderer.preview({ args: { id: 1 } })).toBe('{"id":1}')
  })
  it('preview empty when no input keys', () => {
    expect(mcpRenderer.preview({})).toBe('')
  })
  it('preview skips null first value', () => {
    expect(mcpRenderer.preview({ a: null })).toBe('')
  })
  it('preview truncates long values at 80', () => {
    expect(mcpRenderer.preview({ url: 'x'.repeat(120) })).toBe('x'.repeat(80) + '…')
  })
  it('renderInput is a React element with JSON', () => {
    const node = mcpRenderer.renderInput?.({ url: 'foo', method: 'POST' })
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput returns null when output undefined', () => {
    const node = mcpRenderer.renderOutput?.(undefined, false)
    expect(node == null).toBe(true)
  })
  it('renderOutput returns React element for valid output', () => {
    const node = mcpRenderer.renderOutput?.('{"ok":true}', false)
    expect(React.isValidElement(node)).toBe(true)
  })
})
