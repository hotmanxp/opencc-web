import { describe, expect, it } from 'vitest'
import { projectCuaDriverImageBlocks } from '../../src/opencc-src/services/mcp/cuaDriverImageBlocks.js'

describe('projectCuaDriverImageBlocks', () => {
  it('passes plain-string content through unchanged', () => {
    const out = projectCuaDriverImageBlocks('hello world', 'tu-1')
    expect(out).toEqual({
      tool_use_id: 'tu-1',
      type: 'tool_result',
      content: 'hello world',
    })
  })

  it('coerces non-array, non-string content to an empty string', () => {
    const out = projectCuaDriverImageBlocks(undefined, 'tu-2')
    expect(out).toEqual({
      tool_use_id: 'tu-2',
      type: 'tool_result',
      content: '',
    })
  })

  it('projects cua-driver image block to Anthropic base64-source shape', () => {
    const out = projectCuaDriverImageBlocks(
      [
        { type: 'image', mimeType: 'image/jpeg', data: 'BASE64DATA' },
      ],
      'tu-3',
    )
    expect(out).toEqual({
      tool_use_id: 'tu-3',
      type: 'tool_result',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'BASE64DATA' },
        },
      ],
    })
  })

  it('defaults missing mimeType to image/jpeg', () => {
    const out = projectCuaDriverImageBlocks(
      [{ type: 'image', data: 'XYZ' }],
      'tu-4',
    )
    expect(out.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'XYZ' },
      },
    ])
  })

  it('preserves text blocks verbatim', () => {
    const out = projectCuaDriverImageBlocks(
      [{ type: 'text', text: 'ok' }],
      'tu-5',
    )
    expect(out.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('mixes image and text blocks in order', () => {
    const out = projectCuaDriverImageBlocks(
      [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: 'PNG' },
        { type: 'text', text: 'after' },
      ],
      'tu-6',
    )
    expect(out.content).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'PNG' },
      },
      { type: 'text', text: 'after' },
    ])
  })

  it('coerces unsupported block shapes to a JSON-bounded diagnostic text block', () => {
    const out = projectCuaDriverImageBlocks(
      [{ type: 'audio', data: 'ignored' }],
      'tu-7',
    )
    expect(out.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('[unsupported cua-driver content block:'),
    })
  })

  it('handles empty content array', () => {
    const out = projectCuaDriverImageBlocks([], 'tu-8')
    expect(out).toEqual({ tool_use_id: 'tu-8', type: 'tool_result', content: [] })
  })
})