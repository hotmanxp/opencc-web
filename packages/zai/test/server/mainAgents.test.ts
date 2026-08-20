import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadUserMainAgents,
  mainAgentsDir,
  mergeMainAgents,
  resolveMainAgent,
} from '../../src/server/services/mainAgents.js'
import { getBuiltinMainAgents, type MainAgentConfig } from '@zn-ai/zn-agent-core'

let cleanupDirs: string[] = []
afterEach(() => {
  cleanupDirs = []
  vi.restoreAllMocks()
})

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'main-agents-test-'))
  cleanupDirs.push(dir)
  return dir
}

describe('loadUserMainAgents', () => {
  it('returns [] when dir is missing', async () => {
    const dir = join(tmpdir(), `main-agents-missing-${Date.now()}`)
    expect(await loadUserMainAgents(dir)).toEqual([])
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
    const agents = await loadUserMainAgents(dir)
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('my-assistant')
    expect(agents[0].systemPrompt).toBeTypeOf('function')
    // 插槽函数真实可调用
    expect(agents[0].systemPrompt!(['base'])).toEqual([
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
    const agents = await loadUserMainAgents(dir)
    expect(agents.map((a) => a.name).sort()).toEqual(['a', 'b'])
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
    const agents = await loadUserMainAgents(dir)
    expect(agents.map((a) => a.name)).toEqual(['good'])
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
    const agents = await loadUserMainAgents(dir)
    expect(agents).toHaveLength(1)
    const greeter = agents[0]
    expect(greeter.tools).toBeTypeOf('function')
    // 应用 tools 槽:池尾部出现自定义 Greet 工具,且真实可调用
    const pool = greeter.tools!([{ name: 'Read' }] as never)
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
    const agents = await loadUserMainAgents(dir)
    expect(agents.map((a) => a.name)).toEqual(['legacy'])
  })
})

describe('mergeMainAgents', () => {
  it('user agents override builtin on name collision', () => {
    const builtin: MainAgentConfig[] = [
      { name: 'default', description: 'builtin default' },
      { name: 'office', description: 'builtin office' },
    ]
    const user: MainAgentConfig[] = [
      { name: 'office', description: 'custom office override' },
      { name: 'custom', description: 'user agent' },
    ]
    const merged = mergeMainAgents(builtin, user)
    expect(merged.find((a) => a.name === 'office')?.description).toBe(
      'custom office override',
    )
    expect(merged.find((a) => a.name === 'custom')).toBeTruthy()
    // default 保留内置
    expect(merged.find((a) => a.name === 'default')?.description).toBe(
      'builtin default',
    )
  })
})

describe('resolveMainAgent', () => {
  it('resolves a user agent by name', async () => {
    const dir = await makeTmpDir()
    await writeFile(
      join(dir, 'custom.js'),
      `module.exports = { name: 'custom', description: 'user agent' }`,
      'utf-8',
    )
    const { agent, agents } = await resolveMainAgent('custom', dir)
    expect(agent.name).toBe('custom')
    // 列表包含内置 + 外置
    expect(agents.some((a) => a.name === 'default')).toBe(true)
    expect(agents.some((a) => a.name === 'office')).toBe(true)
    expect(agents.some((a) => a.name === 'custom')).toBe(true)
  })

  it('falls back to default for unknown name', async () => {
    const dir = await makeTmpDir()
    const { agent } = await resolveMainAgent('nope', dir)
    expect(agent.name).toBe('default')
  })

  it('falls back to default when name is undefined', async () => {
    const { agent } = await resolveMainAgent(undefined)
    expect(agent.name).toBe('default')
  })
})

describe('builtin agents (core)', () => {
  it('getBuiltinMainAgents exposes default + office + agent-creator', () => {
    const builtin = getBuiltinMainAgents()
    const names = builtin.map((a) => a.name)
    expect(names).toContain('default')
    expect(names).toContain('office')
    expect(names).toContain('agent-creator')
    const office = builtin.find((a) => a.name === 'office')!
    // office 有 systemPrompt 槽 + tools 槽
    expect(office.systemPrompt).toBeTypeOf('function')
    expect(office.tools).toBeTypeOf('function')
    // office 工具槽精简:白名单外工具被过滤(值用真实工具名,见 mainAgents.ts 注释)
    const fakeTools = [
      { name: 'Read' },
      { name: 'Agent' },
      { name: 'Workflow' },
    ]
    const filtered = office.tools!(fakeTools as never)
    expect(filtered.map((t) => t.name)).toEqual(['Read'])
  })

  it('agent-creator carries the full external-agent spec in its system prompt', () => {
    const creator = getBuiltinMainAgents().find(
      (a) => a.name === 'agent-creator',
    )!
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
