import { beforeEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'

// No mock.module needed — we test the actual side effect on appState
// (sessionHooks map) instead of mocking addSessionHook. This avoids
// mock.module cross-file leakage that broke the 5 other goal tests when
// this file ran first.
const { restoreSessionStateFromLog } = await import('./sessionRestore.js')
const { createAttachmentMessage } = await import('./attachments.js')
const { getSessionId } = await import('../bootstrap/state.js')
import type { Message } from '../types/message.js'

function makeAppState(): AppState {
  return {
    activeGoal: null,
    sessionHooks: new Map(),
    todos: {},
    attribution: undefined,
    fileHistory: undefined,
  } as unknown as AppState
}

function asMessage(m: unknown): Message {
  return m as unknown as Message
}

describe('restoreSessionStateFromLog — /goal transcript restore v2', () => {
  let appState: AppState
  let setAppState: (f: (prev: AppState) => AppState) => void

  beforeEach(() => {
    appState = makeAppState()
    setAppState = (f: (prev: AppState) => AppState) => {
      Object.assign(appState, f(appState))
    }
  })

  test('restores ACTIVE goal + re-registers Stop hook when last state is "set" or "bump"', () => {
    const goalAtt = createAttachmentMessage({
      type: 'goal_status',
      state: 'bump',
      condition: 'finish tests',
      timestamp: 1700000000000,
      iterations: 2,
    })
    const messages: Message[] = [asMessage(goalAtt)]

    restoreSessionStateFromLog(
      {
        messages,
        fileHistorySnapshots: [],
        attributionSnapshots: [],
        contextCollapseCommits: [],
        contextCollapseSnapshot: null,
      } as never,
      setAppState,
    )

    expect(appState.activeGoal).not.toBeNull()
    expect(appState.activeGoal?.condition).toBe('finish tests')
    expect(appState.activeGoal?.iterations).toBe(2)
    expect(appState.activeGoal?.achievedAt).toBeUndefined()
    // The Stop prompt hook was re-registered
    const sessionHooks = appState.sessionHooks.get(getSessionId())
    expect(sessionHooks?.hooks.Stop?.length).toBe(1)
  })

  test('restores the achieved-pill when last state is "achieve"', () => {
    const goalAtt = createAttachmentMessage({
      type: 'goal_status',
      state: 'achieve',
      condition: 'finish tests',
      timestamp: 1700000000000,
      iterations: 3,
      tokens: 4200,
    })
    const messages: Message[] = [asMessage(goalAtt)]

    restoreSessionStateFromLog(
      {
        messages,
        fileHistorySnapshots: [],
        attributionSnapshots: [],
        contextCollapseCommits: [],
        contextCollapseSnapshot: null,
      } as never,
      setAppState,
    )

    expect(appState.activeGoal).not.toBeNull()
    expect(appState.activeGoal?.condition).toBe('finish tests')
    expect(appState.activeGoal?.iterations).toBe(3)
    expect(typeof appState.activeGoal?.achievedAt).toBe('number')
    expect(appState.activeGoal?.tokensAtEnd).toBe(4200)
    // No hook re-registration — the goal is done
    const sessionHooks = appState.sessionHooks.get(getSessionId())
    expect(sessionHooks?.hooks.Stop?.length ?? 0).toBe(0)
  })

  test('does NOT restore when last state is "clear" (user explicitly cleared)', () => {
    const setAtt = createAttachmentMessage({
      type: 'goal_status',
      state: 'set',
      condition: 'finish tests',
    })
    const clearAtt = createAttachmentMessage({
      type: 'goal_status',
      state: 'clear',
      condition: 'finish tests',
    })
    const messages: Message[] = [asMessage(setAtt), asMessage(clearAtt)]

    restoreSessionStateFromLog(
      {
        messages,
        fileHistorySnapshots: [],
        attributionSnapshots: [],
        contextCollapseCommits: [],
        contextCollapseSnapshot: null,
      } as never,
      setAppState,
    )

    expect(appState.activeGoal).toBeNull()
    const sessionHooks = appState.sessionHooks.get(getSessionId())
    expect(sessionHooks?.hooks.Stop?.length ?? 0).toBe(0)
  })

  test('does not restore activeGoal when no goal_status attachment in messages', () => {
    const messages: Message[] = [
      {
        type: 'user',
        content: 'hello',
        uuid: '1',
        timestamp: '2024-01-01T00:00:00Z',
      } as unknown as Message,
    ]

    restoreSessionStateFromLog(
      {
        messages,
        fileHistorySnapshots: [],
        attributionSnapshots: [],
        contextCollapseCommits: [],
        contextCollapseSnapshot: null,
      } as never,
      setAppState,
    )

    expect(appState.activeGoal).toBeNull()
  })

  test('handles missing messages field gracefully (backward compat)', () => {
    expect(() => {
      restoreSessionStateFromLog(
        {
          fileHistorySnapshots: [],
          attributionSnapshots: [],
          contextCollapseCommits: [],
          contextCollapseSnapshot: null,
        } as never,
        setAppState,
      )
    }).not.toThrow()
    expect(appState.activeGoal).toBeNull()
  })
})
