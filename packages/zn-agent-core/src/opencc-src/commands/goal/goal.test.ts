// @ts-nocheck — upstream test type drift
import { beforeEach, describe, expect, test } from 'bun:test'

import { setSessionTrustAccepted } from '../../bootstrap/state.js'
import { call, createGoalCall } from './goal.js'

const CLEAR_ALIASES = ['clear', 'stop', 'off', 'reset', 'none', 'cancel']

beforeEach(() => {
  // call() routes through checkGoalGateFromEnv, which reads session trust;
  // without this, every /goal-set test gets short-circuited by the gate.
  setSessionTrustAccepted(true)
})

function makeContext() {
  let state: any = {
    activeGoal: null,
    sessionHooks: new Map(),
    goalSentinel: null,
  }
  let messages: any[] = []
  const setAppState = (updater: (prev: any) => any) => {
    state = updater(state)
  }
  return {
    context: {
      getAppState: () => state,
      setAppState,
      appendMessage: (msg: any) => messages.push(msg),
      getMessages: () => messages,
    } as any,
    getState: () => state,
  }
}

describe('/goal set', () => {
  test('set a new goal returns shouldQuery=true and registers hook', async () => {
    const { context, getState } = makeContext()
    const result = await call('finish the tests', context)
    expect(result.type).toBe('text')
    expect(result.value).toContain('Goal set')
    expect(result.shouldQuery).toBe(true)
    expect(getState().activeGoal?.condition).toBe('finish the tests')
  })

  test('set with empty condition returns error and does not register', async () => {
    const { context, getState } = makeContext()
    const result = await call('', context)
    expect(result.type).toBe('text')
    expect(result.value).toContain('empty')
    expect(getState().activeGoal).toBeNull()
  })

  test('set with > 4000 char condition returns error', async () => {
    const { context, getState } = makeContext()
    const result = await call('x'.repeat(4001), context)
    expect(result.value).toContain('4,000')
    expect(getState().activeGoal).toBeNull()
  })
})

describe('/goal clear', () => {
  test.each(CLEAR_ALIASES)('alias %s clears active goal', async (alias) => {
    const { context, getState } = makeContext()
    await call('first goal', context)
    expect(getState().activeGoal).not.toBeNull()
    const result = await call(alias, context)
    expect(result.value).toContain('Goal cleared')
    // After clear, activeGoal is null OR in the 5s "achieved" display
    // v2 of the transcript-restore port split clearActiveGoal into
    // markGoalAchieved (5s achieved window, used by Stop-hook success)
    // and forceClearActiveGoal (immediately null, used by /goal clear).
    // /goal clear is the user-explicit "stop" path — no achieved window,
    // no setTimeout. Verify the active goal is gone right away.
    const after = getState().activeGoal
    expect(after).toBeNull()
  })
})

describe('gate failures', () => {
  test('trust_gate returns the trust error', async () => {
    const { context } = makeContext()
    const callWithGate = createGoalCall({
      checkGate: () => ({ code: 'trust_gate', message: 'no trust' }),
    })
    const result = await callWithGate('finish tests', context)
    expect(result.value).toContain('no trust')
  })

  test('hooks_gate returns the hooks error', async () => {
    const { context } = makeContext()
    const callWithGate = createGoalCall({
      checkGate: () => ({ code: 'hooks_gate', message: 'hooks off' }),
    })
    const result = await callWithGate('finish tests', context)
    expect(result.value).toContain('hooks off')
  })
})
