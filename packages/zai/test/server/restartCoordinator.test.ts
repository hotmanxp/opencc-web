import { describe, expect, it, mock } from 'bun:test'
import { requestRestart } from '../../src/server/services/restartCoordinator.js'

describe('restartCoordinator', () => {
  it('drains in-flight, closes server, sends restart, then exits', async () => {
    const calls: string[] = []
    let pollCount = 0
    const handle = requestRestart('user_action', {
      inFlightCount: () => (++pollCount <= 3 ? 2 : 0),
      abortAll: () => { calls.push('abort'); return 2 },
      closeServer: async () => { calls.push('close') },
      sendRestart: (r) => { calls.push(`send:${r}`); return true },
      exit: (c) => { calls.push(`exit:${c}`) },
      log: (l) => calls.push(`log:${l}`),
      sleep: async () => undefined,
      now: () => Date.now(),
    })
    const result = await handle.promise
    expect(result.exited).toBe(true)
    if (!result.drain.drained) throw new Error('expected drained')
    expect(calls).toEqual(expect.arrayContaining(['close', 'send:user_action', 'exit:0']))
  })

  it('cancel before closeServer resolves without sending restart', async () => {
    const calls: string[] = []
    let inFlight = 1
    const handle = requestRestart('auto_recovery', {
      inFlightCount: () => inFlight,
      abortAll: () => { calls.push('abort'); return 0 },
      closeServer: async () => { calls.push('close') },
      sendRestart: () => { calls.push('send'); return true },
      exit: () => { calls.push('exit') },
      log: () => {},
      sleep: async () => { inFlight = 0 },
      now: () => Date.now(),
    })
    handle.cancel()
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).not.toContain('close')
    expect(calls).not.toContain('send')
  })
})
