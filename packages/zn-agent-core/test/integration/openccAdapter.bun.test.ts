/**
 * Bun-gated integration tests for openccAdapter.
 *
 * These tests require Bun runtime due to opencc's `bun:bundle` imports.
 * vitest config in packages/zn-agent-core/vitest.config.ts must include
 * this file with `bun test` runner, OR these tests can be run via:
 *
 *   bun --cwd packages/zn-agent-core vitest run test/integration/openccAdapter.bun.test.ts
 *
 * They will be skipped under Node (where bun:bundle imports fail).
 */

import { describe, expect, it } from 'vitest'
import { runOpenccQuery } from '../../src/compat/runtime/openccAdapter.js'
import type { QueryOptions } from '../../src/compat/runtime/types.js'

const isBun = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions?.bun === 'string'

const itBun = isBun() ? it : it.skip

describe('runOpenccQuery (Bun integration)', () => {
  itBun('streams text deltas enriched with RuntimeEvent meta', async () => {
    const opts = {
      prompt: { role: 'user', content: 'Say "hello"' },
      cwd: '/tmp',
      model: 'MiniMax-M3',
      tools: [],
      sessionId: 'integration-test-1',
      abortSignal: new AbortController().signal,
    } as QueryOptions

    const events: any[] = []
    for await (const ev of runOpenccQuery(opts, {})) {
      events.push(ev)
      if (ev.type === 'message_stop') break
      if (events.length > 100) break // safety
    }

    // Should have at least message_start + content_block_delta + message_stop
    const types = events.map((e) => e.type)
    expect(types).toContain('message_start')
    expect(types).toContain('message_stop')

    // All events should have RuntimeEvent meta fields
    for (const ev of events) {
      expect(ev.eventId).toMatch(/^evt-\d+$/)
      expect(ev.sessionId).toBe('integration-test-1')
      expect(typeof ev.ts).toBe('number')
      expect(typeof ev.turnIndex).toBe('number')
    }
  }, 30_000)

  itBun('honors pre-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort('integration-test-cancel')

    const opts = {
      prompt: { role: 'user', content: 'anything' },
      cwd: '/tmp',
      model: 'MiniMax-M3',
      tools: [],
      sessionId: 'integration-test-2',
      abortSignal: ac.signal,
    } as QueryOptions

    const events: any[] = []
    for await (const ev of runOpenccQuery(opts, {})) {
      events.push(ev)
    }

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('runtime.aborted')
    expect(events[0].reason).toBe('integration-test-cancel')
  })
})
