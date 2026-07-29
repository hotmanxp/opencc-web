import { describe, expect, it } from 'vitest'
import { wrapAskUserQuestionToolAsOpencc } from '../../../../src/compat/tools/opencc/AskUserQuestionTool.js'

describe('wrapAskUserQuestionToolAsOpencc', () => {
  it('returns tool with name AskUserQuestion', () => {
    expect(wrapAskUserQuestionToolAsOpencc().name).toBe('AskUserQuestion')
  })

  it('requiresUserInteraction returns true', () => {
    const wrapped = wrapAskUserQuestionToolAsOpencc() as any
    expect(wrapped.requiresUserInteraction()).toBe(true)
  })

  it('interruptBehavior returns block', () => {
    const wrapped = wrapAskUserQuestionToolAsOpencc() as any
    expect(wrapped.interruptBehavior?.()).toBe('block')
  })
})
