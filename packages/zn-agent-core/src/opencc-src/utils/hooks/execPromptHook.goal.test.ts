import { beforeEach, describe, expect, mock, test } from 'bun:test'

// IMPORTANT: mock.module MUST be set up before importing the module under test.
// Bun hoists `mock.module` calls but we still keep them at the top for clarity.
// We preserve every other export from claude.js so unrelated transitive
// imports (cost-tracker re-exports getAPIMetadata, etc.) still work — only
// queryModelWithoutStreaming is overridden.

// Sanity check (reproduces the 2026-06-13 regression guards):
//   1. git stash push -- src/utils/hooks/execPromptHook.ts
//      (or `git checkout 4c847ee5 -- src/utils/hooks/execPromptHook.ts`)
//   2. bun test src/utils/hooks/execPromptHook.goal.test.ts
//      → expect 2 fail / 1 pass; failures are:
//        - success-path: "expected 'number' received 'undefined'" on the
//          achievedAt assertion (clearActiveGoalIfActive threw TypeError,
//          try/catch swallowed, activeGoal.achievedAt never stamped).
//        - blocking-path: "expected 1 received 0" on iterations
//          (bumpGoalIteration threw TypeError, try/catch swallowed).
//   3. git checkout 53b12fbefd7c92530777dce8a7f9c45f12f8b744 -- src/utils/hooks/execPromptHook.ts
//      (or `git stash pop`) and re-run → expect 3 pass / 0 fail.

const DEFAULT_OK_TRUE_RESPONSE = async () => ({
  message: {
    content: [{ type: 'text', text: '{"ok": true, "reason": "test default ok:true response"}' }],
  },
})
const queryModelWithoutStreamingMock = mock(DEFAULT_OK_TRUE_RESPONSE)

const actualClaudeModule = await import('../../services/api/claude.js')
mock.module('../../services/api/claude.js', () => ({
  ...actualClaudeModule,
  queryModelWithoutStreaming: queryModelWithoutStreamingMock,
}))

const { execPromptHook } = await import('./execPromptHook.js')
const { clearActiveGoalIfActive } = await import('../../services/goal/hooks.js')
const { createActiveGoal } = await import('../../services/goal/activeGoal.js')

type AppState = any
type ToolUseContext = any

function makeAppState(): AppState {
  return {
    activeGoal: null,
    sessionHooks: new Map(),
    goalSentinel: null,
    toolPermissionContext: {},
  }
}

function makeToolUseContext(state: AppState) {
  return {
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      const next = updater(state)
      Object.assign(state, next)
    },
    setResponseLength: () => {},
    options: {
      tools: [],
      agents: [],
      mcpTools: [],
    },
    agentId: undefined,
  }
}

function seedActiveGoal(state: AppState, condition = 'finish tests') {
  state.activeGoal = createActiveGoal(condition, 0)
}

const hook = {
  type: 'prompt' as const,
  prompt: 'finish tests',
  timeout: 30,
}

beforeEach(() => {
  // mockReset clears both call history AND the implementation. Re-establish
  // the default ok:true response so tests that don't override the impl still
  // see the success-path LLM shape. mockReset's defensive value remains for
  // any future test that uses mockImplementationOnce — the once-queue is
  // also cleared, preventing state bleed between tests.
  queryModelWithoutStreamingMock.mockReset()
  queryModelWithoutStreamingMock.mockImplementation(DEFAULT_OK_TRUE_RESPONSE)
})

describe('execPromptHook — /goal Stop-hook success path integration', () => {
  test('clearActiveGoalIfActive is reachable from execPromptHook success path (regression: 2026-06-13)', async () => {
    // Reproduction guard for the 2026-06-13 bug: the working tree at that
    // time called clearActiveGoalIfActive with flat {setAppState, appState}
    // args, so the helper threw TypeError on toolUseContext.getAppState() and
    // activeGoal never cleared. This test exercises the FULL execPromptHook
    // call path, so the same shape mismatch (if reintroduced) would fail here.
    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    const result = await execPromptHook(
      hook,
      'goal-stop-eval',
      'Stop' as any,
      '{}',
      new AbortController().signal,
      toolUseContext,
      [],
      'tool-use-id-1',
    )

    // 1. execPromptHook returned success (model said ok:true)
    expect(result.outcome).toBe('success')

    // 2. The LLM was called via the correct path
    expect(queryModelWithoutStreamingMock).toHaveBeenCalledTimes(1)

    // 3. THE REGRESSION ASSERTION: activeGoal moved into the achieved
    //    summary window (achievedAt stamped). If the call-site shape is
    //    wrong, helper throws TypeError, try/catch swallows it, and
    //    activeGoal.achievedAt stays undefined.
    expect(state.activeGoal).not.toBeNull()
    expect(typeof state.activeGoal?.achievedAt).toBe('number')
  })

  test('helper signature matches the call-site (compile-time guard)', () => {
    // Belt-and-braces: directly assert that the helper signature accepts
    // {toolUseContext} and would NOT accept {setAppState, appState} flat.
    // The TypeScript compiler enforces this at typecheck time, but because
    // execPromptHook.ts has // @ts-nocheck this is the only shape check
    // that catches the regression. If anyone reintroduces the broken
    // shape in execPromptHook, this assertion (and the runtime test
    // above) will still hold — but if someone changes the helper
    // signature itself, this catches it.
    const state = makeAppState()
    const toolUseContext = makeToolUseContext(state)
    // Should not throw — toolUseContext shape is correct
    expect(() =>
      clearActiveGoalIfActive({ toolUseContext }),
    ).not.toThrow()
    // The helper did NOT mark a goal because activeGoal was null — but
    // it also did not throw, which is the regression guard.
    expect(state.activeGoal).toBeNull()
  })
})

describe('execPromptHook — /goal Stop-hook blocking path integration', () => {
  test('bumpGoalIteration increments iterations when LLM returns ok:false (regression: 2026-06-13)', async () => {
    // The symmetric regression guard for the blocking path. Same root
    // cause as the success path test — call-site shape mismatch with
    // bumpGoalIteration. If the call site passes flat {setAppState, appState}
    // to bumpGoalIteration (which expects {toolUseContext}), the helper
    // throws TypeError on toolUseContext.getAppState(), try/catch swallows,
    // and iterations stays at 0 even though the model said ok:false.
    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    // Override the default mock (set in beforeEach) for this test only.
    // mockImplementationOnce enqueues a single override; beforeEach's
    // mockReset + mockImplementation runs FIRST in this test's lifecycle
    // (bun test calls beforeEach before each test, then the test body),
    // so the once-override replaces the default for this one call.
    queryModelWithoutStreamingMock.mockImplementationOnce(async () => ({
      message: {
        content: [
          { type: 'text', text: '{"ok": false, "reason": "still working"}' },
        ],
      },
    }))

    const result = await execPromptHook(
      hook,
      'goal-stop-eval',
      'Stop' as any,
      '{}',
      new AbortController().signal,
      toolUseContext,
      [],
      'tool-use-id-2',
    )

    // 1. execPromptHook returned blocking (model said ok:false)
    expect(result.outcome).toBe('blocking')

    // 2. THE REGRESSION ASSERTION: iterations went from 0 to 1. If the
    //    call-site shape is wrong, bumpGoalIteration throws TypeError,
    //    try/catch swallows, iterations stays 0.
    expect(state.activeGoal?.iterations).toBe(1)
    expect(state.activeGoal?.achievedAt).toBeUndefined()
  })
})

describe('execPromptHook — Stop-condition prompt content (gap #1)', () => {
  test('Stop hook fires with detailed 3-shape prompt (not terse 2-shape)', async () => {
    // Capture the systemPrompt passed to queryModelWithoutStreaming.
    // The brand `SystemPrompt` is `readonly string[]` (see asSystemPrompt),
    // so the captured value is an array of strings, not blocks.
    let capturedSystemPrompt: string = ''
    ;(queryModelWithoutStreamingMock as any).mockImplementation(async (opts: any) => {
      const sys = opts?.systemPrompt
      capturedSystemPrompt = Array.isArray(sys)
        ? sys.join('\n')
        : String(sys ?? '')
      return { message: { content: [{ type: 'text', text: '{"ok": true, "reason": "all tests pass"}' }] } }
    })

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // 3 distinguishing markers from the new STOP_CONDITION_PROMPT
    expect(capturedSystemPrompt).toContain('stop-condition hook')
    expect(capturedSystemPrompt).toContain('insufficient evidence in transcript')
    expect(capturedSystemPrompt).toContain('"impossible": true')
    // Brand must be "OpenCC", not "Claude Code"
    expect(capturedSystemPrompt).toContain('OpenCC')
    expect(capturedSystemPrompt).not.toContain('Claude Code')
  })
})

describe('execPromptHook — Stop user-message wrapper (gap #2)', () => {
  test('Stop hook user message is wrapped as "Condition: <prompt>"', async () => {
    // Capture the messages array passed to queryModelWithoutStreaming
    let capturedMessages: any[] = []
    ;(queryModelWithoutStreamingMock as any).mockImplementation(async (opts: any) => {
      capturedMessages = opts?.messages ?? []
      return { message: { content: [{ type: 'text', text: '{"ok": true, "reason": "all tests pass"}' }] } }
    })

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // The last user message should have "Condition: " prefix
    const userMessages = capturedMessages.filter((m: any) => m?.type === 'user')
    expect(userMessages.length).toBeGreaterThan(0)
    const lastUser = userMessages[userMessages.length - 1]
    const content = lastUser?.message?.content ?? lastUser?.content
    const text = typeof content === 'string' ? content : (content?.[0]?.text ?? '')
    expect(text).toContain('Condition:')
    expect(text).toContain('finish tests')
    // The "Condition: " prefix should appear before the original condition
    expect(text.indexOf('Condition:')).toBeLessThan(text.indexOf('finish tests'))
  })
})

describe('execPromptHook — Stop schema (gap #3)', () => {
  test('schema requires reason field; {ok:true} without reason fails validation', async () => {
    // Mock returns {ok:true} WITHOUT reason — should fail schema validation
    // and trigger RETRY. Second mock returns valid {ok:true, reason:"X"}.
    queryModelWithoutStreamingMock.mockReset()
    queryModelWithoutStreamingMock
      .mockImplementationOnce(async () => ({
        message: { content: [{ type: 'text', text: '{"ok": true}' }] },  // missing reason
      }))
      .mockImplementationOnce(async () => ({
        message: { content: [{ type: 'text', text: '{"ok": true, "reason": "all tests pass"}' }] },
      }))

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    const result = await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // The 1st attempt failed schema → RETRY → 2nd attempt succeeded → outcome 'success'
    expect(result.outcome).toBe('success')
    // Verify model was called twice (1st failed, 2nd succeeded with reason)
    expect(queryModelWithoutStreamingMock.mock.calls.length).toBe(2)
  })

  test('schema accepts optional impossible field', async () => {
    // {ok:false, impossible:true, reason:"X"} is valid schema-wise.
    // The blocking vs success-with-flag behavior is tested in Task 5.
    queryModelWithoutStreamingMock.mockReset()
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: { content: [{ type: 'text', text: '{"ok": false, "impossible": true, "reason": "no internet"}' }] },
    }))

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'access online docs')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    const result = await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // Schema validation passes (no "Schema validation failed" error).
    // Outcome is whatever Task 5 will implement — for now it should NOT
    // be the "non_blocking_error" shape that schema failures produce.
    expect(result.outcome).not.toBe('non_blocking_error')
  })
})

describe('execPromptHook — impossible:true handler (gap #4)', () => {
  test('{ok:false, impossible:true, reason:"X"} → success-with-flag, goal cleared', async () => {
    queryModelWithoutStreamingMock.mockReset()
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: { content: [{ type: 'text', text: '{"ok": false, "impossible": true, "reason": "no internet access"}' }] },
    }))

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'access online docs')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    const result = await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // Per upstream: impossible:true is success-with-flag (not blocking).
    expect(result.outcome).toBe('success')
    // The stopReason is the model's reason for judging impossible
    // (HookResult type may have stopReason — check defensively).
    const r = result as any
    if ('stopReason' in r) {
      expect(r.stopReason).toBe('no internet access')
    }
    // Goal should be cleared (activeGoal.achievedAt stamped, then nulled after 5s)
    // We can verify the side effect happened: activeGoal should be either null
    // (after 5s) or have achievedAt set.
    const goal = state.activeGoal
    if (goal !== null) {
      expect(goal.achievedAt).toBeDefined()
    }
    // Blocking should NOT fire
    expect(result.outcome).not.toBe('blocking')
  })

  test('{ok:false, impossible:false|undefined, reason:"X"} → still blocking (control)', async () => {
    queryModelWithoutStreamingMock.mockReset()
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: { content: [{ type: 'text', text: '{"ok": false, "reason": "tests failing on test_foo"}' }] },
    }))

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    const result = await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // Without impossible, ok:false is still blocking.
    expect(result.outcome).toBe('blocking')
    // Goal should NOT be cleared.
    expect(state.activeGoal).not.toBeNull()
    // Iterations should have bumped.
    expect((state.activeGoal as any)?.iterations).toBe(1)
  })
})

describe('execPromptHook — strict-default regression (gap #5, no impl change)', () => {
  test('parse failure across both attempts → fallbackHookResult strict {ok:false} → blocking', async () => {
    // 1st attempt: unparseable. 2nd attempt: unparseable.
    // fallbackHookResult (strict per 2026-06-13 memory) returns {ok:false}
    // → outcome 'blocking', goal NOT cleared, iterations bumped.
    queryModelWithoutStreamingMock.mockReset()
    queryModelWithoutStreamingMock
      .mockImplementationOnce(async () => ({
        message: { content: [{ type: 'text', text: 'this is not json at all' }] },
      }))
      .mockImplementationOnce(async () => ({
        message: { content: [{ type: 'text', text: 'still not json' }] },
      }))

    const state: AppState = makeAppState()
    seedActiveGoal(state, 'finish tests')
    const toolUseContext: ToolUseContext = makeToolUseContext(state)

    const result = await execPromptHook(
      hook,
      'goal-stop',
      'Stop',
      JSON.stringify({ session_id: 'test' }),
      new AbortController().signal,
      toolUseContext,
      [],
    )

    // Strict default: blocking (not success).
    expect(result.outcome).toBe('blocking')
    // Goal must NOT have been cleared.
    expect(state.activeGoal).not.toBeNull()
    // Iterations should have bumped (blocking path increments).
    expect((state.activeGoal as any)?.iterations).toBe(1)
    // Model was called exactly twice (1st + retry).
    expect(queryModelWithoutStreamingMock.mock.calls.length).toBe(2)
  })
})