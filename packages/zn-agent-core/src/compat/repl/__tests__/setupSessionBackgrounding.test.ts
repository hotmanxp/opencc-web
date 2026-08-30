// packages/zn-agent-core/src/compat/repl/__tests__/setupSessionBackgrounding.test.ts
// @ts-nocheck
import { setupSessionBackgrounding } from '../setup/setupSessionBackgrounding.js'

describe('setupSessionBackgrounding', () => {
  it('background fires onBackground; foreground fires onForeground', () => {
    const events: string[] = []
    const handle = setupSessionBackgrounding({
      sessionId: 's1',
      onBackground: () => events.push('bg'),
      onForeground: () => events.push('fg'),
    })
    handle.background()
    handle.foreground()
    expect(events).toEqual(['bg', 'fg'])
    handle.teardown()
  })

  it('teardown is idempotent', () => {
    const handle = setupSessionBackgrounding({
      sessionId: 's2',
      onBackground: () => {},
      onForeground: () => {},
    })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })

  it('after teardown, background/foreground do nothing', () => {
    const events: string[] = []
    const handle = setupSessionBackgrounding({
      sessionId: 's3',
      onBackground: () => events.push('bg'),
      onForeground: () => events.push('fg'),
    })
    handle.teardown()
    handle.background()
    handle.foreground()
    expect(events).toEqual([])
  })
})
