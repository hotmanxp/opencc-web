// @ts-nocheck
import type {
  ReplSession,
  ReplSessionOptions,
  ReplEvent,
} from '../types.js'

describe('ReplSession types', () => {
  it('ReplSessionOptions is exported', () => {
    const opts: ReplSessionOptions = {
      sessionId: 's1',
      cwd: '/tmp',
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    }
    expect(opts.sessionId).toBe('s1')
  })

  it('ReplSession interface is structurally typed', () => {
    const stub: ReplSession = {
      submit: async () => {},
      enqueue: async () => {},
      interrupt: async () => {},
      endSession: async () => {},
      on: () => () => {},
      dispose: async () => {},
      getState: () => ({ sessionId: 's1', turnIndex: 0, isRunning: false, isDisposed: false }),
    }
    expect(stub.getState().sessionId).toBe('s1')
  })
})
