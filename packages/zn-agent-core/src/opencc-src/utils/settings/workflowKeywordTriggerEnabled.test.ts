import { describe, expect, it } from 'bun:test'

import { SettingsSchema } from './types.ts'

describe('SettingsSchema — workflowKeywordTriggerEnabled field', () => {
  it('accepts workflowKeywordTriggerEnabled: true', () => {
    const result = SettingsSchema().parse({ workflowKeywordTriggerEnabled: true })
    expect(result.workflowKeywordTriggerEnabled).toBe(true)
  })

  it('accepts workflowKeywordTriggerEnabled: false', () => {
    const result = SettingsSchema().parse({ workflowKeywordTriggerEnabled: false })
    expect(result.workflowKeywordTriggerEnabled).toBe(false)
  })

  it('accepts missing workflowKeywordTriggerEnabled (optional)', () => {
    const result = SettingsSchema().parse({})
    expect(result.workflowKeywordTriggerEnabled).toBeUndefined()
  })

  it('rejects workflowKeywordTriggerEnabled: "yes" (not a boolean)', () => {
    expect(() =>
      SettingsSchema().parse({ workflowKeywordTriggerEnabled: 'yes' }),
    ).toThrow()
  })

  it('rejects workflowKeywordTriggerEnabled: 1 (not a boolean)', () => {
    expect(() =>
      SettingsSchema().parse({ workflowKeywordTriggerEnabled: 1 }),
    ).toThrow()
  })
})
