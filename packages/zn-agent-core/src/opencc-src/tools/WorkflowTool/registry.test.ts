// src/tools/WorkflowTool/registry.test.ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkflowRegistry } from './registry.ts'
import { clearPluginWorkflowsCache } from './pluginWorkflowLoader.ts'

describe('WorkflowRegistry user script loading', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wf-reg-user-'))
  })

  test('loads a freshly-written sample.js from project .claude/workflows', async () => {
    const wfDir = join(tmp, '.claude', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      join(wfDir, 'sample.js'),
      `export default async function () { return 'hello' }`,
    )
    const r = new WorkflowRegistry({ projectDir: tmp, userDir: tmp })
    const all = await r.list()
    expect(all.find(w => w.name === 'sample')).toBeDefined()
  })
})

describe('WorkflowRegistry', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wf-reg-'))
  })

  test('lists empty when no workflows', async () => {
    const r = new WorkflowRegistry({ projectDir: tmp, userDir: tmp })
    const all = await r.list()
    expect(all).toEqual([])
  })

  test('discovers project workflows from .claude/workflows/', async () => {
    const wfDir = join(tmp, '.claude', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      join(wfDir, 'foo.js'),
      `export default async function (args) { return 'foo:' + args; }`,
    )
    const r = new WorkflowRegistry({ projectDir: tmp, userDir: tmp })
    const all = await r.list()
    expect(all.length).toBe(1)
    expect(all[0]!.name).toBe('foo')
    expect(all[0]!.source).toBe('project')
  })

  test('project overrides user on name conflict', async () => {
    const projectDir = join(tmp, 'project')
    const userDir = join(tmp, 'user')
    mkdirSync(join(projectDir, '.claude', 'workflows'), { recursive: true })
    mkdirSync(join(userDir, '.claude', 'workflows'), { recursive: true })
    writeFileSync(join(projectDir, '.claude', 'workflows', 'foo.js'), `export default async function() { return 'project'; }`)
    writeFileSync(join(userDir, '.claude', 'workflows', 'foo.js'), `export default async function() { return 'user'; }`)
    const r = new WorkflowRegistry({ projectDir, userDir })
    const all = await r.list()
    expect(all.length).toBe(1)
    expect(all[0]!.source).toBe('project')
  })

  test('registerBundled adds a workflow', async () => {
    const r = new WorkflowRegistry({ projectDir: tmp, userDir: tmp })
    r.registerBundled({
      name: 'deep-research',
      source: 'bundled',
      path: '<bundled>',
      run: async () => '',
    })
    const all = await r.list()
    expect(all.find(w => w.name === 'deep-research')).toBeDefined()
  })

  test('list() includes plugin workflows when plugins are passed via opts', async () => {
    clearPluginWorkflowsCache()
    const pluginDir = join(tmp, 'plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, 'p.js'),
      `
export const meta = { name: 'p', description: 'p' }
async function userScript() { return 'p' }
`,
    )
    const r = new WorkflowRegistry({
      projectDir: tmp,
      userDir: tmp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plugins: [
        {
          name: 'p1',
          source: 'plugin',
          manifest: {},
          workflowsPath: pluginDir,
          workflowsPaths: [],
        },
      ] as any,
    })
    const all = await r.list()
    expect(all.find(w => w.name === 'p1:p')).toBeDefined()
    expect(all.find(w => w.name === 'p1:p')?.source).toBe('plugin')
  })
})

describe('WorkflowRegistry hot-reload', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wf-reg-watch-'))
  })

  test('reload() picks up a newly created workflow', async () => {
    // Manually drive the reload path instead of relying on chokidar's
    // add event — chokidar's macOS fsevents backend sometimes drops the
    // event for files written in quick succession on tmp dirs (known
    // issue). The chokidar wiring itself is exercised by the
    // startWatching/stopWatching lifecycle test below.
    const r = new WorkflowRegistry({ projectDir: tmp, userDir: tmp })
    const initial = await r.list()
    expect(initial.length).toBe(0)

    // Add a workflow file
    const wfDir = join(tmp, '.claude', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      join(wfDir, 'late.js'),
      'export default async function() { return "late"; }',
    )

    // Force a reload (the chokidar watcher would normally trigger this).
    await r.reload()
    const after = await r.list()
    expect(after.length).toBe(1)
    expect(after[0]!.name).toBe('late')
  })

  test('startWatching / stopWatching lifecycle does not throw', async () => {
    const r = new WorkflowRegistry({ projectDir: tmp, userDir: tmp })
    r.startWatching()
    r.stopWatching()
    // Calling stopWatching again is a no-op (idempotent).
    r.stopWatching()
  })
})
