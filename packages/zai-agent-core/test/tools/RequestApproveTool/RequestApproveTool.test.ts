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

// Both inline + file-input variants now share the same flat shape — just
// a `filePath` pointing at a workspace file. The AI no longer decides
// between inline or file; the drawer always fetches via /api/agent/approve/file.
//
// filePath is now an absolute path (unix or windows). The server route
// resolves it literally; callers are responsible for supplying a path
// the reviewer can actually see.
const baseInput = {
  title: 'Plan for the foo feature',
  summary: 'Brief one-liner',
  filePath: '/tmp/plan.md',
}

describe('RequestApproveTool', () => {
  test('approved without comment → output { decision: "approved" }, no comment field', async () => {
    const awaitApprove = vi.fn(async (_req: AwaitApproveInput): Promise<AwaitApproveResult> => ({
      decision: 'approved',
    }))
    const ctx = makeCtx({
      awaitApprove,
      __toolUseId: 'tu-1',
    } as any)
    const out = await RequestApproveTool.call(baseInput as any, ctx as any)
    expect(out.isError).toBeFalsy()
    const parsed = JSON.parse(out.output)
    expect(parsed.decision).toBe('approved')
    expect(parsed.comment).toBeUndefined()
    expect(awaitApprove).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 'tu-1',
      title: 'Plan for the foo feature',
      summary: 'Brief one-liner',
      filePath: '/tmp/plan.md',
    }))
  })

  test('approved WITH comment → output { decision: "approved", comment }', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => ({ decision: 'approved', comment: 'looks solid' }),
      __toolUseId: 'tu-2',
    } as any)
    const out = await RequestApproveTool.call(baseInput as any, ctx as any)
    const parsed = JSON.parse(out.output)
    expect(parsed).toEqual({ decision: 'approved', comment: 'looks solid' })
  })

  test('rejected with comment → output { decision: "rejected", comment }', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => ({ decision: 'rejected', comment: 'fix the API section' }),
      __toolUseId: 'tu-3',
    } as any)
    const out = await RequestApproveTool.call(baseInput as any, ctx as any)
    const parsed = JSON.parse(out.output)
    expect(parsed).toEqual({ decision: 'rejected', comment: 'fix the API section' })
  })

  test('filePath passes through to awaitApprove (drawer fetches file)', async () => {
    const captured: AwaitApproveInput[] = []
    const ctx = makeCtx({
      awaitApprove: async (req) => {
        captured.push(req)
        return { decision: 'approved' }
      },
      __toolUseId: 'tu-4',
    } as any)
    await RequestApproveTool.call({ ...baseInput, filePath: '/tmp/design.md' } as any, ctx as any)
    expect(captured[0]!.filePath).toBe('/tmp/design.md')
    expect(captured[0]!.summary).toBe('Brief one-liner')
  })

  test('isReadOnly true', () => {
    expect(RequestApproveTool.isReadOnly!({} as any)).toBe(true)
  })

  test('isConcurrencySafe true', () => {
    expect(RequestApproveTool.isConcurrencySafe!({} as any)).toBe(true)
  })

  test('schema accepts absolute unix file path', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      filePath: '/absolute/path.md',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.filePath).toBe('/absolute/path.md')
    }
  })

  test('schema accepts absolute windows file path', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      filePath: 'C:/some/path.md',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.filePath).toBe('C:/some/path.md')
    }
  })

  test('schema still accepts relative file paths', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      filePath: 'docs/x.md',
    })
    expect(r.success).toBe(true)
  })

  test('schema rejects empty title', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: '',
      filePath: '/tmp/x.md',
    })
    expect(r.success).toBe(false)
  })

  test('schema rejects filePath > 1024 chars', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      filePath: '/' + 'a'.repeat(1024),
    })
    expect(r.success).toBe(false)
  })

  test('propagates abort error from awaitApprove', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => { throw new Error('aborted') },
      __toolUseId: 'tu-x',
    } as any)
    await expect(RequestApproveTool.call(baseInput as any, ctx as any))
      .rejects.toThrow('aborted')
  })

  test('awaitApprove not available → throws clearly', async () => {
    const ctx = makeCtx({ awaitApprove: undefined } as any)
    await expect(RequestApproveTool.call(baseInput as any, ctx as any))
      .rejects.toThrow('awaitApprove not available')
  })
})