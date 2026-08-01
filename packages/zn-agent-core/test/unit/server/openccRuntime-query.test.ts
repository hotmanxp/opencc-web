import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenccRuntime } from '@zn-ai/zn-agent-core/opencc-server'

describe('createOpenccRuntime', () => {
  async function runtime(extra = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'opencc-runtime-'))
    return createOpenccRuntime({ dataDir, defaultCwd: process.cwd(), runtimeId: 'test', ...extra })
  }

  it('exposes all eight methods', async () => {
    const r = await runtime()
    expect(Object.keys(r).sort()).toEqual(['abort', 'getSession', 'listSessions', 'patchSession', 'query', 'readTranscript', 'removeSession', 'shutdown'].sort())
    await r.shutdown()
  })

  it('preserves vendor event identity fields', async () => {
    const r = await runtime({ query: async function* () {
      yield { type: 'assistant', eventId: 'evt-1', turnIndex: 2, toolUseId: 'tool-1', delta: 'hi' }
      yield { type: 'tool_result', eventId: 'evt-2', turnIndex: 2, toolUseId: 'tool-1' }
      yield { type: 'done', eventId: 'evt-3', turnIndex: 2 }
    } })
    const events = []
    for await (const event of r.query({ sessionId: 'session-1', prompt: 'hello', cwd: process.cwd() })) events.push(event)
    expect(events.map(e => e.type)).toEqual(['assistant', 'tool_result', 'done'])
    expect(events[0]).toMatchObject({ eventId: 'evt-1', turnIndex: 2, toolUseId: 'tool-1', sessionId: 'session-1' })
    expect(events.every(e => e.eventId && Number.isInteger(e.turnIndex) && e.sessionId)).toBe(true)
    await r.shutdown()
  })

  it('delegates session CRUD and makes shutdown idempotent', async () => {
    const r = await runtime()
    const created = await (r as any).__sessions?.create?.()
    expect(created).toBeDefined()
    await r.shutdown()
    await expect(r.shutdown()).resolves.toBeUndefined()
  })
})
