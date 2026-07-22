// Regression test for: queryLoop must pass `config.approveRegistry` through
// to `executeToolsStreaming`. Without this, the legacy tool path in
// `toolExecution.ts` rejects the RequestApprove tool_use with
// `tool_use:error('approveRegistry not configured: ...')` and the frontend
// never sees `prompt.approve` — the user only sees a runtime.error.
//
// This test drives the full `queryLoop` turn (modelCaller yields a
// RequestApprove tool_use, we pre-register a synthetic decision on the
// registry, and assert that the runtime yields `tool_use:approve_pending`
// then `tool_use:done`, NOT `tool_use:error`).

import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'
import type { ApproveRegistryLike } from '../../src/runtime/types.js'

// In-memory registry mirroring zai/services/approveRegistry.ts, kept inline
// to avoid a cross-package import in tests.
class TestApproveRegistry implements ApproveRegistryLike {
  pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void; sessionId: string }>()
  register(toolUseId: string, sessionId: string, _sig: AbortSignal): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.pending.set(toolUseId, { resolve, reject, sessionId })
      // Auto-approve on the next microtask. We can't predict the runtime's
      // internal toolUseId string reliably from outside the modelCaller
      // fixture, so resolving whatever id the runtime passes through is
      // the safest way to exercise the wiring end-to-end.
      queueMicrotask(() => this.answer(toolUseId, { decision: 'approved' }))
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

async function collect(g: AsyncGenerator<any>) {
  const out: any[] = []
  for await (const e of g) out.push(e)
  return out
}

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'zai-qe-approve-')); })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); })

describe('queryLoop RequestApprove registry pass-through', () => {
  test('with approveRegistry configured → yields tool_use:approve_pending then tool_use:done (no tool_use:error)', async () => {
    const reg = new TestApproveRegistry()
    // TestApproveRegistry auto-approves on register via queueMicrotask, so
    // we don't need to know the runtime's internal toolUseId string.
    const events = await collect(queryLoop(
      { prompt: 'review my plan', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('request-approve-tool'),
        sandbox: makeMockSandbox('/tmp'),
        approveRegistry: reg,
      },
    ))

    const pending = events.find((e: any) => e.type === 'tool_use:approve_pending')
    const error = events.find((e: any) => e.type === 'tool_use:error' && /approveRegistry/.test(String(e.error ?? '')))
    const done = events.find((e: any) => e.type === 'tool_use:done')

    expect(pending, 'expected tool_use:approve_pending to be yielded when approveRegistry is configured').toBeTruthy()
    expect(pending.toolUseId).toBeTruthy()
    expect(pending.title).toBe('plan')
    expect(pending.body).toEqual({ kind: 'inline', displayPath: null, content: 'hi' })

    expect(error, 'expected NO tool_use:error("approveRegistry ...") when registry is wired').toBeUndefined()

    expect(done, 'expected tool_use:done after registry resolves with approved').toBeTruthy()
  })

  test('without approveRegistry configured → yields tool_use:error("approveRegistry not configured")', async () => {
    // Defensive counterpart to the regression test above: confirms the
    // legacy check still fires when no registry is wired, so we know the
    // previous test isn't passing trivially.
    const events = await collect(queryLoop(
      { prompt: 'review my plan', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('request-approve-tool'),
        sandbox: makeMockSandbox('/tmp'),
        // approveRegistry intentionally omitted
      },
    ))

    const error = events.find((e: any) => e.type === 'tool_use:error' && /approveRegistry/.test(String(e.error ?? '')))
    expect(error, 'expected tool_use:error(approveRegistry...) when no registry is configured').toBeTruthy()
  })
})
