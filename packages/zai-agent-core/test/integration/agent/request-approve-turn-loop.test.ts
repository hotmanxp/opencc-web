import { describe, expect, test } from 'vitest'
import { executeToolsStreaming } from '../../../src/runtime/toolExecution.js'
import { REQUEST_APPROVE_TOOL_NAME } from '../../../src/tools/RequestApproveTool/prompt.js'
import { RequestApproveTool } from '../../../src/tools/RequestApproveTool/RequestApproveTool.js'
import type { ApproveRegistryLike } from '../../../src/runtime/types.js'
import { mkdirSync, writeFileSync } from 'node:fs'

// Same minimal in-memory registry shape as zai's services/approveRegistry.ts
// — reimplemented here to avoid a cross-package import in tests.
class TestApproveRegistry implements ApproveRegistryLike {
  pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void; sessionId: string }>()
  register(toolUseId: string, sessionId: string, _sig: AbortSignal): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.pending.set(toolUseId, { resolve, reject, sessionId })
    })
  }
  answer(toolUseId: string, payload: any) {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.resolve(payload)
    return true
  }
}

describe('RequestApprove end-to-end turn loop', () => {
  test('approve_pending yields, await blocks, decision resumes tool with {decision:approved}', async () => {
    const reg = new TestApproveRegistry()
    const blocks = [
      {
        id: 'tu-1',
        name: REQUEST_APPROVE_TOOL_NAME,
        input: {
          title: 'My plan',
          body: { kind: 'inline', content: '# Plan\n\nA plan.' },
        },
      },
    ]

    // Pre-register a synthetic decision so the await resolves.
    setTimeout(() => reg.answer('tu-1', { decision: 'approved', comment: 'looks good' }), 5)

    const collected: any[] = []
    await (async () => {
      for await (const ev of executeToolsStreaming(
        blocks as any,
        { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/d',
          state: {}, canUseTool: async () => ({ behavior: 'allow' }),
          emitEvent: () => {}, awaitAskUserQuestion: async () => ({ answers: {} }),
        } as any,
        [RequestApproveTool] as any,
        { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + collected.length },
        undefined,
        reg,
      )) {
        collected.push(ev)
      }
    })()

    const approvePending = collected.find((e) => e.type === 'tool_use:approve_pending')
    expect(approvePending).toBeTruthy()
    expect(approvePending.toolUseId).toBe('tu-1')
    expect(approvePending.title).toBe('My plan')
    expect(approvePending.body).toEqual({ kind: 'inline', displayPath: null, content: '# Plan\n\nA plan.' })
    const done = collected.find((e) => e.type === 'tool_use:done')
    expect(done).toBeTruthy()
  })

  test('file path with displayPath preserved in approve_pending event', async () => {
    const reg = new TestApproveRegistry()
    // runtime's resolveFileBody reads cwd + relative path off disk;
    // pre-create the file under /tmp so the read succeeds.
    mkdirSync('/tmp/docs', { recursive: true })
    writeFileSync('/tmp/docs/design.md', '# design content', 'utf8')
    const blocks = [
      {
        id: 'tu-2',
        name: REQUEST_APPROVE_TOOL_NAME,
        input: {
          title: 'design',
          body: { kind: 'file', path: 'docs/design.md' },
        },
      },
    ]
    setTimeout(() => reg.answer('tu-2', { decision: 'approved' }), 5)

    const collected: any[] = []
    await (async () => {
      for await (const ev of executeToolsStreaming(
        blocks as any,
        { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/d',
          state: {}, canUseTool: async () => ({ behavior: 'allow' }),
          emitEvent: () => {}, awaitAskUserQuestion: async () => ({ answers: {} }),
        } as any,
        [RequestApproveTool] as any,
        { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + collected.length },
        undefined,
        reg,
      )) {
        collected.push(ev)
      }
    })()

    const approvePending = collected.find((e) => e.type === 'tool_use:approve_pending')
    expect(approvePending.body.kind).toBe('file')
    expect(approvePending.body.displayPath).toBe('docs/design.md')
  })

  test('approveRegistry not configured → tool_use:error yielded, promise not awaited', async () => {
    const blocks = [
      {
        id: 'tu-3',
        name: REQUEST_APPROVE_TOOL_NAME,
        input: { title: 'T', body: { kind: 'inline', content: 'x' } },
      },
    ]

    const collected: any[] = []
    await (async () => {
      for await (const ev of executeToolsStreaming(
        blocks as any,
        { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/d',
          state: {}, canUseTool: async () => ({ behavior: 'allow' }),
          emitEvent: () => {}, awaitAskUserQuestion: async () => ({ answers: {} }),
        } as any,
        [RequestApproveTool] as any,
        { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + collected.length },
        undefined,
        // intentionally undefined
      )) {
        collected.push(ev)
      }
    })()

    const err = collected.find((e) => e.type === 'tool_use:error')
    expect(err).toBeTruthy()
    expect(String(err.error)).toMatch(/approveRegistry/)
  })
})
