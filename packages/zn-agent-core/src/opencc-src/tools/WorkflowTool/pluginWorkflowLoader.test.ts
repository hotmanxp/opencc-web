// src/tools/WorkflowTool/pluginWorkflowLoader.test.ts
import { describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  loadPluginWorkflows,
  clearPluginWorkflowsCache,
} from './pluginWorkflowLoader.ts'

describe('loadPluginWorkflows (port of upstream)', () => {
  it('loads workflows from a plugin with workflowsPath set', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-wf-'))
    const plugin = {
      name: 'test-plugin',
      source: 'plugin',
      manifest: {},
      workflowsPath: dir,
      workflowsPaths: [],
    }
    // Write a workflow file
    await fs.writeFile(
      path.join(dir, 'echo.js'),
      `
export const meta = { name: 'echo', description: 'echoes args' }
async function userScript(args) { return 'echo:' + args }
`,
    )
    const result = await loadPluginWorkflows([plugin as any])
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('test-plugin:echo')
    await fs.rm(dir, { recursive: true })
  })

  it('loads from workflowsPaths (custom file paths)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-wf-'))
    const file = path.join(dir, 'inline.js')
    await fs.writeFile(
      file,
      `
export const meta = { name: 'inline', description: 'inline' }
async function userScript() { return 'x' }
`,
    )
    const plugin = {
      name: 't2',
      source: 'plugin',
      manifest: {},
      workflowsPath: '',
      workflowsPaths: [file],
    }
    const result = await loadPluginWorkflows([plugin as any])
    expect(result).toHaveLength(1)
    await fs.rm(dir, { recursive: true })
  })

  it('skips invalid meta files with warning', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-wf-bad-'))
    await fs.writeFile(
      path.join(dir, 'bad.js'),
      `not valid meta = {}`,
    )
    const plugin = {
      name: 't3',
      source: 'plugin',
      manifest: {},
      workflowsPath: dir,
      workflowsPaths: [],
    }
    const result = await loadPluginWorkflows([plugin as any])
    expect(result).toHaveLength(0)
    await fs.rm(dir, { recursive: true })
  })

  it('uses cache on second call', async () => {
    clearPluginWorkflowsCache()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-wf-cache-'))
    await fs.writeFile(
      path.join(dir, 'c.js'),
      `
export const meta = { name: 'c', description: 'c' }
async function userScript() { return 'c' }
`,
    )
    const plugin = {
      name: 't4',
      source: 'plugin',
      manifest: {},
      workflowsPath: dir,
      workflowsPaths: [],
    }
    // Use the same plugins array reference across both calls so the
    // cache-key check (`cache.plugins === plugins`) hits.
    const plugins = [plugin as any]
    const r1 = await loadPluginWorkflows(plugins)
    const r2 = await loadPluginWorkflows(plugins)
    expect(r1).toBe(r2) // same array reference = cache hit
    await fs.rm(dir, { recursive: true })
  })
})
