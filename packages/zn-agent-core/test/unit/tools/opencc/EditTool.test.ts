import { describe, expect, it } from 'vitest'
import { wrapEditToolAsOpencc } from '../../../../src/compat/tools/opencc/EditTool.js'

describe('wrapEditToolAsOpencc', () => {
  it('returns tool with name Edit', () => {
    expect(wrapEditToolAsOpencc().name).toBe('Edit')
  })

  it('isDestructive returns true', () => {
    const wrapped = wrapEditToolAsOpencc() as any
    expect(
      wrapped.isDestructive({ file_path: '/foo', old_string: 'a', new_string: 'b' }),
    ).toBe(true)
  })

  it('isReadOnly returns false', () => {
    const wrapped = wrapEditToolAsOpencc() as any
    expect(wrapped.isReadOnly({ file_path: '/foo' })).toBe(false)
  })
})
