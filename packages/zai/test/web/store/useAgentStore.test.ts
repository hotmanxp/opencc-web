import { describe, expect, it } from 'vitest'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.js'

describe('useAgentStore subagent reducer', () => {
  it('applySubagentStart 在 subagentTasksBySession 添加 running 任务', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r1')
    expect(t?.status).toBe('running')
  })

  it('applySubagentEnd 把任务状态改为 done + lastAssistantMessage', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r2',
      provider: 'spawn', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentEnd({
      type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r2',
      provider: 'spawn', id: 'x', local: true, stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'hi' }],
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r2')
    expect(t?.status).toBe('done')
    expect(t?.lastAssistantMessage).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('applySubagentState 改 running/waiting/settled', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r3',
      provider: 'spawn', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentState({
      type: 'subagent.state', ts: 0, sessionId: 's1', runId: 'r3', state: 'waiting',
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r3')
    expect(t?.state).toBe('waiting')
  })

  it('applySubagentDescriptor 写入 descriptor 字段', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r4',
      provider: 'fork', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentDescriptor({
      type: 'subagent.descriptor', ts: 0, sessionId: 's1', runId: 'r4',
      version: 2, mode: 'one-shot', provider: 'fork', label: 'investigate', persona: 'p', toolFilter: ['Read'],
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r4')
    expect(t?.descriptor?.provider).toBe('fork')
    expect(t?.descriptor?.persona).toBe('p')
  })

  it('applySubagentMessage 累积 blocks', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start', ts: 0, sessionId: 's1', runId: 'r5',
      provider: 'spawn', id: 'x', local: true,
    })
    useAgentStore.getState().applySubagentMessage({
      type: 'subagent.message', ts: 0, sessionId: 's1', runId: 'r5',
      blocks: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'answer' }],
    })
    const t = useAgentStore.getState().subagentTasksBySession['s1']?.find(x => x.taskId === 'r5')
    expect(t?.blocks).toHaveLength(2)
  })
})
