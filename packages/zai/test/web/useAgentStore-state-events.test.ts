// packages/zai/test/web/useAgentStore-state-events.test.ts
//
// Task 10 — SSE state push plan.
//
// 验证 useAgentStore 新增的 4 个 reducer (applyCwdChanged / applyBashTaskChanged
// / applyV2TaskChanged / applyAgentTaskChanged) 正确地写入对应的
// per-session map. 这是 SSE state push 客户端路径的第一步: reducer 落地后,
// Task 11 才会把 useEventStream 收到 state.* ServerEvent dispatch 到这里.
//
// 注意: 4 个 reducer 接收 ServerEvent union 中的具体子类型 (brief Step 3),
// 但 reducer 内部对 payload 字段名做 lenient access (兼容 server 端 zod
// schema 的可选/必填差异). 这一点与 eventSource.ts 现有的 pattern 一致.

import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

describe('useAgentStore state event reducers', () => {
  beforeEach(() => {
    useAgentStore.setState({
      cwdBySession: {},
      bashTasksBySession: {},
      agentTasksBySession: {},
      v2TasksBySession: {},
    })
  })

  it('applyCwdChanged stores cwd by sessionId', () => {
    useAgentStore.getState().applyCwdChanged({ sessionId: 's1', cwd: '/tmp' })
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/tmp')
  })

  it('applyBashTaskChanged inserts new task', () => {
    const task = { taskId: 'b1', status: 'running', sessionId: 's1' } as any
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task })
    expect(useAgentStore.getState().bashTasksBySession['s1']).toEqual([task])
  })

  it('applyBashTaskChanged replaces existing task with same id', () => {
    const t1 = { taskId: 'b1', status: 'running', stdout: 'a' } as any
    const t2 = { taskId: 'b1', status: 'running', stdout: 'b' } as any
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t1 })
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t2 })
    const list = useAgentStore.getState().bashTasksBySession['s1']
    expect(list).toHaveLength(1)
    expect(list[0].stdout).toBe('b')
  })

  it('applyBashTaskChanged terminal status deletes old entry and prepends terminal', () => {
    const t1 = { taskId: 'b1', status: 'running' } as any
    const t2 = { taskId: 'b1', status: 'completed' } as any
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t1 })
    useAgentStore.getState().applyBashTaskChanged({ sessionId: 's1', task: t2 })
    const list = useAgentStore.getState().bashTasksBySession['s1']
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('completed')
  })

  it('applyV2TaskChanged upsert inserts', () => {
    const task = { id: 't1', subject: 'thing' } as any
    useAgentStore.getState().applyV2TaskChanged({ sessionId: 's1', task, action: 'upsert' })
    expect(useAgentStore.getState().v2TasksBySession['s1']).toEqual([task])
  })

  it('applyV2TaskChanged delete removes', () => {
    const task = { id: 't1' } as any
    useAgentStore.getState().applyV2TaskChanged({ sessionId: 's1', task, action: 'upsert' })
    useAgentStore.getState().applyV2TaskChanged({ sessionId: 's1', task, action: 'delete' })
    expect(useAgentStore.getState().v2TasksBySession['s1']).toEqual([])
  })

  it('applyAgentTaskChanged with sid stores under map', () => {
    const task = { id: 'a1', status: 'running', input: { prompt: 'do thing' } } as any
    useAgentStore.getState().applyAgentTaskChanged({ sessionId: 's1', task })
    const list = useAgentStore.getState().agentTasksBySession['s1']
    expect(list).toHaveLength(1)
    expect(list[0].taskId).toBe('a1')
    expect(list[0].lastKnownSessionId).toBe('s1')
  })

  it('applyAgentTaskChanged with null sid is no-op', () => {
    const task = { id: 'a1', status: 'running' } as any
    useAgentStore.getState().applyAgentTaskChanged({ sessionId: null, task })
    expect(useAgentStore.getState().agentTasksBySession).toEqual({})
  })
})