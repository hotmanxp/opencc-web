import { describe, expect, it } from 'vitest'
import { wrapAsOpenccTool, wrapWithOverrides } from '../../../src/compat/runtime/openccToolWrap.js'
import type { Tool as ZaiTool } from '../../../src/compat/runtime/types.js'

function makeZaiTool(): ZaiTool {
  return {
    name: 'TestTool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    async call(_args, _ctx) {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
}

describe('wrapAsOpenccTool', () => {
  it('uses function description directly when provided', async () => {
    const tool = makeZaiTool()
    tool.description = () => 'sync description'
    const wrapped = wrapAsOpenccTool(tool)
    const result = await wrapped.description({}, undefined)
    expect(result).toBe('sync description')
  })

  it('returns object with required opencc Tool properties', () => {
    const wrapped = wrapAsOpenccTool(makeZaiTool())
    expect(wrapped.name).toBe('TestTool')
    expect(typeof wrapped.call).toBe('function')
    expect(typeof wrapped.inputSchema).toBeDefined()
    expect(typeof wrapped.maxResultSizeChars).toBe('number')
  })

  it('preserves name from input tool', () => {
    expect(wrapAsOpenccTool(makeZaiTool()).name).toBe('TestTool')
  })

  it('no-op methods return correct defaults', () => {
    const wrapped = wrapAsOpenccTool(makeZaiTool())
    expect(wrapped.isConcurrencySafe({} as any)).toBe(false)
    expect(wrapped.isReadOnly({} as any)).toBe(false)
    expect(wrapped.isEnabled()).toBe(true)
    expect(wrapped.renderToolUseMessage({} as any, {} as any)).toBeNull()
    expect(wrapped.renderToolResultMessage({} as any, [] as any, {} as any)).toBeNull()
  })
})

describe('wrapWithOverrides', () => {
  it('overrides specified methods on wrapped tool', async () => {
    const wrapped = wrapWithOverrides(makeZaiTool(), {
      isReadOnly: () => true,
      description: async () => 'overridden description',
    })
    expect(wrapped.isReadOnly({} as any)).toBe(true)
    expect(await wrapped.description({} as any, {} as any)).toBe('overridden description')
    // Non-overridden methods still work
    expect(wrapped.isEnabled()).toBe(true)
  })
})
