/**
 * Integration e2e for vendor preApiCallReminders hook + zai-style provider.
 *
 * Simulates the exact flow vendor's query.ts:701 triggers on every API call,
 * with a provider wired in that mirrors zai's `drainInboxReminder` (per-
 * session SessionInbox drain). Closest thing to a real e2e without depending
 * on the actual LLM endpoint — proves the prepend pipeline works end-to-end.
 */
import { describe, it, expect } from 'vitest'
import {
  registerExtraReminderProvider,
  runExtraReminderProviders,
} from '../../../../src/opencc-src/utils/daemon/preApiCallReminders.js'

// Mirror of zai's `packages/zai/src/server/services/inboxReminder.ts` drain
// path. zai provides a real SessionInbox class; here we use a minimal
// per-session lane store that matches the same contract — proves the
// vendor hook integrates cleanly with zai-style "drain per-session inbox
// on every API call" without needing the full zai runtime.
type Lane = { nextStep: string[] }
function makeInbox() {
  const lanes = new Map<string, Lane>()
  const get = (sid: string) => {
    let l = lanes.get(sid)
    if (!l) {
      l = { nextStep: [] }
      lanes.set(sid, l)
    }
    return l
  }
  return {
    inject: (sid: string, msg: string) => get(sid).nextStep.push(msg),
    consumeNextStep: (sid: string) => {
      const l = get(sid)
      const out = l.nextStep
      l.nextStep = []
      return out
    },
  }
}

function makeZaiStyleProvider(inbox: ReturnType<typeof makeInbox>) {
  return async (sid: string) => {
    const messages = inbox.consumeNextStep(sid)
    if (messages.length === 0) return null
    const bullets = messages.map((c) => `- bg event: ${c}`).join('\n')
    return (
      '<system-reminder>\n' +
      'The following system events occurred since your last turn.\n' +
      'Use this context when responding to the user.\n' +
      '\n' +
      bullets +
      '\n' +
      '</system-reminder>'
    )
  }
}

describe('e2e: vendor hook + per-session inbox prepend', () => {
  it('empty nextStep → no reminder (no-op when nothing pending)', async () => {
    const inbox = makeInbox()
    registerExtraReminderProvider(makeZaiStyleProvider(inbox))
    const r = await runExtraReminderProviders('sess-empty')
    expect(r).toBeNull()
  })

  it('user steer in nextStep → reminder formatted', async () => {
    const inbox = makeInbox()
    registerExtraReminderProvider(makeZaiStyleProvider(inbox))
    inbox.inject('sess-steer', 'please check the new test')

    const r = await runExtraReminderProviders('sess-steer')
    expect(r).not.toBeNull()
    expect(r).toContain('<system-reminder>')
    expect(r).toContain('- bg event: please check the new test')
    expect(r).toMatch(/<\/system-reminder>$/)

    // 二次 drain 应为空(lane 已被消费)
    const r2 = await runExtraReminderProviders('sess-steer')
    expect(r2).toBeNull()
  })

  it('multi-message + cross-session: each call drains, lanes stay isolated', async () => {
    const inboxA = makeInbox()
    const inboxB = makeInbox()
    registerExtraReminderProvider(makeZaiStyleProvider(inboxA))
    registerExtraReminderProvider(makeZaiStyleProvider(inboxB))

    inboxA.inject('sess-A', 'subagent done')
    inboxA.inject('sess-A', 'task-factory notice')

    // 模拟 vendor 的 3 次连续 API call: A → A → B
    const a1 = await runExtraReminderProviders('sess-A')
    const a2 = await runExtraReminderProviders('sess-A')
    const b1 = await runExtraReminderProviders('sess-B')

    expect(a1).not.toBeNull()
    expect(a1).toContain('- bg event: subagent done')
    expect(a1).toContain('- bg event: task-factory notice')

    // 第一次已 drain 全部,第二次应为空
    expect(a2).toBeNull()

    // sess-B lane 与 sess-A 完全隔离
    expect(b1).toBeNull()
  })
})
