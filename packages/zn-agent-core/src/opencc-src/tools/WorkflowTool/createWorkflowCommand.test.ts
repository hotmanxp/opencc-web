import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getWorkflowCommands, workflowToCommand } from './createWorkflowCommand.ts'

describe('getWorkflowCommands', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wf-cmds-'))
    // getWorkflowCommands() is gated by isWorkflowsDisabled(); workflows
    // are opt-in since 2026-06-27. Each test opts in explicitly so the
    // gate doesn't shadow what's being tested.
    process.env.OPENCC_ENABLE_WORKFLOWS = '1'
  })

  test('returns no user-workflow slash commands when none are registered', async () => {
    // The /workflows builtin is now a local-jsx command registered through
    // the standard src/commands/ scan path; getWorkflowCommands() is
    // strictly for user-workflow files.
    const cmds = await getWorkflowCommands(tmp)
    expect(cmds.find(c => c.name === 'workflows')).toBeUndefined()
  })

  test('returns a slash command for a freshly-written user workflow', async () => {
    const wfDir = join(tmp, '.claude', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    // The registry loader does `mod.default ?? mod.workflow` and skips
    // anything that isn't a function — so the script body must export
    // a runnable function for the slash command to appear. The body
    // can also call __setMeta/phase (the runtime API) — that part is
    // exercised when the workflow actually runs, not at registration.
    // The runtime globals (__setMeta, phase, agent, parallel) only
    // exist inside the worker wrapper, so the import-time call site
    // must be inside the function body, not at the top level.
    writeFileSync(
      join(wfDir, 'sync-verify.js'),
      `export default async function () { __setMeta({ name: 'sync-verify', description: '...' }); phase('Sync'); return 'report' }\n`,
    )
    const cmds = await getWorkflowCommands(tmp)
    expect(cmds.find(c => c.name === 'sync-verify')).toBeDefined()
  })

  test('excludes bundled workflows from slash commands', async () => {
    const cmds = await getWorkflowCommands(tmp)
    // deep-research is bundled, should NOT appear as a slash command
    // (it has its own registration path via registerBundled)
    expect(cmds.find(c => c.name === 'deep-research')).toBeUndefined()
  })
})

describe('workflowToCommand (Plan14 upstream parity)', () => {
  test('forwards kind, progressMessage, whenToUse, hasUserSpecifiedDescription', () => {
    const cmd = workflowToCommand({
      name: 'sample',
      description: 'sample desc',
      whenToUse: 'use it for X',
      hasUserSpecifiedDescription: true,
      source: 'bundled',
      loadedFrom: 'bundled',
      script: 'export const meta = { name: "sample", description: "d" }',
      path: '<bundled:sample>',
      run: async () => '',
    })
    expect((cmd as any).kind).toBe('workflow')
    expect((cmd as any).progressMessage).toBe('running dynamic workflow')
    // whenToUse + hasUserSpecifiedDescription forwarded verbatim
    expect((cmd as any).whenToUse).toBe('use it for X')
    expect((cmd as any).hasUserSpecifiedDescription).toBe(true)
  })

  test('contentLength uses script length', () => {
    const cmd = workflowToCommand({
      name: 'sample',
      description: 'sample desc',
      source: 'bundled',
      path: '<bundled:sample>',
      script: 'a'.repeat(123),
      run: async () => '',
    })
    expect((cmd as any).contentLength).toBe(123)
  })

  test('contentLength defaults to 0 when script is undefined', () => {
    const cmd = workflowToCommand({
      name: 'sample',
      description: 'sample desc',
      source: 'user',
      path: '/tmp/sample.js',
      run: async () => '',
    })
    expect((cmd as any).contentLength).toBe(0)
  })

  test('loadedFrom maps bundled/plugin/bundled; others become "skills"', () => {
    const bundled = workflowToCommand({ name: 'b', source: 'bundled', path: 'p', run: async () => '' })
    const plugin = workflowToCommand({ name: 'p', source: 'plugin', path: 'p', run: async () => '' })
    const project = workflowToCommand({ name: 'pr', source: 'project', path: 'p', run: async () => '' })
    const user = workflowToCommand({ name: 'u', source: 'user', path: 'p', run: async () => '' })
    expect((bundled as any).loadedFrom).toBe('bundled')
    expect((plugin as any).loadedFrom).toBe('plugin')
    expect((project as any).loadedFrom).toBe('skills')
    expect((user as any).loadedFrom).toBe('skills')
  })

  test('forwards pluginInfo (translated from top-level fields) when source is plugin', () => {
    const cmd = workflowToCommand({
      name: 'plug',
      description: 'plug desc',
      source: 'plugin',
      loadedFrom: 'plugin',
      pluginManifest: { name: 'plug' },
      plugin: 'https://example.com',
      path: '/tmp/plug.js',
      run: async () => '',
    })
    expect((cmd as any).pluginInfo).toEqual({
      pluginManifest: { name: 'plug' },
      repository: 'https://example.com',
    })
  })

  test('does not include pluginInfo when source is not plugin', () => {
    const cmd = workflowToCommand({
      name: 'local',
      description: 'local desc',
      source: 'user',
      path: '/tmp/local.js',
      run: async () => '',
    })
    expect((cmd as any).pluginInfo).toBeUndefined()
  })

  test('does not include whenToUse when undefined', () => {
    const cmd = workflowToCommand({
      name: 'sample',
      description: 'sample desc',
      source: 'user',
      path: '/tmp/sample.js',
      run: async () => '',
    })
    expect((cmd as any).whenToUse).toBeUndefined()
  })
})

describe('workflowToCommand getPromptForCommand (CLI args string + raw pass-through)', () => {
  function makeWorkflow(overrides: Partial<Parameters<typeof workflowToCommand>[0]> = {}) {
    return workflowToCommand({
      name: 'echo',
      description: 'echoes the args object',
      source: 'project',
      path: '/tmp/.claude/workflows/echo.js',
      run: async () => '',
      ...overrides,
    })
  }

  async function renderPrompt(args: string): Promise<string> {
    const cmd = makeWorkflow()
    const blocks = await (cmd as any).getPromptForCommand(args)
    return blocks[0].text as string
  }

  test('preserves raw CLI string (no splitting into array)', async () => {
    const prompt = await renderPrompt('--name=ethan --word=hello')
    // The args field in the Invoke payload is a string, not an array
    expect(prompt).toContain('args: "--name=ethan --word=hello"')
    expect(prompt).not.toContain('args: ["--name=ethan"')
    expect(prompt).not.toContain('args: [\"--name=ethan\"')
  })

  test('mentions the workflow script path so the LLM can read it', async () => {
    const prompt = await renderPrompt('--x=y')
    expect(prompt).toContain('Workflow script: `/tmp/.claude/workflows/echo.js`')
    expect(prompt).toContain('(project-scoped)')
  })

  test('tells the LLM to read the script first', async () => {
    const prompt = await renderPrompt('--x=y')
    expect(prompt).toMatch(/Read the workflow script first/i)
    expect(prompt).toMatch(/parses it at runtime into an object/i)
  })

  test('renders (no args) when input is empty', async () => {
    const prompt = await renderPrompt('')
    expect(prompt).toContain('(no args)')
    // callShape omits args when empty
    expect(prompt).toMatch(/Invoke: Workflow\(\{ workflowName: "echo", description:/)
    expect(prompt).not.toMatch(/args:/)
  })

  test('renders (no args) when input is whitespace only', async () => {
    const prompt = await renderPrompt('   ')
    expect(prompt).toContain('(no args)')
  })

  test('uses Invoke: Workflow({...}) shape (matches upstream 2.1.185)', async () => {
    const prompt = await renderPrompt('--name=ethan')
    expect(prompt).toMatch(/Invoke: Workflow\(\{ workflowName: "echo", args: "--name=ethan"/)
  })

  test('still surfaces the Run ID instruction (verbatim paste)', async () => {
    const prompt = await renderPrompt('--x=y')
    expect(prompt).toContain('Run ID')
    expect(prompt).toContain('paste the Run ID')
    expect(prompt).toContain('verbatim')
  })
})
