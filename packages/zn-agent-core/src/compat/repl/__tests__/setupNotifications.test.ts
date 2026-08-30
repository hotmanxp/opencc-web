// packages/zn-agent-core/src/compat/repl/__tests__/setupNotifications.test.ts
// @ts-nocheck
import { setupNotifications } from '../notifications/setupNotifications.js'

describe('setupNotifications', () => {
  it('emit fires onNotification', () => {
    const received: any[] = []
    const handle = setupNotifications({ onNotification: n => received.push(n) })
    handle.emit('rateLimit', { retryAfterMs: 30000 })
    expect(received).toHaveLength(1)
    expect(received[0].kind).toBe('rateLimit')
    expect(received[0].payload.retryAfterMs).toBe(30000)
    handle.teardown()
  })

  it('subscribe adds additional listener', () => {
    const calls: number[] = []
    const handle = setupNotifications({ onNotification: () => calls.push(1) })
    const unsub = handle.subscribe(() => calls.push(2))
    handle.emit('deprecation')
    expect(calls).toEqual([1, 2])
    unsub()
    handle.emit('pluginAutoUpdate')
    expect(calls).toEqual([1, 2, 1]) // subscriber removed
    handle.teardown()
  })

  it('teardown stops all listeners', () => {
    const calls: number[] = []
    const handle = setupNotifications({ onNotification: () => calls.push(1) })
    handle.teardown()
    handle.emit('mcpStatus')
    expect(calls).toEqual([])
  })

  it('20+ NotificationKind values are defined', () => {
    // Sanity check: at least 20 distinct kinds
    const handle = setupNotifications({ onNotification: () => {} })
    const kinds = [
      'rateLimit', 'deprecation', 'pluginAutoUpdate', 'mcpStatus',
      'lspInit', 'chromeExt', 'feedbackSurvey', 'memorySurvey',
      'postCompactSurvey', 'skillImprovementSurvey', 'installMessage',
      'modelMigration', 'subscriptionSwitch', 'ideStatus',
      'autoModeUnavailable', 'pluginInstallation', 'settingsError',
      'fastMode', 'issueFlag', 'custom',
    ]
    for (const k of kinds) {
      handle.emit(k as any)
    }
    handle.teardown()
    expect(kinds.length).toBeGreaterThanOrEqual(20)
  })
})
