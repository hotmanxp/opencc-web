import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  localAgentTaskToBackgroundTask,
  wrapTaskAwareSetState,
  type LocalAgentTaskLike,
} from '../../../src/compat/runtime/agentTaskBridge.js'
import {
  resetStateChangeBusForTests,
  stateChangeBus,
} from '../../../src/stateChangeBus.js'

function localAgentTask(partial: Partial<LocalAgentTaskLike>): LocalAgentTaskLike {
  return {
    id: 'agent-123',
    type: 'local_agent',
    status: 'running',
    prompt: 'list files',
    agentType: 'general-purpose',
    description: 'list files',
    startTime: 1000,
    ...partial,
  }
}

describe('localAgentTaskToBackgroundTask', () => {
  it('maps core fields to BackgroundTask shape', () => {
    const bg = localAgentTaskToBackgroundTask(
      localAgentTask({ id: 'agent-1', startTime: 1234 }),
      'sess-A',
    )
    expect(bg.id).toBe('agent-1')
    expect(bg.status).toBe('running')
    expect(bg.input.prompt).toBe('list files')
    expect(bg.createdAt).toBe(1234)
    expect(bg.startedAt).toBe(1234)
    expect(bg.parentSessionId).toBe('sess-A')
    expect(bg.agentType).toBe('general-purpose')
    expect(bg.description).toBe('list files')
    expect(bg.eventCount).toBe(0)
  })

  it('maps statuses: pending→queued, completed→completed, failed→failed, killed→cancelled', () => {
    expect(localAgentTaskToBackgroundTask(localAgentTask({ status: 'pending' }), 's').status).toBe('queued')
    expect(localAgentTaskToBackgroundTask(localAgentTask({ status: 'completed' }), 's').status).toBe('completed')
    expect(localAgentTaskToBackgroundTask(localAgentTask({ status: 'failed' }), 's').status).toBe('failed')
    expect(localAgentTaskToBackgroundTask(localAgentTask({ status: 'killed' }), 's').status).toBe('cancelled')
  })

  it('carries finishedAt and error message', () => {
    const bg = localAgentTaskToBackgroundTask(
      localAgentTask({ status: 'failed', endTime: 5000, error: 'boom' }),
      'sess-A',
    )
    expect(bg.finishedAt).toBe(5000)
    expect(bg.error).toEqual({ message: 'boom', category: 'internal' })
  })

  it('normalizes object-form error to { message, category }', () => {
    const bg = localAgentTaskToBackgroundTask(
      localAgentTask({ error: { message: 'oops' } }),
      's',
    )
    expect(bg.error?.message).toBe('oops')
  })
})

describe('wrapTaskAwareSetState', () => {
  let emitted: Array<{ sessionId: string | null; task: unknown }>
  const originalBus = (globalThis as { __zaiEventBus?: unknown }).__zaiEventBus

  beforeEach(() => {
    emitted = []
    stateChangeBus.on('agent_task.changed', (payload) => {
      emitted.push(payload)
    })
  })

  afterEach(() => {
    resetStateChangeBusForTests()
    // 清理 __zaiEventBus 测试注入,避免泄漏到其它用例
    const g = globalThis as unknown as { __zaiEventBus?: unknown }
    if (originalBus === undefined) {
      delete g.__zaiEventBus
    } else {
      g.__zaiEventBus = originalBus
    }
  })

  it('prefers globalThis.__zaiEventBus when present (in-bundle → server bridge)', () => {
    const viaGlobal: unknown[] = []
    ;(globalThis as unknown as { __zaiEventBus: { emit: (e: unknown) => void } }).__zaiEventBus = {
      emit: (e) => {
        viaGlobal.push(e)
      },
    }
    const { wrapped } = makeSetState()
    wrapped((prev) => ({
      ...prev,
      tasks: { 'agent-1': localAgentTask({ id: 'agent-1' }) },
    }))
    // 走了全局通道, stateChangeBus 不收到
    expect(emitted).toHaveLength(0)
    expect(viaGlobal).toHaveLength(1)
    const ev = viaGlobal[0] as { type: string; sessionId: string; task: { id: string } }
    expect(ev.type).toBe('agent_task.changed')
    expect(ev.sessionId).toBe('sess-parent')
    expect(ev.task.id).toBe('agent-1')
  })

  function makeSetState() {
    let state: Record<string, unknown> = { tasks: {} }
    const setState = (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      state = updater(state)
    }
    const wrapped = wrapTaskAwareSetState(
      setState,
      vi.fn(() => 'sess-parent'),
    )
    return { setState, wrapped }
  }

  it('emits agent_task.changed when a local_agent task is registered', () => {
    const { wrapped } = makeSetState()
    wrapped((prev) => ({
      ...prev,
      tasks: {
        'agent-1': localAgentTask({ id: 'agent-1' }),
      },
    }))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.sessionId).toBe('sess-parent')
    const task = emitted[0]?.task as { id: string; status: string; input: { prompt: string } }
    expect(task.id).toBe('agent-1')
    expect(task.status).toBe('running')
    expect(task.input.prompt).toBe('list files')
  })

  it('emits again when the task status transitions', () => {
    const { wrapped } = makeSetState()
    wrapped((prev) => ({
      ...prev,
      tasks: { 'agent-1': localAgentTask({ id: 'agent-1' }) },
    }))
    wrapped((prev) => ({
      ...prev,
      tasks: {
        'agent-1': localAgentTask({ id: 'agent-1', status: 'completed', endTime: 2000 }),
      },
    }))
    expect(emitted).toHaveLength(2)
    expect((emitted[1]?.task as { status: string }).status).toBe('completed')
  })

  it('skips non-local_agent tasks', () => {
    const { wrapped } = makeSetState()
    wrapped((prev) => ({
      ...prev,
      tasks: { 'bash-1': { id: 'bash-1', type: 'local_shell', status: 'running' } },
    }))
    expect(emitted).toHaveLength(0)
  })

  it('skips emit when sessionId is unavailable', () => {
    let state: Record<string, unknown> = { tasks: {} }
    const setState = (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      state = updater(state)
    }
    const wrapped = wrapTaskAwareSetState(setState, vi.fn(() => null))
    wrapped((prev) => ({
      ...prev,
      tasks: { 'agent-1': localAgentTask({ id: 'agent-1' }) },
    }))
    expect(emitted).toHaveLength(0)
  })

  it('does not emit on no-op updates (same tasks reference)', () => {
    const { wrapped } = makeSetState()
    wrapped((prev) => prev)
    expect(emitted).toHaveLength(0)
  })

  it('emits a terminal completed event when a running local_agent task is removed (sync foreground completion)', () => {
    const { wrapped } = makeSetState()
    wrapped((prev) => ({
      ...prev,
      tasks: { 'agent-1': localAgentTask({ id: 'agent-1' }) },
    }))
    // 同步路径完成时 unregisterAgentForeground 直接删除任务 → 补发 completed
    wrapped((prev) => {
      const { 'agent-1': _removed, ...rest } = prev.tasks as Record<string, unknown>
      void _removed
      return { ...prev, tasks: rest }
    })
    expect(emitted).toHaveLength(2)
    const terminal = emitted[1]?.task as { status: string; finishedAt?: number }
    expect(terminal.status).toBe('completed')
    expect(terminal.finishedAt).toBeGreaterThan(0)
  })

  it('preserves failed status when a failed task is removed (eviction)', () => {
    const { wrapped } = makeSetState()
    wrapped((prev) => ({
      ...prev,
      tasks: { 'agent-1': localAgentTask({ id: 'agent-1', status: 'failed', error: 'boom' }) },
    }))
    wrapped((prev) => {
      const { 'agent-1': _removed, ...rest } = prev.tasks as Record<string, unknown>
      void _removed
      return { ...prev, tasks: rest }
    })
    expect(emitted).toHaveLength(2)
    expect((emitted[1]?.task as { status: string }).status).toBe('failed')
  })
})
