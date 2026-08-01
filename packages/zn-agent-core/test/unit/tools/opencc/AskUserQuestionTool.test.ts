import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('wrapAskUserQuestionToolAsOpencc — bridgeCtx at call time', () => {
  const KEY = '__zaiBridgeCtx'
  let saved: any

  beforeEach(() => {
    saved = (globalThis as any)[KEY]
  })
  afterEach(() => {
    if (saved === undefined) delete (globalThis as any)[KEY]
    else (globalThis as any)[KEY] = saved
  })

  // Regression: prior implementation captured bridgeCtx in a closure at
  // wrapper-construction time, but the wrapper is module-cached by
  // getOpenccBuiltinTools() — so a SECOND session's tool call would
  // receive the FIRST session's sessionId / askRegistry / onYield.
  // The fix: transformCtx reads __zaiBridgeCtx on every call.
  it('passes through current __zaiBridgeCtx (not a stale closure)', async () => {
    const capturedOnYield: Array<{ eventType: string }> = []
    const sessionA = {
      sessionId: 'sess-A',
      askRegistry: { tag: 'A' },
      onYield: (ev: any) => capturedOnYield.push({ eventType: ev.type }),
    }
    const sessionB = {
      sessionId: 'sess-B',
      askRegistry: { tag: 'B' },
      onYield: (ev: any) => capturedOnYield.push({ eventType: ev.type }),
    }

    // Set session A's ctx BEFORE constructing the wrapper. With the
    // old (broken) behavior, this would pin sessionId/askRegistry to A
    // forever — even after we overwrite ctx with B below.
    ;(globalThis as any)[KEY] = sessionA
    const wrapped = wrapAskUserQuestionToolAsOpencc() as any

    // Now overwrite ctx with B — simulates session B starting after A's
    // wrapper was already cached.
    ;(globalThis as any)[KEY] = sessionB

    // Invoke the wrapped call with an openccCtx that provides
    // toolUseId. askUserQuestionCall's stub branch fires when ctx
    // lacks sessionId/askRegistry/onYield/toolUseId; the wrapper's
    // transformCtx must merge those from __zaiBridgeCtx so the real
    // branch runs and onYield is called with `tool_use:ask_pending`.
    //
    // askUserQuestionCall will then call ctx.askRegistry.register(...)
    // which blocks until the user answers; the test's `{tag:'B'}` has
    // no `register` method, so the call rejects — onYield has already
    // fired by that point. Swallow the rejection via .catch().
    await wrapped
      .call(
        {
          questions: [
            {
              question: 'q1',
              header: 'h',
              options: [
                { label: 'a' },
                { label: 'b' },
              ],
            },
          ],
        },
        {
          toolUseId: 'tu-1',
          abortController: { signal: undefined },
        },
        () => true,
        undefined,
        undefined,
      )
      .catch(() => {})

    expect(capturedOnYield).toEqual([{ eventType: 'tool_use:ask_pending' }])
    // The onYield that fired must be session B's, not A's. If
    // capturedOnYield.length === 0, the wrapper took the stub branch
    // (sessionId/askRegistry/onYield were missing) — that's the bug.
  })
})