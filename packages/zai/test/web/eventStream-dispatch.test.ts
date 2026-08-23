// packages/zai/test/web/eventStream-dispatch.test.ts
//
// Task 11 — SSE state push plan. (T4 改造: 不再复制 switch, 直接调
// useEventStream 导出的 applyBatch 批量 dispatcher.)
//
// 验证 applyBatch 把 state.* ServerEvent + queue.changed 路由到
// useAgentStore 上对应的 reducer:
//   cwd.changed           → applyCwdChanged
//   bash_task.changed     → applyBashTaskChanged
//   v2_task.changed       → applyV2TaskChanged (opencc-mode 单 task CRUD)
//   v2_task.snapshot      → applyV2TaskSnapshot (dsh-mode 整 list 替换)
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

  // Phase 5P5:dsh-tool-todo whole-list snapshot 走单独 type literal,
  // 路由到独立的 applyV2TaskSnapshot reducer(action=snapshot 整 list 替换)。
  it('routes v2_task.snapshot to applyV2TaskSnapshot', async () => {
    await dispatch({
      type: 'v2_task.snapshot',
      sessionId: 's-dsh',
      tasks: [
        { content: 'fix bug', status: 'in_progress' },
        { content: 'add test', status: 'pending' },
      ],
      action: 'snapshot',
    })
    const stored = useAgentStore.getState().v2TasksBySession['s-dsh']
    expect(stored).toHaveLength(2)
    expect(stored?.[0]).toMatchObject({ id: 'fix bug', subject: 'fix bug', status: 'in_progress' })
    expect(stored?.[1]).toMatchObject({ id: 'add test', status: 'pending' })
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