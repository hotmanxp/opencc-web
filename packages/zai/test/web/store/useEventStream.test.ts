import { describe, expect, it, vi } from 'vitest'
import { applyBatch } from '../../../src/web/src/store/useEventStream.js'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.js'

describe('useEventStream subagent 事件分发', () => {
  it('subagent.start 调 applySubagentStart', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentStart')
    applyBatch([{
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    }])
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.end 调 applySubagentEnd', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentEnd')
    applyBatch([{
      type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true, stopReason: 'completed',
    }])
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.descriptor 调 applySubagentDescriptor', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentDescriptor')
    applyBatch([{
      type: 'subagent.descriptor', ts: 0, sessionId: 's1', runId: 'r1',
      version: 2, mode: 'one-shot', provider: 'spawn',
    }])
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.state 调 applySubagentState', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentState')
    applyBatch([{
      type: 'subagent.state', ts: 0, sessionId: 's1', runId: 'r1',
      state: 'running',
    }])
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.message 调 applySubagentMessage', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentMessage')
    applyBatch([{
      type: 'subagent.message', ts: 0, sessionId: 's1', runId: 'r1',
      blocks: [{ type: 'text', text: 'hello' }],
    }])
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.error 调 applySubagentError', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentError')
    applyBatch([{
      type: 'subagent.error', ts: 0, sessionId: 's1', runId: 'r1',
      message: 'something went wrong',
    }])
    expect(spy).toHaveBeenCalled()
  })

  it('subagent.changed 仍调 applySubagentChanged（deprecated）', () => {
    const spy = vi.spyOn(useAgentStore.getState(), 'applySubagentChanged')
    applyBatch([{
      type: 'subagent.changed', ts: 0, sessionId: 's1', runId: 'r1',
      action: 'start', task: {} as any, parentSessionId: 'p1',
    }])
    expect(spy).toHaveBeenCalled()
  })
})
