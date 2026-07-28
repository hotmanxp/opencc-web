import { describe, expect, it } from 'bun:test'
import vm from 'node:vm'
import { createWorkflowVmContext, type WorkflowApi } from './vmContext.js'

// Cast helper: test stubs have looser return types than WorkflowApi's strict
// Promise<unknown> signature. The runtime contract is what we test; the cast
// keeps the stubs readable.
const asApi = (api: Record<string, unknown>): WorkflowApi => api as unknown as WorkflowApi

describe('createWorkflowVmContext', () => {
  it('creates a context with codeGeneration disabled (eval blocked)', () => {
    const ctx = createWorkflowVmContext(asApi({
      agent: () => {},
      parallel: async () => {},
      pipeline: async () => {},
      workflow: () => {},
      args: undefined,
      budget: { total: 0, spent: () => 0, remaining: () => 0 },
      log: () => {},
      phase: () => {},
      setTimeout, clearTimeout,
    }))
    expect(() => {
      vm.runInContext('eval("1+1")', ctx)
    }).toThrow(/code generation/i)
  })

  it('exposes agent/parallel/pipeline/workflow as bound functions', () => {
    let agentCalled = false
    let parallelCalled = false
    const ctx = createWorkflowVmContext(asApi({
      agent: () => { agentCalled = true; return Promise.resolve('ok') },
      parallel: () => { parallelCalled = true; return Promise.resolve([]) },
      pipeline: async () => [],
      workflow: () => Promise.resolve(undefined),
      args: 'hello',
      budget: { total: 0, spent: () => 0, remaining: () => 0 },
      log: () => {},
      phase: () => {},
      setTimeout, clearTimeout,
    }))
    vm.runInContext('agent("p"); parallel([])', ctx)
    expect(agentCalled).toBe(true)
    expect(parallelCalled).toBe(true)
  })

  it('exposes args verbatim to script (no JSON wrapping)', () => {
    let receivedArgs: unknown
    const ctx = createWorkflowVmContext(asApi({
      agent: (prompt: string, opts: { args?: unknown }) => { receivedArgs = opts.args; return Promise.resolve('ok') },
      parallel: async () => [],
      pipeline: async () => [],
      workflow: () => Promise.resolve(undefined),
      args: { foo: 'bar' },
      budget: { total: 0, spent: () => 0, remaining: () => 0 },
      log: () => {}, phase: () => {},
      setTimeout, clearTimeout,
    }))
    vm.runInContext('agent("p", { args })', ctx)
    expect(receivedArgs).toEqual({ foo: 'bar' })
  })
})