// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3): ReplRuntime slash command routing.
 * Verifies /-prefixed prompts route to stub handlers emitting
 * runtime.notification + runtime.done, NEVER runtime.error.
 * Non-slash prompts pass through unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ReplRuntime } from '../agentRuntime.repl.js'

describe('ReplRuntime slash command routing', () => {
  let runtime: ReplRuntime

  beforeEach(() => {
    runtime = new ReplRuntime()
  })

  afterEach(async () => {
    await runtime.shutdown()
  })

  it('/loop yields loop-scheduled notification + done', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/loop 30s "ping"' })) {
      events.push(ev)
    }
    const notifications = events.filter((e) => e.type === 'runtime.notification')
    expect(notifications.some((n: any) => n.kind === 'loop-scheduled')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('/swarm yields swarm-scheduled notification + done', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/swarm create teammate1' })) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.kind === 'swarm-scheduled')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('/send yields send-scheduled notification + done', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/send sess-123 "hello"' })) {
      events.push(ev)
    }
    expect(events.some((e: any) => e.kind === 'send-scheduled')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('unknown slash command yields unknown-command + done (no error)', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: '/foo bar' })) {
      events.push(ev)
    }
    const errors = events.filter((e) => e.type === 'runtime.error')
    expect(errors).toHaveLength(0)
    expect(events.some((e: any) => e.kind === 'unknown-command')).toBe(true)
    expect(events.some((e) => e.type === 'runtime.done')).toBe(true)
  })

  it('non-slash prompt does NOT trigger slash routing', async () => {
    const events: any[] = []
    const sessionId = `s-${Date.now()}`
    for await (const ev of runtime.query({ sessionId, prompt: 'hello there' })) {
      events.push(ev)
    }
    const notifications = events.filter((e: any) => e.kind === 'loop-scheduled' || e.kind === 'swarm-scheduled' || e.kind === 'send-scheduled' || e.kind === 'unknown-command')
    expect(notifications).toHaveLength(0)
  })
})
