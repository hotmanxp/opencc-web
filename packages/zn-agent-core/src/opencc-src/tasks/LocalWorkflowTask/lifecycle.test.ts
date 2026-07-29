import { afterEach, describe, expect, test } from 'bun:test'
import type { SetAppState } from '../../Task.ts'
import type { AppState } from '../../state/AppStateStore.js'
import type { WorkflowAgentState } from '../../tools/WorkflowTool/types.ts'
import { LocalWorkflowTask } from './LocalWorkflowTask.ts'
import {
  findWorkflowTask,
  killWorkflowTask,
  registerWorkflowInAppState,
  registerWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  unregisterWorkflowTask,
} from './lifecycle.ts'
import type { LocalWorkflowTaskState } from './state.ts'

const sampleWorkflow = {
  name: 'echo',
  source: 'bundled' as const,
  path: '<bundled>',
  run: async () => 'echo',
}

/**
 * Build a duck-typed LocalWorkflowTask with a controllable state. We avoid
 * invoking the real class here because lifecycle tests should not depend on
 * the scheduler bridge — they just need a task object whose `state.agents`
 * is mutable and whose `stop()` is observable.
 */
function makeFakeTask(overrides: Partial<LocalWorkflowTaskState> = {}): LocalWorkflowTask {
  const state: LocalWorkflowTaskState = {
    id: `wf_${Math.random().toString(16).slice(2, 10)}`,
    type: 'local_workflow',
    name: 'echo',
    description: 'Workflow: echo',
    status: 'pending',
    args: [],
    script: '',
    startedAt: Date.now(),
    startTime: Date.now(),
    agents: [],
    totalCostUsd: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    ...overrides,
  }
  // Cast through `unknown` so we can satisfy the public class type with a
  // minimal hand-rolled instance. We only need the shape the lifecycle
  // helpers touch (state + stop).
  return {
    state,
    name: 'LocalWorkflowTask',
    type: 'local_workflow',
    id: state.id,
    stop: () => {
      state.status = 'killed'
      state.completedAt = Date.now()
    },
    kill: async () => {
      state.status = 'killed'
      state.completedAt = Date.now()
    },
    pause: () => {
      state.status = 'paused'
    },
  } as unknown as LocalWorkflowTask
}

function makeAgent(overrides: Partial<WorkflowAgentState> = {}): WorkflowAgentState {
  return {
    id: 'agent-1',
    prompt: 'do something',
    status: 'pending',
    ...overrides,
  }
}

describe('LocalWorkflowTask lifecycle', () => {
  // LocalWorkflowTask's constructor auto-registers, so any test that uses a
  // real instance will leak entries into the registry between cases. Clear
  // them all out after each test to keep the suite hermetic.
  afterEach(() => {
    for (const task of new Set([
      ...((globalThis as { __wfRegistered?: Set<string> }).__wfRegistered ?? new Set<string>()),
    ])) {
      unregisterWorkflowTask(task)
    }
  })

  test('register -> find -> unregister lifecycle', () => {
    const task = makeFakeTask({ id: 'wf_aaaa1111' })
    registerWorkflowTask(task)
    expect(findWorkflowTask('wf_aaaa1111')).toBe(task)
    unregisterWorkflowTask('wf_aaaa1111')
    expect(findWorkflowTask('wf_aaaa1111')).toBeNull()
  })

  test('register is idempotent — re-registering overwrites the entry', () => {
    const a = makeFakeTask({ id: 'wf_aaaa2222' })
    const b = makeFakeTask({ id: 'wf_aaaa2222' })
    registerWorkflowTask(a)
    registerWorkflowTask(b)
    expect(findWorkflowTask('wf_aaaa2222')).toBe(b)
  })

  test('findWorkflowTask returns null for unknown id', () => {
    expect(findWorkflowTask('wf_does_not_exist')).toBeNull()
  })

  test('LocalWorkflowTask constructor auto-registers the task', () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: undefined })
    // The task's id is auto-generated (wf_<8 hex>); look it up by its
    // exposed id rather than guessing the suffix.
    expect(findWorkflowTask(task.id)).toBe(task)
    unregisterWorkflowTask(task.id)
  })

  test('killWorkflowTask on missing id returns false', () => {
    expect(killWorkflowTask('wf_missing_xxxx')).toBe(false)
  })

  test('killWorkflowTask on registered task returns true and transitions to killed', () => {
    const task = makeFakeTask({ id: 'wf_aaaa3333' })
    registerWorkflowTask(task)
    expect(killWorkflowTask('wf_aaaa3333')).toBe(true)
    expect(task.state.status).toBe('killed')
    expect(task.state.completedAt).toBeDefined()
  })

  test('skipWorkflowAgent on a pending agent sets status to skipped', () => {
    const agent = makeAgent({ id: 'agent-1', status: 'pending' })
    const task = makeFakeTask({ id: 'wf_aaaa4444', agents: [agent] })
    registerWorkflowTask(task)
    expect(skipWorkflowAgent('wf_aaaa4444', 'agent-1')).toBe(true)
    expect(agent.status).toBe('skipped')
    expect(agent.completedAt).toBeDefined()
  })

  test('skipWorkflowAgent on a running agent sets status to skipped', () => {
    const agent = makeAgent({ id: 'agent-1', status: 'running' })
    const task = makeFakeTask({ id: 'wf_aaaa5555', agents: [agent] })
    registerWorkflowTask(task)
    expect(skipWorkflowAgent('wf_aaaa5555', 'agent-1')).toBe(true)
    expect(agent.status).toBe('skipped')
  })

  test('skipWorkflowAgent on a completed agent returns false', () => {
    const agent = makeAgent({ id: 'agent-1', status: 'completed' })
    const task = makeFakeTask({ id: 'wf_aaaa6666', agents: [agent] })
    registerWorkflowTask(task)
    expect(skipWorkflowAgent('wf_aaaa6666', 'agent-1')).toBe(false)
    expect(agent.status).toBe('completed')
  })

  test('skipWorkflowAgent on a failed agent returns false', () => {
    const agent = makeAgent({ id: 'agent-1', status: 'failed' })
    const task = makeFakeTask({ id: 'wf_aaaa7777', agents: [agent] })
    registerWorkflowTask(task)
    expect(skipWorkflowAgent('wf_aaaa7777', 'agent-1')).toBe(false)
    expect(agent.status).toBe('failed')
  })

  test('skipWorkflowAgent on missing task returns false', () => {
    expect(skipWorkflowAgent('wf_missing', 'agent-1')).toBe(false)
  })

  test('skipWorkflowAgent on missing agent returns false', () => {
    const task = makeFakeTask({ id: 'wf_aaaa8888' })
    registerWorkflowTask(task)
    expect(skipWorkflowAgent('wf_aaaa8888', 'no-such-agent')).toBe(false)
  })

  test('retryWorkflowAgent on a failed agent returns the prompt', () => {
    const agent = makeAgent({ id: 'agent-1', status: 'failed', prompt: 'try again' })
    const task = makeFakeTask({ id: 'wf_aaaa9999', agents: [agent] })
    registerWorkflowTask(task)
    expect(retryWorkflowAgent('wf_aaaa9999', 'agent-1')).toEqual({ prompt: 'try again' })
  })

  test('retryWorkflowAgent on a completed agent returns null', () => {
    const agent = makeAgent({ id: 'agent-1', status: 'completed' })
    const task = makeFakeTask({ id: 'wf_aaaa0000', agents: [agent] })
    registerWorkflowTask(task)
    expect(retryWorkflowAgent('wf_aaaa0000', 'agent-1')).toBeNull()
  })

  test('retryWorkflowAgent on missing task returns null', () => {
    expect(retryWorkflowAgent('wf_missing', 'agent-1')).toBeNull()
  })

  test('unregisterWorkflowTask is a no-op for unknown id', () => {
    expect(() => unregisterWorkflowTask('wf_never_seen')).not.toThrow()
  })
})

/**
 * Helper: build a minimal mock AppState + SetAppState. The state lives
 * in a closure so the test can inspect it after a register/unregister
 * cycle without needing a full React tree. The mock actually persists
 * the updated state into the closure (matches the React setState
 * contract: re-renders see the new reference).
 */
function makeMockAppState(): {
  state: AppState
  setAppState: SetAppState
} {
  const state: AppState = {
    tasks: {},
    workflows: {},
  } as unknown as AppState
  const setAppState: SetAppState = updater => {
    // Apply the updater to the state object, mutating slices in place
    // so the test's reference to `state` stays valid.
    const next = updater(state)
    if (next.tasks) state.tasks = next.tasks
    if (next.workflows) state.workflows = next.workflows
    return state
  }
  return { state, setAppState }
}

describe('LocalWorkflowTask appState registration', () => {
  test('registerWorkflowInAppState adds the task to BOTH appState.workflows AND appState.tasks', () => {
    const task = makeFakeTask({ id: 'wf_dual_aaaa', status: 'running' })
    const { state, setAppState } = makeMockAppState()
    const unregister = registerWorkflowInAppState(task, setAppState)
    // Both slices must see the task so BackgroundTasksDialog,
    // Ctrl+C, and lifecycle hooks all work.
    expect((state.tasks as Record<string, unknown>)['wf_dual_aaaa']).toBeDefined()
    expect((state.workflows as Record<string, unknown>)['wf_dual_aaaa']).toBeDefined()
    expect((state.workflows as Record<string, unknown>)['wf_dual_aaaa']).toBe(
      (state.tasks as Record<string, unknown>)['wf_dual_aaaa'],
    )
    unregister()
  })

  test('unregister clears BOTH appState.workflows and appState.tasks', () => {
    const task = makeFakeTask({ id: 'wf_dual_bbbb', status: 'running' })
    const { state, setAppState } = makeMockAppState()
    const unregister = registerWorkflowInAppState(task, setAppState)
    // Sanity: both slices populated
    expect((state.tasks as Record<string, unknown>)['wf_dual_bbbb']).toBeDefined()
    expect((state.workflows as Record<string, unknown>)['wf_dual_bbbb']).toBeDefined()
    unregister()
    expect((state.tasks as Record<string, unknown>)['wf_dual_bbbb']).toBeUndefined()
    expect((state.workflows as Record<string, unknown>)['wf_dual_bbbb']).toBeUndefined()
  })

  test('unregister on a never-registered id is a no-op (does not corrupt other slices)', () => {
    const task = makeFakeTask({ id: 'wf_dual_keep' })
    const other = makeFakeTask({ id: 'wf_dual_other' })
    const { state, setAppState } = makeMockAppState()
    registerWorkflowInAppState(other, setAppState)
    // Now unregister a third task that was never registered — should
    // be a no-op without affecting `other`.
    const unregister = registerWorkflowInAppState(task, setAppState)
    // Manually call unregister twice (idempotent / safe to call again)
    unregister()
    unregister()
    // `other` should still be there in both slices
    expect((state.tasks as Record<string, unknown>)['wf_dual_other']).toBeDefined()
    expect((state.workflows as Record<string, unknown>)['wf_dual_other']).toBeDefined()
  })
})
