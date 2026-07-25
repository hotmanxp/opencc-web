// packages/zai/test/web/toolRenderers/ansi.test.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { parseAnsi, AnsiText } from '../../../src/web/src/components/toolRenderers/ansi.js'

function collectText(nodes: React.ReactNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (typeof n === 'string') out += n
    else if (typeof n === 'number') out += String(n)
    else if (React.isValidElement(n)) {
      const children = (n.props as any).children
      if (typeof children === 'string') out += children
      else if (Array.isArray(children)) out += collectText(children)
    }
  }
  return out
}

function getSpans(nodes: React.ReactNode[]): Array<{ style: React.CSSProperties; text: string }> {
  const spans: Array<{ style: React.CSSProperties; text: string }> = []
  for (const n of nodes) {
    if (React.isValidElement(n) && (n as any).type === 'span') {
      const props = n.props as any
      spans.push({ style: props.style ?? {}, text: typeof props.children === 'string' ? props.children : '' })
    }
  }
  return spans
}

describe('parseAnsi', () => {
  it('returns plain text as single string node when no escapes', () => {
    const nodes = parseAnsi('hello world')
    expect(nodes).toEqual(['hello world'])
  })

  it('returns empty array for empty string', () => {
    expect(parseAnsi('')).toEqual([])
  })

  it('renders red text with correct color', () => {
    const nodes = parseAnsi('\x1b[31mhello\x1b[0m')
    const spans = getSpans(nodes)
    expect(spans).toHaveLength(1)
    expect(spans[0].text).toBe('hello')
    expect(spans[0].style.color).toBe('#cd3131')
  })

  it('renders bold+red composite', () => {
    const nodes = parseAnsi('\x1b[1;31mbold red\x1b[0m')
    const spans = getSpans(nodes)
    expect(spans).toHaveLength(1)
    expect(spans[0].style.fontWeight).toBe(700)
    expect(spans[0].style.color).toBe('#cd3131')
  })

  it('resets style after ESC[0m', () => {
    const nodes = parseAnsi('\x1b[31mred\x1b[0m plain')
    const spans = getSpans(nodes)
    expect(spans).toHaveLength(1)
    expect(spans[0].text).toBe('red')
    expect(spans[0].style.color).toBe('#cd3131')
    // "plain" should be a bare string node, not a span
    const plainNodes = nodes.filter(n => typeof n === 'string')
    expect(plainNodes).toContain(' plain')
  })

  it('strips non-SGR CSI sequences', () => {
    const nodes = parseAnsi('\x1b[2Jhello\x1b[A')
    expect(collectText(nodes)).toBe('hello')
    expect(getSpans(nodes)).toHaveLength(0)
  })

  it('strips OSC sequences', () => {
    const nodes = parseAnsi('\x1b]0;title\x07hello')
    expect(collectText(nodes)).toBe('hello')
  })

  it('handles truncated escape gracefully', () => {
    // \x1b[31 without closing m — regex won't match, so it stays as text
    const nodes = parseAnsi('\x1b[31hello')
    const text = collectText(nodes)
    expect(text).toBe('\x1b[31hello')
  })

  it('renders all 8 basic foreground colors', () => {
    const expected: Record<number, string> = {
      30: '#000000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
      34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
    }
    for (const [code, hex] of Object.entries(expected)) {
      const nodes = parseAnsi(`\x1b[${code}mx\x1b[0m`)
      const spans = getSpans(nodes)
      expect(spans[0].style.color).toBe(hex)
    }
  })

  it('renders bright foreground colors', () => {
    const nodes = parseAnsi('\x1b[91mbright red\x1b[0m')
    const spans = getSpans(nodes)
    expect(spans[0].style.color).toBe('#f14c4c')
  })
})

describe('AnsiText', () => {
  it('is a valid React element', () => {
    const el = React.createElement(AnsiText, { text: 'hello' })
    expect(React.isValidElement(el)).toBe(true)
  })
})