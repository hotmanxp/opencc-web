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
// tools/AgentTool/forkedAgent.js BEFORE the AgentTool call() reaches
// its dynamic import. The factory runs lazily so we don't pull in
// DefaultAgentRuntime's transitive imports at collection time. Per-test
// override uses
// `(await import('...forkedAgent.js')).runForkedAgent.mockImplementation(...)`.
//
// After commit b59ed7a rerouted AgentTool.sync through the local
// forkedAgent, the vendored opencc-internals/utils/forkedAgent.js no longer
// exists, so the previous mock target was a dead path. runForkedAgent stayed
// un-mocked, leaving systemContext / cacheSafeParams captures empty (the two
// failing assertions on tests at lines ~107 and ~270).
//
// We must export `createUserMessage` here too because AgentTool does a
// single dynamic import that destructures both — leaving it undefined would
// crash `createUserMessage({ content: input.prompt })` on
// `undefined is not a function`.
vi.mock('../../src/tools/AgentTool/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
  getLastCacheSafeParams: vi.fn(() => null),
  saveCacheSafeParams: vi.fn(),
  extractResultText: vi.fn((_msgs: any, def: string) => def),
  createUserMessage: vi.fn(({ content }: { content: any }) => ({
    type: 'user',
    message: { content },
  })),
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

    const { runForkedAgent } = await import('../../src/tools/AgentTool/forkedAgent.js')
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
    const { runForkedAgent } = await import('../../src/tools/AgentTool/forkedAgent.js')
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
    const { runForkedAgent } = await import('../../src/tools/AgentTool/forkedAgent.js')
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

  test('sync path enforces disallowedTools: [Agent] anti-recursion (R6)', async () => {
    // BackgroundRuntime async path enforces disallowedTools:['Agent'] via
    // defaultBackgroundRuntime.ts:273 (agentRuntime.run is called with
    // disallowedTools:['Agent']). Sync path through runForkedAgent has no
    // top-level parameter — it must flow through cacheSafeParams. We capture
    // the params runForkedAgent receives and assert both:
    //   (a) options.disallowedTools includes 'Agent' — the spec contract
    //       that zai's tools filtering layer reads.
    //   (b) options.tools has name==='Agent' stripped — the runtime reality:
    //       opencc query.ts reads toolUseContext.options.tools directly
    //       (1040 / 1199) without going through resolveToolPool, so the
    //       disallowedTools declaration alone would NOT block recursion in
    //       the current sync path. Filtering the tool entry is the only
    //       way to actually stop a sub-agent from re-dispatching AgentTool.
    let captured: any = null
    const { runForkedAgent, getLastCacheSafeParams } = await import(
      '../../src/tools/AgentTool/forkedAgent.js'
    )
    ;(runForkedAgent as any).mockImplementation(async (params: any) => {
      captured = params
      return {
        messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } as any],
        totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
      }
    })

    // Seed parent's toolUseContext.options.tools with a fake Agent entry so
    // we can prove the filter actually strips it.
    const fakeAgent = { name: 'Agent', description: 'self', inputSchema: {} }
    const fakeOther = { name: 'Bash', description: 'x', inputSchema: {} }
    ;(getLastCacheSafeParams as any).mockReturnValueOnce({
      systemPrompt: '',
      userContext: {},
      systemContext: {},
      toolUseContext: {
        abortController: new AbortController(),
        options: { tools: [fakeAgent, fakeOther] } as any,
        getAppState: () => ({}),
        setAppState: () => {},
        updateFileHistoryState: () => {},
        updateAttributionState: () => {},
        setInProgressToolUseIDs: () => {},
        setResponseLength: () => {},
        messages: [],
      } as any,
      forkContextMessages: [],
    })

    await AgentTool.call({ prompt: 'x', subagent_type: 'general-purpose' }, ctx)

    expect(captured).toBeTruthy()
    const opts = captured.cacheSafeParams.toolUseContext.options as any
    // (a) Spec contract: disallowedTools includes 'Agent'
    expect(Array.isArray(opts.disallowedTools)).toBe(true)
    expect(opts.disallowedTools).toContain('Agent')
    // (b) Runtime reality: tool list passed to query() has the Agent entry stripped
    const tools: any[] = opts.tools ?? []
    expect(tools.find((t: any) => t.name === 'Agent')).toBeUndefined()
    // And the unrelated tool survives
    expect(tools.find((t: any) => t.name === 'Bash')).toBeDefined()
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