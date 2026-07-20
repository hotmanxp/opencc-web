import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DefaultPluginRuntime } from '../../src/plugins/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'zai-plugin-runtime-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('loads a complete plugin snapshot and caches concurrent reads', async () => {
  const plugin = join(root, 'plugins', 'demo')
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
  await mkdir(join(plugin, 'skills', 'review'), { recursive: true })
  await mkdir(join(plugin, 'commands'), { recursive: true })
  await mkdir(join(plugin, 'agents'), { recursive: true })
  await mkdir(join(plugin, 'hooks'), { recursive: true })
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }))
  await writeFile(join(plugin, 'skills', 'review', 'SKILL.md'), '---\ndescription: Review code\n---\nReview body')
  await writeFile(join(plugin, 'commands', 'build.md'), '---\ndescription: Build project\n---\nBuild body')
  await writeFile(join(plugin, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review agent\n---\nReview system')
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify({ echo: { type: 'stdio', command: 'node' } }))
  await writeFile(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'start' }] }] } }))

  const runtime = new DefaultPluginRuntime({ zai: { pluginsDir: join(root, 'plugins') } })
  const [first, second] = await Promise.all([runtime.load({ cwd: root }), runtime.load({ cwd: root })])

  expect(first).toBe(second)
  expect(first.plugins.map(p => p.id)).toEqual(['demo'])
  expect(first.skills.map(s => s.name)).toEqual(expect.arrayContaining(['plugin:demo:review', 'plugin:demo:build']))
  expect(first.agents.map(a => a.name)).toContain('plugin:demo:reviewer')
  expect(first.pluginMcpServerNames).toEqual(['plugin:demo:echo'])
  expect(first.hooks).toHaveLength(1)
  expect(first.errors).toEqual([])
})

test('disabled runtime returns an empty snapshot', async () => {
  const snapshot = await new DefaultPluginRuntime({ enabled: false }).load({ cwd: root })
  expect(snapshot.plugins).toEqual([])
  expect(snapshot.errors).toEqual([])
})
