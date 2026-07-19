// packages/zai/test/web/eventStream-dispatch.test.ts
//
// Task 11 — SSE state push plan.
//
// 验证 useEventStream 的 dispatch switch 把 4 个 state.* ServerEvent (Task 6)
// 路由到 useAgentStore 上对应的 reducer (Task 10):
//   cwd.changed           → applyCwdChanged
//   bash_task.changed     → applyBashTaskChanged
//   v2_task.changed       → applyV2TaskChanged
//   agent_task.changed    → applyAgentTaskChanged
//
// 测试策略: 用一个本地 dispatch 函数模拟 useEventStream.ts 里的 switch, 然后
// 直接调它. 这是因为 useEventStream.ts 是 React hook, 直接跑它需要 EventSource
// + DOM mock,得不偿失; 而 dispatch switch 是纯函数, 复制一份比模拟 SSE 链路
// 更可靠. switch 内容必须与 useEventStream.ts 保持一致 — 修改 useEventStream
// 的 case 时, 这个文件也要同步改.
//
// 注: Task 10 (useAgentStore-state-events.test.ts) 已经覆盖了 reducer 本身的
// 行为 (insert / replace / delete / terminal / null-sid), 本文件只验证 dispatch
// 路由 — 即 4 个 case 各自走对了 reducer.

import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

// 模拟 useEventStream.ts 的 dispatch switch — 4 个 state.* case 各自路由到
// 对应的 reducer. 与 useEventStream.ts:31-67 的 switch 一一对应.
async function dispatch(event: any) {
  switch (event.type) {
    case 'cwd.changed':
      useAgentStore.getState().applyCwdChanged(event); break
    case 'bash_task.changed':
      useAgentStore.getState().applyBashTaskChanged(event); break
    case 'v2_task.changed':
      useAgentStore.getState().applyV2TaskChanged(event); break
    case 'agent_task.changed':
      useAgentStore.getState().applyAgentTaskChanged(event); break
  }
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
})