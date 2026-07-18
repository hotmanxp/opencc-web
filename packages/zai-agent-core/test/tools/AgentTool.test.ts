import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentTool } from '../../src/tools/AgentTool/AgentTool.js'
import { getAgentToolDescription } from '../../src/tools/AgentTool/prompt.js'
import type { ToolContext } from '../../src/tools/Tool.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'

// `vi.mock` is hoisted: it intercepts the module load of
// opencc-internals/utils/forkedAgent.js BEFORE the AgentTool call()
// reaches its dynamic import. The factory runs lazily so we don't pull
// in Bun-only transitive imports (bun:bundle via withRetry.ts) at
// collection time. Per-test override uses
// `(await import('...forkedAgent.js')).runForkedAgent.mockImplementation(...)`.
vi.mock('../../src/opencc-internals/utils/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
  getLastCacheSafeParams: vi.fn(() => null),
  saveCacheSafeParams: vi.fn(),
  extractResultText: vi.fn((_msgs: any, def: string) => def),
}))

// `messages.ts` has a top-level `import { feature } from 'bun:bundle'`
// that vitest-node cannot resolve. AgentTool's sync path only needs
// `createUserMessage`, so we stub the entire module before that import.
vi.mock('../../src/opencc-internals/utils/messages.js', () => ({
  createUserMessage: vi.fn(({ content }: { content: any }) => ({ type: 'user', message: { content } })),
}))

let dataDir: string
let ctx: ToolContext

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zai-agent-test-'))
  await mkdir(join(dataDir, 'agents'), { recursive: true })
  ctx = {
    cwd: dataDir,
    env: {},
    abortSignal: new AbortController().signal,
    dataDir,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    __runtimeConfig: {
      dataDir,
      modelCaller: makeMockModelCaller('text-only'),
      sandbox: makeMockSandbox(dataDir),
    },
    __defaultModel: 'test-model',
    __maxTurns: 25,
    parentSessionId: 'sess-parent',
  }
})

afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

describe('AgentTool', () => {
  test('派生子 agent, 发 subagent:start/event/done 三个事件', async () => {
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)

    const { runForkedAgent } = await import('../../src/opencc-internals/utils/forkedAgent.js')
    ;(runForkedAgent as any).mockImplementation(async () => ({
      messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } as any],
      totalUsage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    }))

    const r = await AgentTool.call(
      { prompt: 'sub task', subagent_type: 'general-purpose' },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toContain('<subagent_result')
    expect(events.some(e => e.type === 'subagent:start')).toBe(true)
    // subagent:done is emitted in both code paths (success and error),
    // independent of the mocked runForkedAgent behavior.
    expect(events.some(e => e.type === 'subagent:done')).toBe(true)
  })

  test('subSessionId 形如 <parent>-sub-<8hex>', async () => {
    let startEvent: any
    ctx.emitEvent = (e) => { if (e.type === 'subagent:start') startEvent = e }
    const { runForkedAgent } = await import('../../src/opencc-internals/utils/forkedAgent.js')
    ;(runForkedAgent as any).mockImplementation(async () => ({
      messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } as any],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    }))
    await AgentTool.call({ prompt: 'x', subagent_type: 'general-purpose' }, ctx)
    expect(startEvent.subSessionId).toMatch(/^sess-parent-sub-[0-9a-f]{8}$/)
  })

  test('agent definition 存在时使用其 systemPrompt (验证 sync path 将 agent.systemPrompt 注入 systemContext)', async () => {
    await writeFile(join(dataDir, 'agents/custom.md'),
      `---\nname: custom\ndescription: custom agent\n---\nCUSTOM_SYSTEM_PROMPT`)

    let capturedSystemContext: Record<string, string> | undefined
    const { runForkedAgent } = await import('../../src/opencc-internals/utils/forkedAgent.js')
    ;(runForkedAgent as any).mockImplementation(async (params: any) => {
      capturedSystemContext = params.cacheSafeParams.systemContext
      return {
        messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } as any],
        totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
      }
    })

    await AgentTool.call({ prompt: 'x', subagent_type: 'custom' }, ctx)
    expect(capturedSystemContext).toBeDefined()
    expect(capturedSystemContext!.__AGENT_PROMPT__).toContain('CUSTOM_SYSTEM_PROMPT')
  })

  test('__runtimeConfig 缺省 → isError', async () => {
    const r = await AgentTool.call(
      { prompt: 'x', subagent_type: 'general-purpose' },
      { ...ctx, __runtimeConfig: undefined },
    )
    expect(r.isError).toBe(true)
  })

  test('isReadOnly = true, isDestructive = false', () => {
    expect(AgentTool.isReadOnly!({ prompt: 'x', subagent_type: 'general-purpose' })).toBe(true)
    expect(AgentTool.isDestructive!({ prompt: 'x', subagent_type: 'general-purpose' })).toBe(false)
  })

  test('schema rejects unknown keys (strict)', () => {
    const r = (AgentTool as any).inputSchema.safeParse({
      prompt: 'x',
      subagent_type: 'general-purpose',
      unknown_field: 'should-be-rejected',
    })
    expect(r.success).toBe(false)
  })

  test('getAgentToolDescription returns opencc-style prompt with AVAILABLE_AGENTS section', () => {
    const text = getAgentToolDescription()
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(80)
    expect(text).toContain('sub-agent')
    // Force the section to be present with the open + close tags and a
    // general-purpose bullet. The loose '/availab.?agents|specialized|
    // general-purpose/' regex previously passed because "general-purpose"
    // already appears in the description body — these explicit assertions
    // guarantee the <available_agents> block is actually appended.
    expect(text).toContain('<available_agents>')
    expect(text).toContain('</available_agents>')
    expect(text).toMatch(/^\s*-\s+general-purpose:/m)
  })

  test('renderAvailableAgentsSection renders bullet list for explicit agents', async () => {
    // Built-in always at least one (general-purpose from BUILT_IN_AGENTS).
    const { renderAvailableAgentsSection } = await import('../../src/tools/AgentTool/prompt.js')
    const r = renderAvailableAgentsSection([
      { name: 'Explore', description: 'Read-only codebase exploration.', systemPrompt: 'x' },
    ])
    expect(r).toContain('<available_agents>')
    expect(r).toContain('</available_agents>')
    expect(r).toMatch(/^\s*-\s+Explore:/m)
  })

  test('renderAvailableAgentsSection defaults to BUILT_IN_AGENTS', async () => {
    const { renderAvailableAgentsSection } = await import('../../src/tools/AgentTool/prompt.js')
    const r = renderAvailableAgentsSection()
    expect(r).toContain('<available_agents>')
    expect(r).toContain('</available_agents>')
    expect(r).toMatch(/^\s*-\s+general-purpose:/m)
    expect(r).toMatch(/^\s*-\s+Explore:/m)
    expect(r).toMatch(/^\s*-\s+Plan:/m)
  })

  test('validateInput rejects empty prompt', async () => {
    const r = await (AgentTool as any).validateInput(
      { prompt: '', subagent_type: 'general-purpose' },
      ctx,
    )
    expect(r.result).toBe(false)
  })

  test('validateInput allows non-empty prompt', async () => {
    const r = await (AgentTool as any).validateInput(
      { prompt: 'do x', subagent_type: 'general-purpose' },
      ctx,
    )
    expect(r.result).toBe(true)
  })

  test('checkPermissions returns allow', async () => {
    const r = await (AgentTool as any).checkPermissions(
      { prompt: 'x', subagent_type: 'general-purpose' },
      ctx,
    )
    expect(r.behavior).toBe('allow')
  })

  test('userFacingName formats Agent(<subagent_type>)', () => {
    expect((AgentTool as any).userFacingName({ subagent_type: 'Explore' })).toBe('Agent(Explore)')
  })

  test('getActivityDescription returns short label', () => {
    const label = (AgentTool as any).getActivityDescription({
      prompt: 'long prompt '.repeat(50),
      subagent_type: 'general-purpose',
    })
    expect(typeof label).toBe('string')
    expect(label.length).toBeLessThanOrEqual(80)
  })

  test('getToolUseSummary returns description or prompt prefix', () => {
    expect((AgentTool as any).getToolUseSummary({
      prompt: 'x', subagent_type: 'general-purpose', description: 'desc',
    })).toBe('desc')
  })

  test('toAutoClassifierInput returns compact shape', () => {
    const ci = (AgentTool as any).toAutoClassifierInput({
      prompt: 'do x', subagent_type: 'general-purpose', description: 'desc',
    })
    expect(ci).toEqual({ name: 'Agent', subagent_type: 'general-purpose', prompt: 'do x', description: 'desc' })
  })

  test('mapToolResultToToolResultBlockParam yields tool_result block', () => {
    const block = (AgentTool as any).mapToolResultToToolResultBlockParam(
      '<subagent_result agent_type="x" exit_reason="completed">\nresult text\n</subagent_result>',
      'tool-use-1',
    )
    expect(block).toEqual({
      tool_use_id: 'tool-use-1',
      type: 'tool_result',
      content: '<subagent_result agent_type="x" exit_reason="completed">\nresult text\n</subagent_result>',
      is_error: false,
    })
  })
})
