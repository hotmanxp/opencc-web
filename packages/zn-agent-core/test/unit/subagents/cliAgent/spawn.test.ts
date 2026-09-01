import { afterEach, describe, it, expect } from 'vitest'
import {
  SubagentError,
  NO_START_CAPABILITIES,
  getSubagentRegistry,
  _resetSubagentRegistryForTests,
  type SubagentEvent,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRun,
  type SubagentContext,
} from '../../../../src/compat/subagents/registry.js'
import {
  spawnCliAgent,
  type CliAgentKind,
} from '../../../../src/compat/subagents/cliAgent/spawn.js'
import type { SubprocessHandle } from '../../../../src/compat/subprocess/types.js'

/** Stub provider that records the request and returns a scripted run. */
function makeStubProvider(name: string, runIdPrefix = name): SubagentProvider & {
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
        id: `${runIdPrefix}-internal-run`,
        events: (async function* (): AsyncGenerator<SubagentEvent> {})(),
        result: Promise.resolve<SubagentResult>({ text: 'ok', stopReason: 'completed' }),
        async cancel() {},
      }
    },
  }
  return proxy
}

describe('subagents/cliAgent/spawn', () => {
  afterEach(() => {
    _resetSubagentRegistryForTests()
  })

  it('spawns through the registry provider and shadows run.id with task_id', async () => {
    const provider = makeStubProvider('dsh')
    getSubagentRegistry().registerProvider(provider)
    const spawn = await spawnCliAgent({
      agentType: 'dsh',
      prompt: 'do a thing',
      description: 'dsh task',
      cwd: '/tmp/work',
      model: 'deepseek-v4-flash',
    })
    expect(spawn.status).toBe('spawned')
    expect(spawn.agent_type).toBe('dsh')
    // Provider got the request with description/prompt/cwd/model forwarded.
    expect(provider.lastRequest?.description).toBe('dsh task')
    expect(provider.lastRequest?.prompt).toBe('do a thing')
    expect(provider.lastRequest?.cwd).toBe('/tmp/work')
    expect(provider.lastRequest?.model).toBe('deepseek-v4-flash')
    // task_id is the vendor-shaped key and run.id shadows it.
    expect(spawn.task_id).toMatch(/^t[0-9a-z]{8}$/)
    expect(spawn.run.id).toBe(spawn.task_id)
  })

  it('name defaults to agentType when omitted', async () => {
    getSubagentRegistry().registerProvider(makeStubProvider('opencc'))
    const spawn = await spawnCliAgent({ agentType: 'opencc', prompt: 'hi' })
    expect(spawn.name).toBe('opencc')
    expect(spawn.agent_id).toMatch(/^opencc-[0-9a-z]{8}$/)
  })

  it('teamName yields a vendor-shaped agent_id name@team', async () => {
    getSubagentRegistry().registerProvider(makeStubProvider('dsh'))
    const spawn = await spawnCliAgent({
      agentType: 'dsh',
      name: 'researcher',
      teamName: 'my-project',
      prompt: 'hi',
    })
    expect(spawn.name).toBe('researcher')
    expect(spawn.team_name).toBe('my-project')
    expect(spawn.agent_id).toBe('researcher@my-project')
  })

  it('sanitizes @ out of names before formatting the agent id', async () => {
    getSubagentRegistry().registerProvider(makeStubProvider('dsh'))
    const spawn = await spawnCliAgent({
      agentType: 'dsh',
      name: 'a@b',
      teamName: 't',
      prompt: 'hi',
    })
    expect(spawn.name).toBe('a-b')
    expect(spawn.agent_id).toBe('a-b@t')
  })

  it('carries tmux in-process placeholders like the vendor spawn output', async () => {
    getSubagentRegistry().registerProvider(makeStubProvider('dsh'))
    const spawn = await spawnCliAgent({ agentType: 'dsh', prompt: 'hi' })
    expect(spawn.tmux_session_name).toBe('in-process')
    expect(spawn.tmux_window_name).toBe('in-process')
    expect(spawn.tmux_pane_id).toBe('in-process')
    expect(spawn.is_splitpane).toBe(false)
  })

  it('throws PROVIDER_NOT_FOUND for an unregistered agent type', async () => {
    await expect(
      spawnCliAgent({ agentType: 'nope' as CliAgentKind, prompt: 'hi' }),
    ).rejects.toBeInstanceOf(SubagentError)
    await expect(
      spawnCliAgent({ agentType: 'nope' as CliAgentKind, prompt: 'hi' }),
    ).rejects.toThrow(/no provider named 'nope'/)
  })

  it('returns the provider run handle as spawn.run (for publish/cancel)', async () => {
    getSubagentRegistry().registerProvider(makeStubProvider('opencc'))
    const spawn = await spawnCliAgent({ agentType: 'opencc', prompt: 'hi' })
    const result = await spawn.run.result
    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('ok')
  })
})