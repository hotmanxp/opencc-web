import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadAgentDefinitions, parseAgentMd } from '../../src/tools/AgentTool/loadAgentsDir.js'

let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'zai-agents-')) })
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

describe('parseAgentMd', () => {
  test('正常 frontmatter + body', () => {
    const content = `---
name: statusline-setup
description: Generates a statusline
model: claude-sonnet-4-6
maxTurns: 15
---
You are a statusline generator.`
    const r = parseAgentMd('fallback-name', content)
    expect(r).toEqual({
      name: 'statusline-setup',
      description: 'Generates a statusline',
      systemPrompt: 'You are a statusline generator.',
      model: 'claude-sonnet-4-6',
      maxTurns: 15,
    })
  })

  test('无 frontmatter → null', () => {
    expect(parseAgentMd('x', 'no frontmatter here')).toBeNull()
  })

  test('缺 name 字段 → 用文件名 fallback', () => {
    const r = parseAgentMd('fallback-name', `---\ndescription: x\n---\nbody`)
    expect(r?.name).toBe('fallback-name')
  })
})

describe('loadAgentDefinitions', () => {
  test('无 agents 目录 → 内置 BUILT_IN_AGENTS 仍加载 (3 个)', async () => {
    // 产品行为: built-in 永远在场, 即使项目目录和 user-global 都没有 agent. 测试必须
    // 显式传 userAgentsDir='' 关闭 user-global 读取, 否则会去读 ~/.zai/agents 撞真实环境.
    const r = await loadAgentDefinitions(dataDir, '')
    const names = r.agents.map(a => a.name).sort()
    expect(names).toEqual(['Explore', 'Plan', 'general-purpose'])
  })

  test('单文件形式 <name>.md 加载', async () => {
    await mkdir(join(dataDir, 'agents'))
    await writeFile(join(dataDir, 'agents/general-purpose.md'),
      `---\nname: general-purpose\ndescription: do general tasks\n---\nYou are a general agent.`)
    // 同样关掉 user-global, 保证断言只看 dataDir + built-in 的合并.
    const r = await loadAgentDefinitions(dataDir, '')
    const gp = r.agents.find(a => a.name === 'general-purpose')
    expect(gp).toBeTruthy()
    // 项目目录里 general-purpose 应当覆盖 built-in 那条 (按名字去重 last-wins)
    expect(r.agents).toHaveLength(3) // general-purpose + Explore + Plan
  })

  test('目录形式 <name>/AGENT.md 加载', async () => {
    await mkdir(join(dataDir, 'agents/explorer'), { recursive: true })
    await writeFile(join(dataDir, 'agents/explorer/AGENT.md'),
      `---\nname: explorer\ndescription: explore codebase\n---\nYou explore.`)
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents.some(a => a.name === 'explorer')).toBe(true)
  })
})
