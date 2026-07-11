import { describe, expect, test, vi } from 'vitest'
import type { ToolContext } from '../Tool.js'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp', env: {}, abortSignal: new AbortController().signal,
    dataDir: '/d', state: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    emitEvent: () => {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    ...overrides,
  }
}

const baseInput = {
  questions: [
    {
      question: 'Which library?',
      header: 'Library',
      options: [
        { label: 'React', description: 'UI lib' },
        { label: 'Vue', description: 'UI lib' },
      ],
      multiSelect: false,
    },
  ],
}

describe('AskUserQuestionTool', () => {
  test('input already has answers → return without awaiting', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: vi.fn(async () => {
        throw new Error('should not be called')
      }),
    })
    const out = await AskUserQuestionTool.call(
      { ...baseInput, answers: { 'Which library?': 'React' } },
      ctx,
    )
    expect(out.isError).toBeFalsy()
    expect((out.output as any).answers).toEqual({ 'Which library?': 'React' })
  })

  test('no answers → await ctx.awaitAskUserQuestion → return its result', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async (req) => ({
        answers: { [(req.questions as any[])[0].question]: 'Vue' },
      }),
    })
    const out = await AskUserQuestionTool.call(baseInput as any, ctx)
    expect((out.output as any).answers).toEqual({ 'Which library?': 'Vue' })
  })

  test('returns annotations when present', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async () => ({
        answers: { 'Which library?': 'React' },
        annotations: { 'Which library?': { notes: 'with SSR' } },
      }),
    })
    const out = await AskUserQuestionTool.call(baseInput as any, ctx)
    expect((out.output as any).annotations).toEqual({ 'Which library?': { notes: 'with SSR' } })
  })

  test('omits annotations when not provided', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async () => ({ answers: { 'Which library?': 'React' } }),
    })
    const out = await AskUserQuestionTool.call(baseInput as any, ctx)
    expect((out.output as any).annotations).toBeUndefined()
  })

  test('passes metadata through to awaitAskUserQuestion', async () => {
    const spy = vi.fn(async () => ({ answers: { 'Which library?': 'React' } }))
    const ctx = makeCtx({ awaitAskUserQuestion: spy })
    await AskUserQuestionTool.call(
      { ...baseInput, metadata: { source: 'remember' } } as any,
      ctx,
    )
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ metadata: { source: 'remember' } }))
  })

  test('propagates abort error from awaitAskUserQuestion', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async () => { throw new Error('aborted') },
    })
    await expect(AskUserQuestionTool.call(baseInput as any, ctx)).rejects.toThrow('aborted')
  })
})
