import { describe, expect, it } from 'vitest'
import { wrapReadToolAsOpencc } from '../../../../src/compat/tools/opencc/ReadTool.js'

describe('wrapReadToolAsOpencc', () => {
  it('returns tool with name Read (not FileRead)', () => {
    expect(wrapReadToolAsOpencc().name).toBe('Read')
  })

  it('isReadOnly returns true', () => {
    const wrapped = wrapReadToolAsOpencc() as any
    expect(wrapped.isReadOnly({ file_path: '/foo' })).toBe(true)
  })

  it('isDestructive returns false', () => {
    const wrapped = wrapReadToolAsOpencc() as any
    expect(wrapped.isDestructive?.({ file_path: '/foo' })).toBe(false)
  })
})
