import { describe, expect, it } from 'vitest'
import { taskIntakeMainAgent } from '../../src/opencc-src/server/mainAgents-taskIntake.js'

describe('task-intake systemPrompt inlines skills (2026-09-05 inline-skills)', () => {
  it('inlines brainstorming + writing-plans SKILL content + discipline section', async () => {
    const slot = taskIntakeMainAgent.systemPrompt
    if (typeof slot !== 'function') throw new Error('systemPrompt must be a function')
    const sections = await slot([])
    const joined = sections.join('\n')
    expect(joined).toContain('# Brainstorming Ideas Into Designs')
    expect(joined).toContain('# Writing Plans')
    expect(joined).toMatch(/do NOT re-invoke them via SkillTool/i)
    expect(joined).not.toMatch(/invoke SkillTool to run the brainstorming skill/i)
  })
})