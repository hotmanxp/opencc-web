import { describe, expect, it } from 'vitest'
import { wrapSkillToolAsOpencc } from '../../../../src/compat/tools/opencc/SkillTool.js'

describe('wrapSkillToolAsOpencc', () => {
  it('returns 1 tool named Skill', () => {
    const wrapped = wrapSkillToolAsOpencc()
    expect(wrapped).toHaveLength(1)
    expect((wrapped[0] as any).name).toBe('Skill')
  })

  it('has call, description, inputSchema, isReadOnly, isConcurrencySafe, isEnabled', () => {
    const wrapped = wrapSkillToolAsOpencc()
    const t = wrapped[0] as any
    expect(typeof t.call).toBe('function')
    expect(typeof t.description).toBe('function')
    expect(t.inputSchema).toBeDefined()
    expect(typeof t.isReadOnly).toBe('function')
    expect(typeof t.isConcurrencySafe).toBe('function')
    expect(typeof t.isEnabled).toBe('function')
  })
})