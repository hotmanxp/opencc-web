import { describe, expect, it } from 'vitest'
import { SeamRegistry, MissingVendorSeamError } from '../../../../src/server/services/kernel/seamRegistry.js'

describe('SeamRegistry', () => {
  it('register + get 解析', () => {
    const reg = new SeamRegistry()
    const seam = { foo: () => 'bar' }
    reg.register('test', seam)
    expect(reg.get<typeof seam>('test')).toBe(seam)
  })

  it('get 缺失抛 MissingVendorSeamError', () => {
    const reg = new SeamRegistry()
    expect(() => reg.get('nope')).toThrow(MissingVendorSeamError)
  })

  it('register 同名覆盖', () => {
    const reg = new SeamRegistry()
    const a = { x: 1 }
    const b = { x: 2 }
    reg.register('s', a)
    reg.register('s', b)
    expect(reg.get('s')).toBe(b)
  })
})
