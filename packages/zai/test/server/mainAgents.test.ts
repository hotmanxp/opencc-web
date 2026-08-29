import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mainAgentsDir, resolveMainAgent } from '../../src/server/services/mainAgents.js'
import {
  getAgentRegistry,
  resetAgentRegistryForTests,
  type MainAgentConfig,
} from '@zn-ai/zn-agent-core'

let cleanupDirs: string[] = []
afterEach(() => {
  cleanupDirs = []
  resetAgentRegistryForTests()
})

beforeEach(() => {
  // 每个 case 拿全新实例,避免 singleton 跨 case 串扰
  resetAgentRegistryForTests()
})

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'main-agents-test-'))
  cleanupDirs.push(dir)
  return dir
}

describe('mainAgentsDir', () => {
  it('returns ~/.zai/main-agents', () => {
    expect(mainAgentsDir()).toMatch(/\.zai\/main-agents$/)
  })
})

describe('AgentRegistry.loadUserAgents (core)', () => {
  it('returns empty when dir is missing', async () => {
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(join(tmpdir(), `main-agents-missing-${Date.now()}`))
    expect(res.loaded).toEqual([])
    expect(res.failed).toEqual([])
  })

  it('loads a single CJS agent file', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'my-assistant.js'),
      `module.exports = {
        name: 'my-assistant',
        description: '我的自定义助手',
        systemPrompt: (origin) => ['你是我的私人助手。', ...origin],
      }`,
      'utf-8',
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['my-assistant'])
    expect(res.failed).toEqual([])
    const agent = r.resolveAgent('my-assistant')
    expect(agent).toBeTruthy()
    expect(agent!.slots.systemPrompt).toBeTypeOf('function')
    expect(agent!.slots.systemPrompt!(['base'])).toEqual([
      '你是我的私人助手。',
      'base',
    ])
  })

  it('supports one file exporting an array of agents', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'multi.js'),
      `module.exports = [
        { name: 'a', description: 'A' },
        { name: 'b', description: 'B' },
      ]`,
      'utf-8',
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded.sort()).toEqual(['a', 'b'])
  })

  it('skips invalid exports and keeps valid ones', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'bad.js'),
      `module.exports = { foo: 'bar' }`,
      'utf-8',
    )
    await writeFile(
      join(dir, 'good.js'),
      `module.exports = { name: 'good', description: 'ok' }`,
      'utf-8',
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['good'])
    expect(res.failed.map((f) => f.file)).toEqual(['bad.js'])
  })

  it('external agent can create its own tool via the (ctx) factory', async () => {
    // 外置 agent 文件以 `(ctx) => config` 工厂导出,从 ctx 拿 buildTool + z,
    // 在 tools 槽里创造自定义工具 —— 验证"js 自己创造工具"链路。
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'greeter.js'),
      `module.exports = (ctx) => {
         const { buildTool, z } = ctx
         if (!buildTool || !z) throw new Error('ctx not injected')
         const GreetTool = buildTool({
           name: 'Greet',
           description: async () => '向用户打招呼',
           prompt: async () => '向用户打一个友好的招呼。',
           inputSchema: z.object({ name: z.string() }),
           outputSchema: z.object({ greeting: z.string() }),
           renderToolUseMessage() { return null },
           async call({ name }) { return { greeting: '你好, ' + name + '!' } },
         })
         return {
           name: 'greeter',
           description: '只会打招呼的示例 agent',
           tools: (origin) => [...origin, GreetTool],
         }
       }`,
      'utf-8',
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['greeter'])
    const greeter = r.resolveAgent('greeter')
    expect(greeter).toBeTruthy()
    expect(greeter!.slots.tools).toBeTypeOf('function')
    const pool = greeter!.slots.tools!([{ name: 'Read' }] as never)
    const greet = pool.find(
      (t) => t.name === 'Greet',
    ) as { call: (input: { name: string }) => Promise<{ greeting: string }> }
    expect(greet).toBeTruthy()
    const out = await greet.call({ name: '世界' })
    expect(out.greeting).toBe('你好, 世界!')
  })

  it('keeps accepting direct-object legacy format', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'legacy.js'),
      `module.exports = { name: 'legacy', description: '直接导出对象' }`,
      'utf-8',
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['legacy'])
  })
})

describe('user agents override builtin on name collision', () => {
  it('loadUserAgents 后同名 builtin 被覆盖', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'override.js'),
      `module.exports = { name: 'office', description: 'custom office override' };`,
      'utf-8',
    )
    await r.loadUserAgents(dir)
    expect(r.resolveAgent('office')!.description).toBe('custom office override')
    // default 不被覆盖,仍为 builtin
    expect(r.resolveAgent('default')!.description).not.toBe('custom office override')
  })
})

describe('resolveMainAgent (zai-side thin wrapper)', () => {
  it('resolves a user agent by name', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'custom.js'),
      `module.exports = { name: 'custom', description: 'user agent' }`,
      'utf-8',
    )
    await r.loadUserAgents(dir)
    const { agent, agents } = await resolveMainAgent('custom')
    expect(agent.name).toBe('custom')
    // 列表包含内置 + 外置
    expect(agents.some((a) => a.name === 'default')).toBe(true)
    expect(agents.some((a) => a.name === 'office')).toBe(true)
    expect(agents.some((a) => a.name === 'custom')).toBe(true)
  })

  it('falls back to default for unknown name', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    const { agent } = await resolveMainAgent('nope')
    expect(agent.name).toBe('default')
  })

  it('falls back to default when name is undefined', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    const { agent } = await resolveMainAgent(undefined)
    expect(agent.name).toBe('default')
  })

  it('auto-loads builtin agents when registry is empty (idempotent fallback)', async () => {
    // zai-side 兜底:不调 loadBuiltinAgents 也能拿到 default,避免设置类
    // 路由(agentSettings)在没经过 initAgentRuntime 时 500。
    const r = getAgentRegistry()
    expect(r.listAgents()).toHaveLength(0)
    const { agent } = await resolveMainAgent(undefined)
    expect(agent.name).toBe('default')
    expect(r.listAgents().length).toBeGreaterThan(0)
  })
})

describe('builtin agents (core)', () => {
  it('getBuiltinMainAgents exposes default + office + agent-creator', () => {
    // 通过 internal import 复用 core 类型断言,不影响 thin wrapper 测试路径
    const builtin = (require('@zn-ai/zn-agent-core') as { getBuiltinMainAgents(): MainAgentConfig[] })
      .getBuiltinMainAgents()
    const names = builtin.map((a) => a.name)
    expect(names).toContain('default')
    expect(names).toContain('office')
    expect(names).toContain('agent-creator')
    const office = builtin.find((a) => a.name === 'office')!
    // office 有 systemPrompt 槽 + tools 槽
    expect(office.systemPrompt).toBeTypeOf('function')
    expect(office.tools).toBeTypeOf('function')
    // office 工具槽精简:白名单外工具被过滤;WebSearch 与 Task v2 工具保留,
    // WebFetch 不开放(值用真实工具名,见 mainAgents.ts 注释)
    const fakeTools = [
      { name: 'Read' },
      { name: 'Agent' },
      { name: 'Workflow' },
      { name: 'WebFetch' },
      { name: 'WebSearch' },
      { name: 'TaskCreate' },
      { name: 'TaskGet' },
      { name: 'TaskUpdate' },
      { name: 'TaskList' },
    ]
    const filtered = office.tools!(fakeTools as never)
    expect(filtered.map((t) => t.name).sort()).toEqual([
      'Read',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'WebSearch',
    ])
  })

  it('office system prompt strips coding-oriented sections, keeps base mechanics', () => {
    const builtin = (require('@zn-ai/zn-agent-core') as { getBuiltinMainAgents(): MainAgentConfig[] })
      .getBuiltinMainAgents()
    const office = builtin.find((a) => a.name === 'office')!
    const origin = [
      'You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user. Only create URLs for programming help.',
      '# System\nTools are executed in a user-selected permission mode. If the user denies a tool you call, adjust your approach.',
      '# Doing tasks\nThe user will primarily request you to perform software engineering tasks.\nAvoid backwards-compatibility hacks. Prefer three similar lines of code over a premature abstraction.',
      '# Environment\nPrimary working directory: /tmp/some-office-dir',
      '# Using your tools\nTo read files use Read instead of cat.',
    ]
    const slotted = office.systemPrompt!(origin)
    const joined = slotted.join('\n')
    // 身份/行为准则前置
    expect(slotted[0]).toContain('Office Assistant')
    // coding 行为规则段被剥离
    expect(joined).not.toContain('software engineering tasks')
    expect(joined).not.toContain('# Doing tasks')
    expect(joined).not.toContain('backwards-compatibility hacks')
    // 基础机制段保留
    expect(joined).toContain('# System')
    expect(joined).toContain('# Environment')
    expect(joined).toContain('# Using your tools')
  })

  it('agent-creator carries the full external-agent spec in its system prompt', () => {
    const builtin = (require('@zn-ai/zn-agent-core') as { getBuiltinMainAgents(): MainAgentConfig[] })
      .getBuiltinMainAgents()
    const creator = builtin.find((a) => a.name === 'agent-creator')!
    expect(creator.systemPrompt).toBeTypeOf('function')
    expect(creator.tools).toBeTypeOf('function')
    const prompt = creator.systemPrompt!(['base'])[0]
    // 创作规范细节内置:目录、插槽语义、工具真实名、生效时机(英文)
    expect(prompt).toContain('~/.zai/main-agents')
    expect(prompt).toContain('origin')
    expect(prompt).toContain("BashTool's name")
    expect(prompt).toContain('new sessions')
    expect(prompt).toContain('restarting zai')
    // 工具槽保留写文件能力,过滤掉创作不需要的工具,并注入专属的
    // ValidateMainAgent 验证工具
    const filtered = creator.tools!([
      { name: 'Write' },
      { name: 'Edit' },
      { name: 'Agent' },
      { name: 'Workflow' },
    ] as never)
    expect(filtered.map((t) => t.name).sort()).toEqual([
      'Edit',
      'ValidateMainAgent',
      'Write',
    ])
  })
})