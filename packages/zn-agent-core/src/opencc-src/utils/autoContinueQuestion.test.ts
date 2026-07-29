import { describe, test, expect } from 'bun:test'
import type { Question } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { computeAutoContinueAnswers } from './autoContinueQuestion.ts'

const singleQ: Question = {
  question: 'Pick one',
  header: 'Pick',
  multiSelect: false,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
  ],
} as Question

const multiQ: Question = {
  question: 'Pick many',
  header: 'Many',
  multiSelect: true,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
    { label: 'C', description: '' },
  ],
} as Question

const otherQ: Question = {
  question: 'Q with other',
  header: 'Other',
  multiSelect: false,
  options: [
    { label: 'A', description: '' },
    { label: '__other__', description: '' },
  ],
} as Question

describe('computeAutoContinueAnswers', () => {
  test('returns first option for single-select', () => {
    expect(computeAutoContinueAnswers([singleQ], {})).toEqual({ 'Pick one': 'A' })
  })

  test('returns all options comma-joined for multi-select', () => {
    expect(computeAutoContinueAnswers([multiQ], {})).toEqual({
      'Pick many': 'A, B, C',
    })
  })

  test('skips questions already answered', () => {
    expect(
      computeAutoContinueAnswers([singleQ, multiQ], { 'Pick one': 'Z' }),
    ).toEqual({ 'Pick many': 'A, B, C' })
  })

  test('excludes __other__ from single-select default', () => {
    expect(computeAutoContinueAnswers([otherQ], {})).toEqual({ 'Q with other': 'A' })
  })

  test('excludes __other__ from multi-select default', () => {
    const multiWithOther: Question = {
      ...multiQ,
      options: [
        { label: 'A', description: '' },
        { label: '__other__', description: '' },
      ],
    } as Question
    expect(computeAutoContinueAnswers([multiWithOther], {})).toEqual({
      'Pick many': 'A',
    })
  })

  test('returns empty record when all answered', () => {
    expect(
      computeAutoContinueAnswers([singleQ], { 'Pick one': 'B' }),
    ).toEqual({})
  })

  test('handles empty questions array', () => {
    expect(computeAutoContinueAnswers([], {})).toEqual({})
  })

  test('leaves unanswered single-select with no eligible options as empty answer', () => {
    const onlyOther: Question = {
      question: 'Only other',
      header: 'Other',
      multiSelect: false,
      options: [{ label: '__other__', description: '' }],
    } as Question
    expect(computeAutoContinueAnswers([onlyOther], {})).toEqual({
      'Only other': '',
    })
  })
})
