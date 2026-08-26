// packages/zai/test/web/eventStream-dispatch.test.ts
//
// Task 11 — SSE state push plan. (T4 改造: 不再复制 switch, 直接调
// useEventStream 导出的 applyBatch 批量 dispatcher.)
//
// 验证 applyBatch 把 4 个 state.* ServerEvent + queue.changed 路由到
// useAgentStore 上对应的 reducer:
//   cwd.changed           → applyCwdChanged
//   bash_task.changed     → applyBashTaskChanged
//   v2_task.changed       → applyV2TaskChanged
//   agent_task.changed    → applyAgentTaskChanged
//
// 注: useAgentStore-state-events.test.ts 已覆盖 reducer 本身的行为, 本文件
// 只验证 dispatch 路由 — 即各 case 走对了 reducer。

import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import { applyBatch } from '../../src/web/src/store/useEventStream.js'

// 直接把单事件喂给导出的 applyBatch — 与 useEventStream 的批量 dispatcher
// 完全一致, 不再维护一份复制的 switch.
async function dispatch(event: any) {
  applyBatch([event])
}

describe('eventStream dispatch routing', () => {
  beforeEach(() => {
    useAgentStore.setState({
      cwdBySession: {},
      bashTasksBySession: {},
      agentTasksBySession: {},
      v2TasksBySession: {},
    })
  })

  it('routes cwd.changed to applyCwdChanged', async () => {
    await dispatch({ type: 'cwd.changed', sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/tmp')
  })

  it('routes bash_task.changed to applyBashTaskChanged', async () => {
    const task = { taskId: 'b1', status: 'running', sessionId: 's1' }
    await dispatch({ type: 'bash_task.changed', sessionId: 's1', task })
    expect(useAgentStore.getState().bashTasksBySession['s1']).toHaveLength(1)
  })

  it('routes v2_task.changed to applyV2TaskChanged', async () => {
    const task = { id: 't1' }
    await dispatch({ type: 'v2_task.changed', sessionId: 's1', task, action: 'upsert' })
    expect(useAgentStore.getState().v2TasksBySession['s1']).toHaveLength(1)
  })

  it('routes agent_task.changed to applyAgentTaskChanged', async () => {
    const task = { id: 'a1', status: 'running', input: { prompt: 'p' } }
    await dispatch({ type: 'agent_task.changed', sessionId: 's1', task })
    expect(useAgentStore.getState().agentTasksBySession['s1']).toHaveLength(1)
  })

  it('routes queue.changed to applyQueueChanged', async () => {
    await dispatch({
      type: 'queue.changed',
      sessionId: 's1',
      running: true,
      queueLength: 2,
      pending: [{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }],
    })
    expect(useAgentStore.getState().queuedPrompts).toEqual([
      { id: 'q1', text: 'first' },
      { id: 'q2', text: 'second' },
    ])
  })
})