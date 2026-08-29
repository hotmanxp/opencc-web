import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mainAgentsDir, resolveMainAgent } from '../../src/server/services/mainAgents.js'
import {
  getAgentRegistry,
  resetAgentRegistryForTests,
  type AgentConfig,
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

  it('returned agent is AgentConfig shape (slots.*), not legacy MainAgentConfig top-level fields', async () => {
    // fix round 1 for Task 5:阻止 `export type { AgentConfig as MainAgentConfig }`
    // 误用回归。运行时字段断言 + 编译期类型断言:
    //   - agent.slots 存在(systemPrompt / tools / mcp 都在 slots 下)
    //   - 顶层没有 legacy systemPrompt / tools / mcp 字段
    //   - 类型层:resolveMainAgent 返回的 agent 可赋给 AgentConfig
    //     且不可赋给 vendor 的 MainAgentConfig(`slots` 在 MainAgentConfig
    //     不存在,旧代码读 `agent.systemPrompt` 会拿到 undefined)。
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    const { agent } = await resolveMainAgent(undefined)
    expect(agent.slots).toBeDefined()
    expect(typeof (agent as unknown as Record<string, unknown>).systemPrompt).toBe(
      'undefined',
    )
    expect(typeof (agent as unknown as Record<string, unknown>).tools).toBe(
      'undefined',
    )
    expect(typeof (agent as unknown as Record<string, unknown>).mcp).toBe(
      'undefined',
    )
    // 编译期断言 —— `AgentConfig` 可赋,`MainAgentConfig` 因 slots 字段
    // 不能赋,会触发 TS2322。
    const _agentConfigOk: AgentConfig = agent
    // @ts-expect-error MainAgentConfig 没有 slots 字段,不能赋 agentConfig
    const _mainAgentConfigNotOk: MainAgentConfig = agent
    void _agentConfigOk
    void _mainAgentConfigNotOk
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
// =====================================================================
// zai patch (2026-08-29, plan §6.1 Task 11): 回归断言——builtin agents 经
// 新 AgentRegistry.slot() 派发与原 MainAgentConfig 直接调用输出等价。
// 覆盖 office / agent-creator / default 三个 builtin,以及外置 .js 加载的
// 三种格式(CJS object / CJS factory / ESM default) + 数组形式。
// =====================================================================

describe('AgentRegistry.slot() 派发(plan §6.1)', () => {
  it('default.tools 经 slot 派发 append DisplayFiles 工具', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s-default', 'default')
    const tools = await r.slot<unknown[]>([], 'tools', 's-default')
    expect(tools.map((t) => (t as { name: string }).name)).toContain(
      'DisplayFiles',
    )
  })

  it('office.systemPrompt 经 slot 派发返回非空数组且首项含 "Office Assistant"', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s-office', 'office')
    const out = await r.slot<string[]>([], 'systemPrompt', 's-office')
    expect(Array.isArray(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toContain('Office Assistant')
  })

  it('agent-creator.tools 经 slot 派发注入 ValidateMainAgent', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s-ac', 'agent-creator')
    const tools = await r.slot<unknown[]>([], 'tools', 's-ac')
    expect(tools.map((t) => (t as { name: string }).name)).toContain(
      'ValidateMainAgent',
    )
  })

  it('builtin 不实现某 slot 时,slot 派发 pass-through 返回 origin', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s-passthrough', 'default')
    // default.tools 已实现,所以用 systemPrompt 测试 pass-through 行为:
    // default 没 systemPrompt 槽(主 agents.ts:78-91 只见 tools)→ origin 不变
    const origin = ['pass-through-test-line-1', 'pass-through-test-line-2']
    const out = await r.slot<string[]>(origin, 'systemPrompt', 's-passthrough')
    expect(out).toEqual(origin)
  })
})

describe('loadUserAgents 三种格式兼容(plan §6.1)', () => {
  it('CJS object export: module.exports = { name, description }', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'a.js'),
      `module.exports = { name: 'a', description: 'd' };`,
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['a'])
  })

  it('CJS factory export: module.exports = (ctx) => ({ name, description })', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'b.js'),
      `module.exports = (ctx) => ({ name: 'b', description: 'd' });`,
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['b'])
  })

  it('ESM default export: export default (ctx) => ({...})', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'c.js'),
      `export default () => ({ name: 'c', description: 'd' });`,
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['c'])
  })

  it('数组形式(单文件多 agent)', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'multi.js'),
      `module.exports = [{ name: 'x1', description: 'd' }, { name: 'x2', description: 'd' }];`,
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded.sort()).toEqual(['x1', 'x2'])
  })

  it('损坏的 .js 文件不阻断其他文件加载', async () => {
    const dir = await makeTmpDir()
    await writeFile(join(dir, 'good.js'), `module.exports = { name: 'good', description: 'd' };`)
    await writeFile(join(dir, 'bad.js'), `module.exports = ((`);  // 语法错误
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['good'])
    expect(res.failed.length).toBe(1)
    expect(res.failed[0].file).toBe('bad.js')
  })
})
