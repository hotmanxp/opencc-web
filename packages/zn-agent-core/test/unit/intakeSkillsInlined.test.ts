import { describe, expect, it } from 'vitest'
import {
  INLINED_BRAINSTORMING_SKILL,
  INLINED_WRITING_PLANS_SKILL,
  INTAKE_SKILL_DISCIPLINE,
} from '../../src/opencc-src/prompts/intakeSkillsInlined.js'

describe('intakeSkillsInlined module', () => {
  it('inlines brainstorming SKILL content', () => {
    expect(INLINED_BRAINSTORMING_SKILL.length).toBeGreaterThan(0)
    expect(INLINED_BRAINSTORMING_SKILL.join('\n')).toContain(
      '# Brainstorming Ideas Into Designs',
    )
  })

  it('inlines writing-plans SKILL content', () => {
    expect(INLINED_WRITING_PLANS_SKILL.length).toBeGreaterThan(0)
    expect(INLINED_WRITING_PLANS_SKILL.join('\n')).toContain('# Writing Plans')
  })

  it('discipline section forbids re-triggering via SkillTool', () => {
    expect(INTAKE_SKILL_DISCIPLINE.length).toBeGreaterThan(0)
    expect(INTAKE_SKILL_DISCIPLINE.join('\n')).toMatch(
      /do NOT re-invoke them via SkillTool/i,
    )
  })
})