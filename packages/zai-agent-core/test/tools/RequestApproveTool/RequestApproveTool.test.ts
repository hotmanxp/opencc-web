import { describe, expect, test, vi } from 'vitest'
import type { LegacyToolContext } from '../../../src/tools/Tool.js'
import { RequestApproveTool, type AwaitApproveInput, type AwaitApproveResult } from '../../../src/tools/RequestApproveTool/RequestApproveTool.js'

function makeCtx(overrides: Partial<LegacyToolContext> = {}): LegacyToolContext {
  return {
    cwd: '/tmp', env: {}, abortSignal: new AbortController().signal,
    dataDir: '/d', state: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    emitEvent: () => {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    ...overrides,
  } as any
}

const inlineInput = {
  title: 'Plan for the foo feature',
  summary: 'Brief one-liner',
  body: { kind: 'inline' as const, content: '# Plan\n\nThis is the plan.' },
}

const fileInput = {
  title: 'Design doc',
  body: { kind: 'file' as const, path: 'docs/design.md' },
}

const inlineResolved = {
  kind: 'inline' as const,
  displayPath: null,
  content: '# Plan\n\nThis is the plan.',
}

describe('RequestApproveTool', () => {
  test('approved without comment → output { decision: "approved" }, no comment field', async () => {
    const awaitApprove = vi.fn(async (_req: AwaitApproveInput): Promise<AwaitApproveResult> => ({
      decision: 'approved',
    }))
    const ctx = makeCtx({
      awaitApprove,
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-1',
    } as any)
    const out = await RequestApproveTool.call(inlineInput as any, ctx as any)
    expect(out.isError).toBeFalsy()
    const parsed = JSON.parse(out.output)
    expect(parsed.decision).toBe('approved')
    expect(parsed.comment).toBeUndefined()
    expect(awaitApprove).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 'tu-1',
      title: 'Plan for the foo feature',
      summary: 'Brief one-liner',
      body: inlineResolved,
    }))
  })

  test('approved WITH comment → output { decision: "approved", comment }', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => ({ decision: 'approved', comment: 'looks solid' }),
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-2',
    } as any)
    const out = await RequestApproveTool.call(inlineInput as any, ctx as any)
    const parsed = JSON.parse(out.output)
    expect(parsed).toEqual({ decision: 'approved', comment: 'looks solid' })
  })

  test('rejected with comment → output { decision: "rejected", comment }', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => ({ decision: 'rejected', comment: 'fix the API section' }),
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-3',
    } as any)
    const out = await RequestApproveTool.call(inlineInput as any, ctx as any)
    const parsed = JSON.parse(out.output)
    expect(parsed).toEqual({ decision: 'rejected', comment: 'fix the API section' })
  })

  test('file variant passes through resolved body with displayPath', async () => {
    const fileResolved = {
      kind: 'file' as const,
      displayPath: 'docs/design.md',
      content: '# Design\n\n...resolved file content...',
    }
    const captured: AwaitApproveInput[] = []
    const ctx = makeCtx({
      awaitApprove: async (req) => {
        captured.push(req)
        return { decision: 'approved' }
      },
      __resolvedApproveBody: fileResolved,
      __toolUseId: 'tu-4',
    } as any)
    await RequestApproveTool.call(fileInput as any, ctx as any)
    expect(captured[0]!.body).toEqual(fileResolved)
    expect(captured[0]!.summary).toBeUndefined()
  })

  test('isReadOnly true', () => {
    expect(RequestApproveTool.isReadOnly!({} as any)).toBe(true)
  })

  test('isConcurrencySafe true', () => {
    expect(RequestApproveTool.isConcurrencySafe!({} as any)).toBe(true)
  })

  test('schema rejects absolute file path', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      body: { kind: 'file', path: '/absolute/path.md' },
    })
    expect(r.success).toBe(false)
  })

  test('schema rejects inline over 200_000 chars', () => {
    const big = 'x'.repeat(200_001)
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      body: { kind: 'inline', content: big },
    })
    expect(r.success).toBe(false)
  })

  test('schema rejects empty title', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: '',
      body: { kind: 'inline', content: '# x' },
    })
    expect(r.success).toBe(false)
  })

  test('propagates abort error from awaitApprove', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => { throw new Error('aborted') },
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-x',
    } as any)
    await expect(RequestApproveTool.call(inlineInput as any, ctx as any))
      .rejects.toThrow('aborted')
  })

  test('awaitApprove not available → throws clearly', async () => {
    const ctx = makeCtx({ awaitApprove: undefined, __resolvedApproveBody: inlineResolved } as any)
    await expect(RequestApproveTool.call(inlineInput as any, ctx as any))
      .rejects.toThrow('awaitApprove not available')
  })
})
