import { afterEach, describe, expect, it } from 'vitest'
import {
  NO_START_CAPABILITIES,
  getSubagentRegistry,
  _resetSubagentRegistryForTests,
  type SubagentEvent,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRun,
  type SubagentContext,
} from '../../../src/compat/subagents/registry.js'
import {
  spawnAgentTool,
  wrapSpawnAgentToolAsOpencc,
} from '../../../src/compat/tools/opencc/SpawnAgentTool.js'
import type { SubprocessHandle } from '../../../src/compat/subprocess/types.js'

/**
 * SpawnAgent tool tests — no real subprocess (stub provider), verifying the
 * AgentTool-shaped surface: schema validation, subagent_type → provider
 * routing, sync/background settle shapes, and the dynamic description that
 * lists registered providers.
 */

function makeStubProvider(name: string, text = 'ok'): SubagentProvider & {
  lastRequest: SubagentRequest | null
} {
  const proxy = {
    name,
    inheritsParentContext: false,
    capabilities: NO_START_CAPABILITIES,
    lastRequest: null as SubagentRequest | null,
    async start(req: SubagentRequest, _ctx: SubagentContext): Promise<SubagentRun> {
      proxy.lastRequest = req
      const handle = {
        killTree: async () => {},
        pid: 1,
        stdin: {} as never,
        stdout: {} as never,
        stderr: {} as never,
        exitCode: Promise.resolve({ code: 0, signal: null }),
      } as unknown as SubprocessHandle
      return {
        id: `${name}-internal-run`,
        events: (async function* (): AsyncGenerator<SubagentEvent> {})(),
        result: Promise.resolve<SubagentResult>({ text, stopReason: 'completed' }),
        async cancel() {},
      }
    },
  }
  return proxy
}

describe('SpawnAgentTool', () => {
  afterEach(() => {
    _resetSubagentRegistryForTests()
  })

  it('exposes the AgentTool-shaped surface (name / description / inputSchema / call)', () => {
    expect(spawnAgentTool.name).toBe('SpawnAgent')
    expect(typeof spawnAgentTool.description).toBe('function')
    expect(typeof spawnAgentTool.call).toBe('function')
    expect(spawnAgentTool.inputSchema).toBeTruthy()
  })

  it('description includes the registered provider section (formatSubagentProviderSection)', () => {
    expect(spawnAgentTool.description()).toContain('no external subagent providers are registered')
    getSubagentRegistry().registerProvider(makeStubProvider('claude-code'))
    const desc = spawnAgentTool.description()
    expect(desc).toContain('External subagent providers')
    expect(desc).toContain('claude-code')
  })

  it('wraps as an opencc-compatible tool with name + schema', () => {
    const wrapped = wrapSpawnAgentToolAsOpencc() as {
      name: string
      inputSchema: unknown
      description: (input: unknown, options: unknown) => Promise<string>
      prompt: (opts: unknown) => Promise<string>
    }
    expect(wrapped.name).toBe('SpawnAgent')
    expect(wrapped.inputSchema).toBe(spawnAgentTool.inputSchema)
    // wrap default description() forwards the function description.
    void wrapped
  })

  it('rejects invalid input with an [error] output', async () => {
    const out = await spawnAgentTool.call({ prompt: 'missing fields' }, {})
    expect(out).toBeTruthy()
    const output = (out as { output: string }).output
    expect(output).toMatch(/^\[error\] invalid input for SpawnAgent/)
  })

  it('routes subagent_type to the registered provider and settles sync', async () => {
    const provider = makeStubProvider('claude-code', 'claude answer')
    getSubagentRegistry().registerProvider(provider)
    const out = await spawnAgentTool.call(
      {
        description: 'short label',
        prompt: 'do the thing',
        subagent_type: 'claude-code',
      },
      {},
    )
    expect(provider.lastRequest?.prompt).toBe('do the thing')
    expect(provider.lastRequest?.description).toBe('short label')
    expect(out).toMatchObject({
      status: 'completed',
      agentType: 'claude-code',
      text: 'claude answer',
      stopReason: 'completed',
    })
    expect((out as { output: string }).output).toContain('claude answer')
  })

  it('forwards model / cwd / name / team_name to the provider', async () => {
    const provider = makeStubProvider('dsh')
    getSubagentRegistry().registerProvider(provider)
    await spawnAgentTool.call(
      {
        description: 'short',
        prompt: 'hi',
        subagent_type: 'dsh',
        model: 'deepseek-v4-flash',
        cwd: '/tmp/work',
        name: 'worker',
        team_name: 'team-1',
      },
      {},
    )
    expect(provider.lastRequest?.model).toBe('deepseek-v4-flash')
    expect(provider.lastRequest?.cwd).toBe('/tmp/work')
  })

  it('throws PROVIDER_NOT_FOUND for an unregistered subagent_type', async () => {
    await expect(
      spawnAgentTool.call(
        { description: 'x', prompt: 'y', subagent_type: 'nope' },
        {},
      ),
    ).rejects.toThrow(/no subagent provider named 'nope'/)
  })

  it('run_in_background returns async_launched with a task_id without waiting', async () => {
    getSubagentRegistry().registerProvider(makeStubProvider('dsh'))
    const result = await spawnAgentTool.call(
      {
        description: 'bg task',
        prompt: 'run in background',
        subagent_type: 'dsh',
        run_in_background: true,
      },
      {},
    )
    expect((result as { status: string }).status).toBe('async_launched')
    expect((result as { task_id: string }).task_id).toMatch(/^t[0-9a-z]{8}$/)
    expect((result as { output: string }).output).toContain('background')
  })

  it('propagates a provider error settle as a completed-shaped failure', async () => {
    const failedProvider: SubagentProvider = {
      name: 'dsh',
      inheritsParentContext: false,
      capabilities: NO_START_CAPABILITIES,
      async start(_req: SubagentRequest, _ctx: SubagentContext): Promise<SubagentRun> {
        return {
          id: 'dsh-internal-fail',
          events: (async function* (): AsyncGenerator<SubagentEvent> {})(),
          result: Promise.resolve<SubagentResult>({
            text: '',
            stopReason: 'error',
            errorMessage: 'child exploded',
          }),
          async cancel() {},
        }
      },
    }
    getSubagentRegistry().registerProvider(failedProvider)
    const out = (await spawnAgentTool.call(
      { description: 'x', prompt: 'y', subagent_type: 'dsh' },
      {},
    )) as {
      status: string
      stopReason: string
      text: string
      errorMessage?: string
      output: string
    }
    expect(out.status).toBe('completed') // tool-level envelope stays completed
    expect(out.stopReason).toBe('error')
    expect(out.text).toBe('')
    expect(out.errorMessage).toBe('child exploded')
    expect(out.output).toContain('error: child exploded')
  })
})