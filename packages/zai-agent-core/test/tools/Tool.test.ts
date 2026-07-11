import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type {
  AskUserAnswers,
  AskUserRequest,
  Tool,
  ToolContext,
} from '../../src/tools/Tool.js'

describe('Tool interface shape', () => {
  test('Tool 有 name/description/inputSchema/call + 可选 isReadOnly/isDestructive/isConcurrencySafe', () => {
    const echoTool: Tool<z.ZodObject<{ msg: z.ZodString }>> = {
      name: 'Echo',
      description: 'echoes input',
      inputSchema: z.object({ msg: z.string() }),
      call: async ({ msg }) => ({ output: msg }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    }
    expect(echoTool.name).toBe('Echo')
    expect(echoTool.isReadOnly!({ msg: 'hi' })).toBe(true)
  })

  test('ToolContext 包含必要字段', () => {
    const ctx: ToolContext = {
      cwd: '/tmp',
      env: {},
      abortSignal: new AbortController().signal,
      dataDir: '/data',
      canUseTool: async () => ({ behavior: 'allow' }),
      emitEvent: () => {},
      state: {},
      awaitAskUserQuestion: async () => ({ answers: {} }),
    }
    expect(ctx.cwd).toBe('/tmp')
  })
})

describe('AskUser types', () => {
  test('AskUserAnswers shape', () => {
    const a: AskUserAnswers = { answers: { q1: 'yes' } }
    expect(a.answers.q1).toBe('yes')
  })

  test('AskUserAnswers with annotations', () => {
    const a: AskUserAnswers = {
      answers: { q1: 'yes' },
      annotations: { q1: { notes: 'extra context' } },
    }
    expect(a.annotations?.q1?.notes).toBe('extra context')
  })

  test('AskUserRequest shape', () => {
    const r: AskUserRequest = { questions: [{ question: 'q' }] }
    expect(r.questions).toEqual([{ question: 'q' }])
  })

  test('ToolContext has awaitAskUserQuestion', () => {
    const ctx: ToolContext = {
      cwd: '',
      env: {},
      abortSignal: new AbortController().signal,
      dataDir: '',
      state: {},
      canUseTool: async () => ({ behavior: 'allow' as const }),
      emitEvent: () => {},
      awaitAskUserQuestion: async () => ({ answers: {} }),
    }
    expect(typeof ctx.awaitAskUserQuestion).toBe('function')
  })
})
