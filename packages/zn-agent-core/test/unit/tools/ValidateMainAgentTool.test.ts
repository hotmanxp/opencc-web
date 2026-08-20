import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  validateMainAgentConfig,
  validateMainAgentFile,
} from '../../../src/opencc-src/server/mainAgents.js'

let dirs: string[] = []
afterEach(() => {
  dirs = []
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'validate-main-agent-'))
  dirs.push(dir)
  return dir
}

describe('validateMainAgentConfig', () => {
  it('accepts a valid config', () => {
    const { valid, issues } = validateMainAgentConfig({
      name: 'email-assistant',
      description: '邮件助手',
      systemPrompt: () => ['x'],
      tools: () => [],
    })
    expect(valid).toBe(true)
    expect(issues).toEqual([])
  })

  it('rejects missing name/description', () => {
    const { valid, issues } = validateMainAgentConfig({ foo: 'bar' })
    expect(valid).toBe(false)
    expect(issues.join(';')).toContain('name')
    expect(issues.join(';')).toContain('description')
  })

  it('rejects non-function slots', () => {
    const { valid, issues } = validateMainAgentConfig({
      name: 'x',
      description: 'x',
      systemPrompt: 'not a function',
      mcp: 42,
    })
    expect(valid).toBe(false)
    expect(issues.join(';')).toContain('systemPrompt')
    expect(issues.join(';')).toContain('mcp')
  })

  it('allows omitting all slots (default behaviour)', () => {
    const { valid } = validateMainAgentConfig({
      name: 'passthrough',
      description: 'no slots',
    })
    expect(valid).toBe(true)
  })
})

describe('validateMainAgentFile', () => {
  it('reports missing file', async () => {
    const out = await validateMainAgentFile('/nonexistent/agent.js')
    expect(out.ok).toBe(false)
    expect(out.summary).toContain('不存在')
  })

  it('validates a valid CJS single-agent file', async () => {
    const dir = await makeDir()
    const file = join(dir, 'email-assistant.js')
    await writeFile(
      file,
      `module.exports = {
        name: 'email-assistant',
        description: '中文邮件助手',
        systemPrompt: (origin) => ['你是邮件助手。', ...origin],
        tools: (origin) => origin.filter((t) => t.name === 'Read'),
      }`,
      'utf-8',
    )
    const out = await validateMainAgentFile(file)
    expect(out.ok).toBe(true)
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]).toMatchObject({
      name: 'email-assistant',
      valid: true,
    })
  })

  it('validates an array file with multiple agents', async () => {
    const dir = await makeDir()
    const file = join(dir, 'multi.js')
    await writeFile(
      file,
      `module.exports = [
        { name: 'a', description: 'A' },
        { name: 'b', description: 'B' },
      ]`,
      'utf-8',
    )
    const out = await validateMainAgentFile(file)
    expect(out.ok).toBe(true)
    expect(out.agents.map((a) => a.name)).toEqual(['a', 'b'])
  })

  it('flags invalid entries but keeps per-agent detail', async () => {
    const dir = await makeDir()
    const file = join(dir, 'bad.js')
    await writeFile(file, `module.exports = [{ name: 'x' }]`, 'utf-8')
    const out = await validateMainAgentFile(file)
    expect(out.ok).toBe(false)
    expect(out.agents[0].valid).toBe(false)
    expect(out.agents[0].issues.join(';')).toContain('description')
  })

  it('warns on builtin-name collision and in-file duplicate', async () => {
    const dir = await makeDir()
    const file = join(dir, 'collide.js')
    await writeFile(
      file,
      `module.exports = [
        { name: 'office', description: 'override builtin' },
        { name: 'office', description: 'dup' },
      ]`,
      'utf-8',
    )
    const out = await validateMainAgentFile(file)
    expect(out.ok).toBe(true)
    const warnings = out.agents.flatMap((a) => a.warnings).join(';')
    expect(warnings).toContain('内置 agent 重名')
    expect(warnings).toContain('重复定义')
  })

  it('validates a file whose tools slot creates a custom tool via ctx', async () => {
    // 校验器把 buildTool / z 作为 ctx 传给工厂函数,否则含自定义工具的
    // 文件(在 tools 槽里 buildTool 创造工具)会被误判为加载失败。
    const dir = await makeDir()
    const file = join(dir, 'greeter.js')
    await writeFile(
      file,
      `module.exports = ({ buildTool, z }) => {
         const GreetTool = buildTool({
           name: 'Greet',
           description: async () => 'Greets',
           prompt: async () => 'Greet the user.',
           inputSchema: z.object({ name: z.string() }),
           outputSchema: z.object({ greeting: z.string() }),
           renderToolUseMessage() { return null },
           async call({ name }) { return { greeting: 'Hi ' + name } },
         })
         return {
           name: 'greeter',
           description: 'greeter agent',
           tools: (origin) => [...origin, GreetTool],
         }
       }`,
      'utf-8',
    )
    const out = await validateMainAgentFile(file)
    expect(out.ok).toBe(true)
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]).toMatchObject({ name: 'greeter', valid: true })
  })
})
