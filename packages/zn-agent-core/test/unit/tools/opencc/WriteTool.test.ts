import { describe, expect, it } from 'vitest'
import { wrapWriteToolAsOpencc } from '../../../../src/compat/tools/opencc/WriteTool.js'

describe('wrapWriteToolAsOpencc', () => {
  it('returns tool with name Write', () => {
    expect(wrapWriteToolAsOpencc().name).toBe('Write')
  })

  it('isDestructive returns true', () => {
    const wrapped = wrapWriteToolAsOpencc() as any
    expect(
      wrapped.isDestructive({ file_path: '/foo', content: 'x' }),
    ).toBe(true)
  })
})
