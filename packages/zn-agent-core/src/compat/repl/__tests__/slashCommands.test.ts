// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3): parseSlashCommand unit tests.
 * Covers quote-aware token splitting for /-prefixed inputs and
 * KNOWN_SLASH_COMMANDS / isKnownSlashCommand type guard.
 *
 * NOTE: setupCommandQueue.ts imports messageQueueManager which has a
 * deep import chain that triggers BashTool.tsx evaluation via tools.ts →
 * AgentTool.tsx → agentColorManager → state.ts circular dep. Under
 * vitest ESM, this causes getMaxTimeoutMs to be undefined at prompt.ts
 * evaluation time. We mock messageQueueManager to isolate the test from
 * this pre-existing environmental issue (same pattern as
 * setupCommandQueue.test.ts).
 */
import { vi, describe, it, expect } from 'vitest'

let mockQueue: Array<{ value: string; mode: string; priority?: string; uuid?: string }> = []

vi.mock('../../../opencc-src/utils/messageQueueManager.js', () => {
  const PRIORITY_ORDER: Record<string, number> = { now: 0, next: 1, later: 2 }
  return {
    getCommandQueue: () => [...mockQueue],
    enqueue: (cmd: { value: string; mode: string; priority?: string; uuid?: string }) => {
      mockQueue.push({ ...cmd, priority: cmd.priority ?? 'next' })
    },
    dequeue: () => {
      if (mockQueue.length === 0) return undefined
      let bestIdx = -1
      let bestPriority = Infinity
      for (let i = 0; i < mockQueue.length; i++) {
        const p = PRIORITY_ORDER[mockQueue[i]!.priority ?? 'next'] ?? 1
        if (p < bestPriority) {
          bestPriority = p
          bestIdx = i
        }
      }
      if (bestIdx === -1) return undefined
      const [item] = mockQueue.splice(bestIdx, 1)
      return item
    },
    resetCommandQueue: () => { mockQueue = [] },
  }
})

// Import after mock is set up
import {
  parseSlashCommand,
  KNOWN_SLASH_COMMANDS,
  isKnownSlashCommand,
} from '../setup/setupCommandQueue.js'

describe('parseSlashCommand', () => {
  it('parses /loop with duration and message', () => {
    const result = parseSlashCommand('/loop 30s "ping"')
    expect(result).toEqual({
      command: 'loop',
      args: ['30s', 'ping'],
      raw: '/loop 30s "ping"',
    })
  })

  it('parses /swarm with subcommand', () => {
    const result = parseSlashCommand('/swarm create teammate1')
    expect(result).toEqual({
      command: 'swarm',
      args: ['create', 'teammate1'],
      raw: '/swarm create teammate1',
    })
  })

  it('parses /send with sessionId and message', () => {
    const result = parseSlashCommand('/send sess-123 "hello"')
    expect(result).toEqual({
      command: 'send',
      args: ['sess-123', 'hello'],
      raw: '/send sess-123 "hello"',
    })
  })

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('hi there')).toBeNull()
  })

  it('returns parsed shape for unknown slash command', () => {
    const result = parseSlashCommand('/foo bar')
    expect(result?.command).toBe('foo')
    expect(result?.args).toEqual(['bar'])
  })
})

describe('KNOWN_SLASH_COMMANDS + isKnownSlashCommand', () => {
  it('contains loop, swarm, send', () => {
    expect(KNOWN_SLASH_COMMANDS).toEqual(['loop', 'swarm', 'send'])
  })

  it('isKnownSlashCommand returns true for known commands', () => {
    expect(isKnownSlashCommand('loop')).toBe(true)
    expect(isKnownSlashCommand('swarm')).toBe(true)
    expect(isKnownSlashCommand('send')).toBe(true)
  })

  it('isKnownSlashCommand returns false for unknown commands', () => {
    expect(isKnownSlashCommand('foo')).toBe(false)
    expect(isKnownSlashCommand('unknown')).toBe(false)
  })

  it('handles single-quoted args', () => {
    const result = parseSlashCommand("/loop 5m 'ping pong'")
    expect(result).toEqual({
      command: 'loop',
      args: ['5m', 'ping pong'],
      raw: "/loop 5m 'ping pong'",
    })
  })

  it('returns null for empty slash input', () => {
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('/   ')).toBeNull()
  })
})
