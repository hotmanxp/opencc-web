import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerExtraReminderProvider,
  runExtraReminderProviders,
  clearExtraReminderProviders,
} from '../../../../src/opencc-src/utils/daemon/preApiCallReminders.js'

describe('preApiCallReminders registry', () => {
  beforeEach(() => {
    clearExtraReminderProviders()
  })

  it('returns null when no providers registered', async () => {
    expect(await runExtraReminderProviders('sess-x')).toBeNull()
  })

  it('invokes provider per call (simulating vendor per-API-call hook)', async () => {
    let calls = 0
    registerExtraReminderProvider(async (sid) => {
      calls++
      return `<system-reminder>${sid}#${calls}</system-reminder>`
    })

    // 模拟 vendor query.ts:701 在多 turn 多 API call 中调用
    const r1 = await runExtraReminderProviders('sess-A')
    const r2 = await runExtraReminderProviders('sess-A')
    const r3 = await runExtraReminderProviders('sess-B')

    expect(calls).toBe(3) // 每次 API call 都触发
    expect(r1).toContain('sess-A#1')
    expect(r2).toContain('sess-A#2')
    expect(r3).toContain('sess-B#3') // 跨 session 独立
  })

  it('concatenates multiple providers with \\n\\n', async () => {
    registerExtraReminderProvider(async () => '<system-reminder>A</system-reminder>')
    registerExtraReminderProvider(async () => '<system-reminder>B</system-reminder>')

    const result = await runExtraReminderProviders('sess')
    expect(result).toBe(
      '<system-reminder>A</system-reminder>\n\n<system-reminder>B</system-reminder>',
    )
  })

  it('skips null/empty providers and only includes the rest', async () => {
    registerExtraReminderProvider(async () => '<system-reminder>A</system-reminder>')
    registerExtraReminderProvider(async () => null)
    registerExtraReminderProvider(async () => '')
    registerExtraReminderProvider(async () => '<system-reminder>D</system-reminder>')

    const result = await runExtraReminderProviders('sess')
    expect(result).toBe('<system-reminder>A</system-reminder>\n\n<system-reminder>D</system-reminder>')
  })

  it('survives provider errors and runs the rest', async () => {
    registerExtraReminderProvider(async () => {
      throw new Error('provider 1 broken')
    })
    registerExtraReminderProvider(async () => '<system-reminder>B</system-reminder>')

    // 不应 throw,应继续执行
    const result = await runExtraReminderProviders('sess')
    expect(result).toBe('<system-reminder>B</system-reminder>')
  })
})
