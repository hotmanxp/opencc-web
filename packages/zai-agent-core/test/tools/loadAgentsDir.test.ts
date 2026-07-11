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
  test('无 agents 目录 → 空数组', async () => {
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents).toEqual([])
  })

  test('单文件形式 <name>.md 加载', async () => {
    await mkdir(join(dataDir, 'agents'))
    await writeFile(join(dataDir, 'agents/general-purpose.md'),
      `---\nname: general-purpose\ndescription: do general tasks\n---\nYou are a general agent.`)
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents).toHaveLength(1)
    expect(r.agents[0]?.name).toBe('general-purpose')
  })

  test('目录形式 <name>/AGENT.md 加载', async () => {
    await mkdir(join(dataDir, 'agents/explorer'), { recursive: true })
    await writeFile(join(dataDir, 'agents/explorer/AGENT.md'),
      `---\nname: explorer\ndescription: explore codebase\n---\nYou explore.`)
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents.some(a => a.name === 'explorer')).toBe(true)
  })
})
