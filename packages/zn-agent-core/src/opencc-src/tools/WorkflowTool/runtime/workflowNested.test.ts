import { describe, expect, it } from 'bun:test'
import { createNestedWorkflowRunner } from './workflowNested.ts'

describe('createNestedWorkflowRunner', () => {
  it('runs a named workflow with args', async () => {
    const fakeResolve = async (name: string) => ({
      name, script: `async function userScript() { return 'child-' + '${name}'; }`
    })
    const fakeRunScript = async (script: string) => `result-of:${script.length}`
    const runner = createNestedWorkflowRunner({
      resolveWorkflow: fakeResolve as never,
      runScript: fakeRunScript as never,
      nestingDepth: 0,
    })
    const result = await runner('my-child', 'hello')
    expect(result).toMatch(/^result-of:/)
  })

  it('throws when nestingDepth >= 1 (one-level limit)', async () => {
    const runner = createNestedWorkflowRunner({
      resolveWorkflow: async () => null,
      runScript: async () => '',
      nestingDepth: 1,
    })
    await expect(runner('any', undefined)).rejects.toThrow(/nesting is limited to one level/)
  })

  it('passes args through to the child userScript', async () => {
    const fakeResolve = async () => ({ name: 'x', script: 'async function userScript() { return "done"; }' })
    let receivedArgs: unknown
    const fakeRunScript = async (_script: string, args: unknown) => {
      receivedArgs = args
      return 'ok'
    }
    const runner = createNestedWorkflowRunner({
      resolveWorkflow: fakeResolve as never,
      runScript: fakeRunScript as never,
      nestingDepth: 0,
    })
    await runner('x', { foo: 'bar' })
    expect(receivedArgs).toEqual({ foo: 'bar' })
  })
})
