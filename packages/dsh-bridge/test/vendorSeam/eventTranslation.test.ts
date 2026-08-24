import { describe, expect, it, vi } from 'vitest'
import {
  translateSubagentStart,
  translateSubagentEnd,
  translateSubagentDescriptor,
  translateSubagentState,
  translateSubagentMessage,
  emitLegacyShim,
} from '../../src/vendorSeam/eventTranslation.js'

describe('eventTranslation', () => {
  it('translateSubagentStart maps vendor payload to zai', () => {
    const r = translateSubagentStart('s1', {
      runId: 'r1', provider: 'spawn', id: 'dsh-task-x', local: true, parentSessionId: 'p1',
    })
    expect(r.type).toBe('subagent.start')
    expect(r.runId).toBe('r1')
    expect(r.sessionId).toBe('s1')
  })

  it('translateSubagentEnd maps stopReason + lastAssistantMessage', () => {
    const r = translateSubagentEnd('s1', {
      runId: 'r1', provider: 'spawn', id: 'x', local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    expect(r.stopReason).toBe('completed')
    expect(r.lastAssistantMessage).toHaveLength(1)
  })

  it('translateSubagentDescriptor maps mode/provider/persona/toolFilter', () => {
    const r = translateSubagentDescriptor('s1', 'r1', {
      version: 2, mode: 'continuable', provider: 'fork',
      persona: 'p', toolFilter: ['Read'],
    })
    expect(r.mode).toBe('continuable')
    expect(r.provider).toBe('fork')
    expect(r.toolFilter).toEqual(['Read'])
  })

  it('translateSubagentState maps running/waiting/settled', () => {
    for (const s of ['running', 'waiting', 'settled'] as const) {
      const r = translateSubagentState('s1', 'r1', s)
      expect(r.state).toBe(s)
    }
  })

  it('translateSubagentMessage passes blocks', () => {
    const r = translateSubagentMessage('s1', 'r1', [
      { type: 'text', text: 'hi' },
    ])
    expect(r.blocks).toHaveLength(1)
  })

  it('emitLegacyShim emits subagent.changed and warns', () => {
    const bus = { emit: vi.fn() }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    emitLegacyShim(bus as never, {
      type: 'subagent.start',
      ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subagent.changed',
      taskId: 'r1',
      status: 'running',
      action: 'start',
    }))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('emitLegacyShim maps subagent.end stopReason to status', () => {
    const bus = { emit: vi.fn() }
    emitLegacyShim(bus as never, {
      type: 'subagent.end',
      ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true, stopReason: 'aborted',
    })
    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      action: 'finish',
    }))
  })
})
