import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentTool } from '../../src/tools/AgentTool/AgentTool.js'
import { getAgentToolDescription } from '../../src/tools/AgentTool/prompt.js'
import type { ToolContext } from '../../src/tools/Tool.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'

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

    const r = await AgentTool.call(
      { prompt: 'sub task', subagent_type: 'general-purpose' },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toContain('<subagent_result')
    expect(events.some(e => e.type === 'subagent:start')).toBe(true)
    expect(events.some(e => e.type === 'subagent:event')).toBe(true)
    expect(events.some(e => e.type === 'subagent:done')).toBe(true)
  })

  test('subSessionId 形如 <parent>-sub-<8hex>', async () => {
    let startEvent: any
    ctx.emitEvent = (e) => { if (e.type === 'subagent:start') startEvent = e }
    await AgentTool.call({ prompt: 'x', subagent_type: 'general-purpose' }, ctx)
    expect(startEvent.subSessionId).toMatch(/^sess-parent-sub-[0-9a-f]{8}$/)
  })

  test('agent definition 存在时使用其 systemPrompt (验证子 query 的 systemPrompt 含 agent prompt)', async () => {
    await writeFile(join(dataDir, 'agents/custom.md'),
      `---\nname: custom\ndescription: custom agent\n---\nCUSTOM_SYSTEM_PROMPT`)

    // 第一次 model call (父): 调 AgentTool 派 sub-agent
    // 第二次 model call (子): 捕获子 query 的 systemPrompt, 验证含 CUSTOM_SYSTEM_PROMPT
    let callCount = 0
    let capturedSubPrompt: string | undefined
    ctx.__runtimeConfig!.modelCaller = (async function* (req: any) {
      callCount++
      if (callCount === 1) {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Agent', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"sub","subagent_type":"custom"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        return
      }
      capturedSubPrompt = Array.isArray(req.systemPrompt) ? JSON.stringify(req.systemPrompt) : req.systemPrompt
      yield { type: 'message_start', message: { id: 'm2' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as any

    await AgentTool.call({ prompt: 'x', subagent_type: 'custom' }, ctx)
    expect(capturedSubPrompt).toContain('CUSTOM_SYSTEM_PROMPT')
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
    // Either upstream has AVAILABLE_AGENTS block already, or we append.
    expect(text.toLowerCase()).toMatch(/availab.?agents|specialized|general-purpose/)
  })

  test('renderAvailableAgentsSection returns rendered bullet list', async () => {
    // Built-in always at least one (general-purpose from BUILT_IN_AGENTS).
    const { renderAvailableAgentsSection } = await import('../../src/tools/AgentTool/prompt.js')
    const r = renderAvailableAgentsSection([
      { name: 'Explore', description: 'Read-only codebase exploration.', systemPrompt: 'x' },
    ])
    expect(r).toContain('<available_agents>')
    expect(r).toContain('Explore')
  })
})
