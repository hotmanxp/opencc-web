import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistryImpl } from '../../src/opencc-src/server/agentRegistry.js'

describe('AgentRegistry load', () => {
  let registry: AgentRegistryImpl
  beforeEach(() => {
    registry = new AgentRegistryImpl()
  })

  it('loadBuiltinAgents 注册 3 个 builtin', () => {
    registry.loadBuiltinAgents()
    const agents = registry.listAgents().map(a => a.name).sort()
    expect(agents).toEqual(['agent-creator', 'default', 'office'])
  })

  it('loadBuiltinAgents 后 hasAgent 对三个 name 返回 true', () => {
    registry.loadBuiltinAgents()
    expect(registry.hasAgent('default')).toBe(true)
    expect(registry.hasAgent('office')).toBe(true)
    expect(registry.hasAgent('agent-creator')).toBe(true)
    expect(registry.hasAgent('nonexistent')).toBe(false)
  })

  it('loadUserAgents 空目录 → loaded=[], failed=[]', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual([])
    expect(r.failed).toEqual([])
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 目录不存在 → 空结果', async () => {
    const r = await registry.loadUserAgents('/nonexistent/path/xyz')
    expect(r.loaded).toEqual([])
    expect(r.failed).toEqual([])
  })

  it('loadUserAgents 单个 .js 文件注册成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'my-agent.js'),
      `module.exports = { name: 'my', description: 'd' };`,
    )
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual(['my'])
    expect(r.failed).toEqual([])
    expect(registry.hasAgent('my')).toBe(true)
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 工厂函数 ctx 注入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'factory-agent.js'),
      `module.exports = (ctx) => ({
        name: 'factory',
        description: 'd',
        tools: (origin) => origin,
      });`,
    )
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual(['factory'])
    expect(registry.listAgents().find(a => a.name === 'factory')?.slots.tools).toBeDefined()
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 损坏文件 skip + 计入 failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(join(dir, 'broken.js'), `module.exports = throw new Error('boom');`)
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].file).toContain('broken.js')
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 缺 name/description → failed, 不注册', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'no-name.js'),
      `module.exports = { description: 'd' };`,
    )
    const r = await registry.loadUserAgents(dir)
    expect(r.failed).toHaveLength(1)
    expect(registry.hasAgent('no-name')).toBe(false)
    await rm(dir, { recursive: true })
  })

  it('外置同名覆盖 builtin', async () => {
    registry.loadBuiltinAgents()
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'override.js'),
      `module.exports = { name: 'default', description: 'user override' };`,
    )
    await registry.loadUserAgents(dir)
    const a = registry.listAgents().find(a => a.name === 'default')
    expect(a?.description).toBe('user override')
    await rm(dir, { recursive: true })
  })
})
