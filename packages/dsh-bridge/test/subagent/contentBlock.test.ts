import { describe, expect, it } from 'vitest'
import {
  parseContentBlock,
  parseContentBlocks,
  SubagentContentBlockSchema,
} from '../../src/subagent/contentBlock.js'

describe('contentBlock', () => {
  it('parses thinking block', () => {
    const r = parseContentBlock({ type: 'thinking', thinking: 'x' })
    expect(r.type).toBe('thinking')
  })
  it('parses text block', () => {
    const r = parseContentBlock({ type: 'text', text: 'hi' })
    expect(r.type).toBe('text')
  })
  it('parses tool_use block', () => {
    const r = parseContentBlock({ type: 'tool_use', id: 'a', name: 'Read', input: {} })
    expect(r.type).toBe('tool_use')
  })
  it('parses tool_result block', () => {
    const r = parseContentBlock({ type: 'tool_result', tool_use_id: 'a', content: 'r' })
    expect(r.type).toBe('tool_result')
  })
  it('parses image block', () => {
    const r = parseContentBlock({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    })
    expect(r.type).toBe('image')
  })
  it('throws on unknown type with warn', () => {
    expect(() => parseContentBlock({ type: 'bogus' })).toThrow(/contentBlock/i)
  })
  it('parseContentBlocks handles array', () => {
    const r = parseContentBlocks([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
    expect(r).toHaveLength(2)
  })
  it('export SubagentContentBlockSchema is exported', () => {
    expect(SubagentContentBlockSchema).toBeDefined()
  })
})
