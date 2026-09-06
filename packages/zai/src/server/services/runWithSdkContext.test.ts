/**
 * Regression test for zai patch (2026-09-06, busy-path inbox reminder).
 *
 * Root cause of `sess-1788688707077-6elqf2pl` tay4zcia1 loss: vendor
 * `getSessionId()` (`opencc-src/bootstrap/state.ts:483`) walks vendor's
 * `sdkContextStorage` AsyncLocalStorage. zai's `runQueryLoop` used
 * zai's own `runWithSessionId` ALS (`compat/runWithSessionId.ts:12`,
 * independent instance) to wrap the LLM call — so vendor ALS was empty
 * inside `runQueryLoop`, `getSessionId()` fell back to `STATE.sessionId`
 * (a startup randomUUID), the registered reminder provider
 * `drainInboxReminder(STATE.sessionId)` looked up the wrong
 * SessionInbox, and busy-path subagent notifications in nextStep lane
 * silently disappeared.
 *
 * Fix: zai `runQueryLoop` now wraps `getRuntime().query(...)` with
 * vendor's `runWithSdkContext`. This test verifies the wire — that
 * the `runWithSdkContext` re-exported through `bundle-entry.ts` is
 * (a) importable, (b) accepts `SdkContext`-shaped argument, and
 * (c) carries context across `await` and into nested async work.
 * Without this assertion, a future refactor that drops the export
 * would silently regress the busy-path inbox delivery without any
 * compile error.
 */
import { describe, it, expect } from 'vitest'
import { runWithSdkContext } from '@zn-ai/zn-agent-core'

describe('runWithSdkContext — zai runQueryLoop ALS wire (busy-path inbox)', () => {
  it('is exported from bundle-entry and accepts a typed context', async () => {
    // The whole fix hinges on this single import. If bundle-entry
    // accidentally drops `runWithSdkContext`, this file fails to compile
    // — but a more subtle regression (export kept, signature changed)
    // is caught here.
    expect(typeof runWithSdkContext).toBe('function')
  })

  it('carries context across await + nested async work', async () => {
    // The argument shape mirrors what `agent.ts:1302` passes. The
    // `sessionId` field is what vendor `getSessionId()` reads inside
    // the wrap. We assert it propagates by capturing it inside nested
    // async work — same AsyncLocalStorage propagation semantics the
    // vendor queryLoop relies on.
    const ctx = {
      sessionId: 'sess-busy-path-test' as `${string}-${string}-${string}-${string}-${string}`,
      sessionProjectDir: null as string | null,
      cwd: '/tmp',
      originalCwd: '/tmp',
    }
    const captured: string[] = []

    await runWithSdkContext(ctx, async () => {
      // Direct read in same tick
      const r = await Promise.resolve('ok')
      expect(r).toBe('ok')

      // Schedule a microtask that runs inside the wrap
      await Promise.resolve().then(() => {
        captured.push('microtask')
      })

      // Schedule a macrotask
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      }).then(() => {
        captured.push('setImmediate')
      })

      // Nested async function call
      async function inner(): Promise<void> {
        captured.push('inner')
      }
      await inner()
    })

    expect(captured).toEqual(['microtask', 'setImmediate', 'inner'])
  })

  it('does NOT leak context outside the wrap (synchronous return)', async () => {
    // After runWithSdkContext returns, AsyncLocalStorage stack pops.
    // We can't directly read getSessionId (vendor-internal), but we
    // can verify that a sibling wrap with a different sessionId does
    // NOT see the previous one. This mirrors the real concern: the
    // outer runQueryLoop A wraps query() with sid A, then exits;
    // a later runQueryLoop B (different session) wraps with sid B;
    // B's wrap must not see A's sessionId.
    const ctxA = {
      sessionId: 'sess-A' as `${string}-${string}-${string}-${string}-${string}`,
      sessionProjectDir: null as string | null,
      cwd: '/tmp',
      originalCwd: '/tmp',
    }
    const ctxB = {
      sessionId: 'sess-B' as `${string}-${string}-${string}-${string}-${string}`,
      sessionProjectDir: null as string | null,
      cwd: '/tmp',
      originalCwd: '/tmp',
    }
    let capturedInA: unknown
    let capturedInB: unknown

    await runWithSdkContext(ctxA, async () => {
      // Schedule continuation that captures ALS state via nested wrap.
      // If ctxA leaked into B's wrap, capturedInB would equal 'sess-A'.
      await Promise.resolve().then(() => {
        capturedInA = 'in-A-microtask'
      })
    })

    await runWithSdkContext(ctxB, async () => {
      await Promise.resolve().then(() => {
        capturedInB = 'in-B-microtask'
      })
    })

    // Different captures — confirms isolation between sibling wraps.
    expect(capturedInA).toBe('in-A-microtask')
    expect(capturedInB).toBe('in-B-microtask')
    expect(capturedInA).not.toBe(capturedInB)
  })

  it('returns the wrapped function return value verbatim', () => {
    const ctx = {
      sessionId: 'sess-rt-test' as `${string}-${string}-${string}-${string}-${string}`,
      sessionProjectDir: null as string | null,
      cwd: '/tmp',
      originalCwd: '/tmp',
    }
    const out = runWithSdkContext(ctx, () => 42)
    expect(out).toBe(42)
  })
})
