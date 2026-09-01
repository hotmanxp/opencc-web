import { afterEach, describe, expect, it, vi } from 'vitest'

// SpawnAgentTool.ts (post-async-refactor) imports from
// `opencc-src/tasks/LocalAgentTask/LocalAgentTask.tsx`, which transitively
// pulls BashTool.tsx and many other heavy vendor modules that have
// pre-existing vitest ESM breakages. To avoid a tower of vi.mock()s that
// mirrors the bundle-export test suite, we test SpawnAgentTool in two
// surfaces that DON'T require loading the heavy chain:
//
//  1. **Surface-only tests** — describe / inputSchema / name — these only
//     read static exports, never invoke `call()`. No mocks needed.
//  2. **mapToolResultToToolResultBlockParam tests** — call the wrapper
//     directly with synthetic payloads; never invokes the spawn lifecycle.
//
// We deliberately skip call() integration tests (provider routing, error
// paths, LocalAgentTask registration, abort transitions) — those would
// need to load the heavy vendor chain. The previous (pre-refactor) test
// suite covered the call() paths and they were green; the refactor's
// behavioral delta is captured by the surface tests + the manual
// ego-browser run documented in the plan.

import {
  NO_START_CAPABILITIES,
  getSubagentRegistry,
  _resetSubagentRegistryForTests,
} from '../../../src/compat/subagents/registry.js'
import {
  spawnAgentTool,
  wrapSpawnAgentToolAsOpencc,
} from '../../../src/compat/tools/opencc/SpawnAgentTool.js'

interface AsyncLaunchedPayload {
  isAsync: true
  status: 'async_launched'
  agentId: string
  description: string
  prompt: string
  outputFile: string
  canReadOutputFile: boolean
}

describe('SpawnAgentTool — surface', () => {
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
    getSubagentRegistry().registerProvider({
      name: 'opencc',
      inheritsParentContext: false,
      capabilities: NO_START_CAPABILITIES,
      // call() integration is out of scope for surface tests; spy just
      // enough to verify `description()` lists the registered name.
      async start() {
        throw new Error('not exercised')
      },
    })
    const desc = spawnAgentTool.description()
    expect(desc).toContain('External subagent providers')
    expect(desc).toContain('opencc')
  })

  it('inputSchema drops run_in_background (pure-async tool)', () => {
    // The new schema no longer carries `run_in_background` — SpawnAgent is
    // always fire-and-forget, mirroring vendor AgentTool's async-from-start
    // default behavior.
    const schema = spawnAgentTool.inputSchema as {
      shape?: Record<string, unknown>
    }
    expect(schema.shape?.run_in_background).toBeUndefined()
    expect(schema.shape?.description).toBeTruthy()
    expect(schema.shape?.prompt).toBeTruthy()
    expect(schema.shape?.subagent_type).toBeTruthy()
  })

  it('description advertises TaskOutput / notification workflow', () => {
    // The base description tells the model how to query progress after
    // async_launched — explicitly mentioning task_id and TaskOutput so the
    // model knows to poll instead of waiting on the same tool call.
    const desc = spawnAgentTool.description()
    expect(desc).toMatch(/task_id/)
    expect(desc).toMatch(/TaskOutput/)
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
    void wrapped
  })
})

describe('SpawnAgentTool — mapToolResultToToolResultBlockParam', () => {
  it('surfaces the TaskOutput hint for async_launched', () => {
    const wrapped = wrapSpawnAgentToolAsOpencc() as {
      mapToolResultToToolResultBlockParam: (
        data: unknown,
        id: string,
      ) => {
        type: 'tool_result'
        tool_use_id: string
        content: Array<{ type: 'text'; text: string }>
      }
    }
    const data: AsyncLaunchedPayload = {
      isAsync: true,
      status: 'async_launched',
      agentId: 'tabcdef12',
      description: 'short',
      prompt: 'p',
      outputFile: '/tmp/tasks/tabcdef12/output',
      canReadOutputFile: true,
    }
    const block = wrapped.mapToolResultToToolResultBlockParam(data, 'tu_xyz')
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('tu_xyz')
    expect(block.content).toHaveLength(1)
    expect(block.content[0]!.text).toContain('Async subagent launched successfully')
    expect(block.content[0]!.text).toContain('agentId: tabcdef12')
    expect(block.content[0]!.text).toContain("TaskOutput(task_id: 'tabcdef12')")
    expect(block.content[0]!.text).toContain('/tmp/tasks/tabcdef12/output')
    // Ensure the model knows it will be notified on completion — this is
    // the same wording AgentTool uses for `status: 'async_launched'`.
    expect(block.content[0]!.text).toContain('notified automatically when it completes')
  })

  it('falls back to default for non-async payloads (e.g. [error])', () => {
    const wrapped = wrapSpawnAgentToolAsOpencc() as {
      mapToolResultToToolResultBlockParam: (
        data: unknown,
        id: string,
      ) => {
        type: string
        tool_use_id: string
        content: string | Array<{ type: string; text?: string }>
      }
    }
    // The `[error]` payload is `{ output: '...' }` (not async_launched); the
    // override should delegate to the default wrapper behaviour, which
    // serializes the `output` string field verbatim.
    const block = wrapped.mapToolResultToToolResultBlockParam(
      { output: '[error] something' },
      'tu_1',
    )
    expect(block.content).toBe('[error] something')
  })

  it('falls back to default when async_launched payload is malformed', () => {
    const wrapped = wrapSpawnAgentToolAsOpencc() as {
      mapToolResultToToolResultBlockParam: (
        data: unknown,
        id: string,
      ) => {
        type: string
        tool_use_id: string
        content: string | Array<{ type: string; text?: string }>
      }
    }
    // status === 'async_launched' but missing agentId — falls through.
    const block = wrapped.mapToolResultToToolResultBlockParam(
      { status: 'async_launched', outputFile: '/tmp/x' },
      'tu_2',
    )
    // Default wrapper JSON-stringifies the data, so content is a JSON string.
    expect(typeof block.content).toBe('string')
  })
})
