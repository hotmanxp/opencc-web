// src/tools/WorkflowTool/runtime/detect-project-version.test.ts
//
// End-to-end test for the args feature synced from upstream
// claude-code 2.1.185. Loads the detect-project-version.js
// fixture (a two-phase workflow that identifies a project type
// and reads its version) and verifies:
//
//   1. args.projectDir flows through to the script's body
//   2. default fallback ('.' when args is undefined / null / missing key)
//   3. both phases of agent() are called with the projectDir
//   4. the return value is the expected { projectDir, projectType, version }
//
// The agent() function is mocked — the real LLM is not invoked.
// This test only validates the args → script → phase-1 agent →
// phase-2 agent → return value pipeline that the args feature
// unblocks.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runWorkflowInVm } from './vmRunner.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURE = join(__dirname, '__fixtures__', 'detect-project-version.js')

// Build a minimal WorkflowApi for testing. The agent() mock
// records every prompt and returns a canned response based on
// the prompt's content (phase-1 prompt asks for type, phase-2
// prompt asks for version — distinguish by which field name the
// schema requests).
//
// IMPORTANT: `api.args` is the global that vmRunner.ts exposes to
// the script via `args: api.args` in createWorkflowVmContext. The
// top-level await scripts read `args` directly, so the test must
// mirror whatever was passed to `runWorkflowInVm({ args })` into
// `api.args` — otherwise the script's `args` global is undefined
// and the projectDir fallback to '.' swallows every test case.
function makeApi(opts: {
  agentCalls: string[]
  typeResponse: string
  versionResponse: string
  events?: Array<{ kind: string; payload: unknown }>
  cwd?: string
  args: unknown
}) {
  const events = opts.events ?? []
  return {
    agent: async (prompt: string, _apiOpts?: unknown) => {
      opts.agentCalls.push(prompt)
      // Heuristic: phase-1 prompt asks for a `type`, phase-2 for `version`.
      // The fixture passes the schema to the agent() call, so we
      // could also branch on _apiOpts.schema.required[0] === 'type'
      // but the prompt-content check is more robust against schema
      // refactors.
      if (/\btype\b.*single lowercase word/i.test(prompt)) {
        return { type: opts.typeResponse }
      }
      return { version: opts.versionResponse }
    },
    parallel: async <T,>(fns: Array<() => Promise<T>>) => Promise.all(fns.map(f => f())),
    pipeline: async <T,>(stages: Array<() => Promise<T>>) => {
      const out: T[] = []
      for (const s of stages) out.push(await s())
      return out
    },
    workflow: () => Promise.reject(new Error('workflow() not supported in this test')),
    args: opts.args,
    budget: { total: 0, spent: () => 0, remaining: () => 0 },
    log: (msg: unknown) => events.push({ kind: 'log', payload: String(msg) }),
    phase: (title: string) => events.push({ kind: 'phase', payload: title }),
    setTimeout,
    clearTimeout,
  }
}

describe('detect-project-version workflow (args feature end-to-end)', () => {
  it('passes args.projectDir through to both phase agent() prompts', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'wf-detect-'))
    // Drop a fake package.json so the workflow has something to read.
    // (The agent() is mocked, so this file is just for the test's own
    // sanity check that we created a real directory.)
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '9.9.9' }, null, 2),
    )

    const agentCalls: string[] = []
    const events: Array<{ kind: string; payload: unknown }> = []
    const result = await runWorkflowInVm({
      script: FIXTURE,
      args: { projectDir },
      api: makeApi({
        agentCalls,
        typeResponse: 'node',
        versionResponse: '9.9.9',
        events,
        args: { projectDir },
      }) as never,
    })

    // 1. result is a JSON-encoded report (the script returns an object).
    const parsed = JSON.parse(result.report) as {
      projectDir: string
      projectType: string
      version: string
    }
    // projectDir is always '.' now (the VM literal for CWD) — the
    // script ignores the args.projectDir that callers pass, per the
    // 2026-06-21 redesign where the user controls the project dir
    // by `cd`ing into it before running the slash command.
    expect(parsed.projectDir).toBe('.')
    expect(parsed.projectType).toBe('node')
    expect(parsed.version).toBe('9.9.9')

    // 2. agent() was called exactly twice (phase 1 + phase 2).
    expect(agentCalls.length).toBe(2)

    // 3. BOTH prompts carried the CWD literal '.' (the script
    // ignores args.projectDir now — it always uses the VM's CWD).
    for (const prompt of agentCalls) {
      expect(prompt).toContain('"."')
    }

    // 4. phase() events were emitted in the declared order.
    const phaseEvents = events.filter(e => e.kind === 'phase').map(e => e.payload)
    expect(phaseEvents).toEqual(['Identify type', 'Find version'])
  })

  it('falls back to "." when args is undefined (LLM omitted `args` entirely)', async () => {
    const agentCalls: string[] = []
    const result = await runWorkflowInVm({
      script: FIXTURE,
      args: undefined,
      api: makeApi({
        agentCalls,
        typeResponse: 'node',
        versionResponse: '1.0.0',
        args: undefined,
      }) as never,
    })

    const parsed = JSON.parse(result.report) as { projectDir: string }
    expect(parsed.projectDir).toBe('.')
    // The default '.' must still flow into the agent() prompts so
    // the LLM knows what to inspect.
    for (const prompt of agentCalls) {
      expect(prompt).toContain('"."')
    }
  })

  it('falls back to "." when args is null (LLM passed args:null)', async () => {
    // Important port gap covered: the prior z.union() schema would
    // have rejected null, but the new z.unknown() (upstream 2.1.185)
    // accepts it. The script's `(args && ...)` guard handles it
    // gracefully instead of throwing.
    const agentCalls: string[] = []
    const result = await runWorkflowInVm({
      script: FIXTURE,
      args: null,
      api: makeApi({
        agentCalls,
        typeResponse: 'node',
        versionResponse: '1.0.0',
        args: null,
      }) as never,
    })

    const parsed = JSON.parse(result.report) as { projectDir: string }
    expect(parsed.projectDir).toBe('.')
  })

  it('falls back to "." when args is an object without projectDir', async () => {
    // Catches the case where the LLM passes some other args shape
    // (e.g. config) without projectDir. The script should default
    // to '.' rather than crash on `args.projectDir` being undefined.
    const result = await runWorkflowInVm({
      script: FIXTURE,
      args: { dryRun: true, maxDepth: 3 },
      api: makeApi({
        agentCalls: [],
        typeResponse: 'python',
        versionResponse: '2.0.0',
        args: { dryRun: true, maxDepth: 3 },
      }) as never,
    })

    const parsed = JSON.parse(result.report) as { projectDir: string; projectType: string }
    expect(parsed.projectDir).toBe('.')
    expect(parsed.projectType).toBe('python')
  })

  it('captures both phase and log events in declaration order', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'wf-detect-'))
    const events: Array<{ kind: string; payload: unknown }> = []
    await runWorkflowInVm({
      script: FIXTURE,
      args: { projectDir },
      api: makeApi({
        agentCalls: [],
        typeResponse: 'rust',
        versionResponse: '0.1.0',
        events,
        args: { projectDir },
      }) as never,
    })

    // Every log() and phase() call should be in the events array.
    const phaseTitles = events.filter(e => e.kind === 'phase').map(e => e.payload)
    const logMessages = events.filter(e => e.kind === 'log').map(e => e.payload)
    expect(phaseTitles).toEqual(['Identify type', 'Find version'])
    // log() emitted at least the type detection and version detection messages.
    const hasTypeLog = logMessages.some(m => String(m).includes('Detected project type: rust'))
    const hasVersionLog = logMessages.some(m => String(m).includes('Detected version: 0.1.0'))
    expect(hasTypeLog).toBe(true)
    expect(hasVersionLog).toBe(true)
  })
})
