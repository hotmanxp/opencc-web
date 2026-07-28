import { describe, expect, it } from 'bun:test'

import { SettingsSchema } from './types.js'

describe('SettingsSchema — ultracode field', () => {
  it('accepts ultracode: true', () => {
    const result = SettingsSchema().parse({ ultracode: true })
    expect(result.ultracode).toBe(true)
  })

  it('accepts ultracode: false', () => {
    const result = SettingsSchema().parse({ ultracode: false })
    expect(result.ultracode).toBe(false)
  })

  it('accepts missing ultracode (optional)', () => {
    const result = SettingsSchema().parse({})
    expect(result.ultracode).toBeUndefined()
  })

  it('rejects ultracode: "yes" (not a boolean)', () => {
    expect(() => SettingsSchema().parse({ ultracode: 'yes' })).toThrow()
  })

  it('rejects ultracode: 1 (not a boolean)', () => {
    expect(() => SettingsSchema().parse({ ultracode: 1 })).toThrow()
  })
})
