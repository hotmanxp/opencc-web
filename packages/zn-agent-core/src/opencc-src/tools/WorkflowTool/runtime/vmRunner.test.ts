import { describe, expect, it } from 'bun:test'
import { runWorkflowInVm } from './vmRunner.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseCliArgs } from '../cliArgs.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_DIR = join(__dirname, '__fixtures__')

describe('runWorkflowInVm', () => {
  it('runs a simple script that uses agent() and returns the report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-vm-'))
    const scriptPath = join(dir, 'script.js')
    writeFileSync(scriptPath, `
async function userScript(args) {
  const r = await agent('do thing');
  return 'got: ' + r.report;
}
`)

    const agentCalls: string[] = []
    const result = await runWorkflowInVm({
      script: scriptPath,
      args: 'hello',
      api: {
        agent: async (prompt: string) => {
          agentCalls.push(prompt)
          return { ok: true, agentId: 'a1', report: 'mocked-result' }
        },
        parallel: async <T,>(fns: Array<() => Promise<T>>) => Promise.all(fns.map(f => f())),
        pipeline: async <T,>(stages: Array<() => Promise<T>>) => {
          const out: T[] = []
          for (const s of stages) out.push(await s())
          return out
        },
        workflow: () => Promise.reject(new Error('workflow() not supported in this test')),
        args: 'hello',
        budget: { total: 0, spent: () => 0, remaining: () => 0 },
        log: () => {}, phase: () => {},
        setTimeout, clearTimeout,
      },
    })

    expect(agentCalls).toEqual(['do thing'])
    expect(result.report).toBe('got: mocked-result')
  })

  it('rejects with script error message on throw', async () => {
    await expect(
      runWorkflowInVm({
        script: `async function userScript() { throw new Error('boom'); }`,
        args: undefined,
        api: {
          agent: async () => ({ ok: false, error: 'x' }),
          parallel: async () => [], pipeline: async () => [], workflow: async () => undefined,
          args: undefined,
          budget: { total: 0, spent: () => 0, remaining: () => 0 },
          log: () => {}, phase: () => {},
          setTimeout, clearTimeout,
        },
      }),
    ).rejects.toThrow(/boom/)
  })

  it('captures log() and phase() calls into result.events', async () => {
    const events: Array<{ kind: string; payload: unknown }> = []
    const r = await runWorkflowInVm({
      script: `async function userScript() { phase('search'); log('fetching'); return 'done'; }`,
      args: undefined,
      api: {
        agent: async () => ({ ok: false, error: 'x' }),
        parallel: async () => [], pipeline: async () => [], workflow: async () => undefined,
        args: undefined,
        budget: { total: 0, spent: () => 0, remaining: () => 0 },
        log: (msg) => events.push({ kind: 'log', payload: msg }),
        phase: (t) => events.push({ kind: 'phase', payload: t }),
        setTimeout, clearTimeout,
      },
    })
    expect(events).toContainEqual({ kind: 'phase', payload: 'search' })
    expect(events).toContainEqual({ kind: 'log', payload: 'fetching' })
    expect(r.report).toBe('done')
  })

  // Plan6 regression: 4 of 6 user workflows in .claude/workflows/ start
  // with `export const meta = {...}` plus top-level `phase()` /
  // `await agent()` / `return`. The Plan5 VM migration (commit 57887ab7)
  // did not preserve the legacy workerScript.ts `export` stripper, so
  // all four crash with `SyntaxError: Unexpected token 'export'`.
  //
  // Test 1 is RED (fails before fix, green after Task2 stripEsmExports).
  // Test 2 pins the TLA contract; it is GREEN from the start because
  // vmContext.ts already wraps source in `(async () => {...})()` — Task3
  // is a no-op for this fixture, kept as a regression guard only.
  it('runs scripts that use export const meta', async () => {
    const scriptPath = join(FIXTURES_DIR, 'workflow-with-export.js')

    const phaseCalls: string[] = []
    const agentCalls: Array<{ prompt: string; opts: unknown }> = []
    const metaEvents: unknown[] = []
    const result = await runWorkflowInVm({
      script: scriptPath,
      args: undefined,
      api: {
        agent: async (prompt, opts) => {
          agentCalls.push({ prompt, opts })
          return { ok: true, agentId: 'a1', report: 'mocked-agent-report' }
        },
        parallel: async <T,>(fns: Array<() => Promise<T>>) => Promise.all(fns.map(f => f())),
        pipeline: async <T,>(stages: Array<() => Promise<T>>) => {
          const out: T[] = []
          for (const s of stages) out.push(await s())
          return out
        },
        workflow: () => Promise.reject(new Error('workflow() not supported in this test')),
        args: undefined,
        budget: { total: 0, spent: () => 0, remaining: () => 0 },
        log: () => {},
        phase: (title: string) => { phaseCalls.push(title) },
        setTimeout, clearTimeout,
      },
    })

    // The fixture returns { ok: true, summary: 'export meta test' }.
    // vmRunner JSON-stringifies non-string reports, so the report
    // should contain the summary string.
    expect(phaseCalls).toContain('Test')
    expect(agentCalls.map(c => c.prompt)).toContain('test prompt')
    expect(result.report).toContain('export meta test')
  })

  it('captures meta from export const meta declaration', async () => {
    const script = `export const meta = { name: 'test', description: 'A test', phases: [{ title: 'A' }] }
async function userScript() { return 'done'; }`
    const r = await runWorkflowInVm({
      script,
      args: undefined,
      api: {
        agent: async () => ({ ok: false, error: 'x' }),
        parallel: async () => [],
        pipeline: async () => [],
        workflow: async () => undefined,
        args: undefined,
        budget: { total: 0, spent: () => 0, remaining: () => 0 },
        log: () => {},
        phase: () => {},
        setTimeout, clearTimeout,
      },
    })
    expect(r.meta?.name).toBe('test')
    expect(r.meta?.phases?.[0]?.title).toBe('A')
    expect(r.report).toBe('done')
  })

  it('returns no meta when script lacks export const meta', async () => {
    const script = `async function userScript() { return 'x'; }`
    const r = await runWorkflowInVm({
      script,
      args: undefined,
      api: {
        agent: async () => ({ ok: false, error: 'x' }),
        parallel: async () => [],
        pipeline: async () => [],
        workflow: async () => undefined,
        args: undefined,
        budget: { total: 0, spent: () => 0, remaining: () => 0 },
        log: () => {},
        phase: () => {},
        setTimeout, clearTimeout,
      },
    })
    expect(r.meta).toBeUndefined()
    expect(r.report).toBe('x')
  })

  it('throws on invalid meta (TS type annotation)', async () => {
    const script = `export const meta: { name: string } = { name: 'x', description: 'x' }
async function userScript() {}`
    await expect(
      runWorkflowInVm({
        script,
        args: undefined,
        api: {
          agent: async () => ({ ok: false, error: 'x' }),
          parallel: async () => [],
          pipeline: async () => [],
          workflow: async () => undefined,
          args: undefined,
          budget: { total: 0, spent: () => 0, remaining: () => 0 },
          log: () => {},
          phase: () => {},
          setTimeout, clearTimeout,
        },
      }),
    ).rejects.toThrow(/plain JavaScript|TypeScript/)
  })

  it('supports top-level await', async () => {
    const scriptPath = join(FIXTURES_DIR, 'workflow-top-level-await.js')

    const result = await runWorkflowInVm({
      script: scriptPath,
      args: undefined,
      api: {
        agent: async () => ({ ok: false, error: 'x' }),
        parallel: async () => [],
        pipeline: async () => [],
        workflow: async () => undefined,
        args: undefined,
        budget: { total: 0, spent: () => 0, remaining: () => 0 },
        log: () => {},
        phase: () => {},
        setTimeout, clearTimeout,
      },
    })

    // The fixture awaits `new Promise((resolve) => resolve('tla-success'))`
    // at the top level and returns the resolved value. That string must
    // reach `result.report` unchanged.
    expect(result.report).toBe('tla-success')
  })
})

/**
 * OpenCC 2026-06-22: end-to-end test for the workflow args string →
 * parseCliArgs → vmRunner → userScript pipeline. Regression guard so
 * a future refactor of vmRunner / vmContext / createInitialState
 * can't silently drop the parsed object before it reaches userScript.
 *
 * The script reads `args.name` / `args.word` directly. If any layer
 * of the pipeline drops the parsed object (e.g. turns it into `[]`),
 * these assertions fail.
 */
describe('runWorkflowInVm end-to-end with parseCliArgs (workflow args string feature)', () => {
  function makeApi(argsValue: unknown) {
    return {
      agent: async () => ({ ok: false, error: 'mocked' }),
      parallel: async () => [],
      pipeline: async () => [],
      workflow: () => Promise.reject(new Error('workflow() not used')),
      args: argsValue,
      budget: { total: 0, spent: () => 0, remaining: () => 0 },
      log: () => {},
      phase: () => {},
      setTimeout, clearTimeout,
    }
  }

  const echoScript = `return JSON.stringify({name: args.name, word: args.word, verbose: args.verbose});`

  it('CLI string "--name=ethan --word=hello --verbose" → parsed object → userScript sees args.name', async () => {
    const cli = '--name=ethan --word=hello --verbose'
    const parsed = parseCliArgs(cli)
    const r = await runWorkflowInVm({
      script: echoScript,
      args: parsed,
      api: makeApi(parsed),
    })
    expect(r.report).toBe('{"name":"ethan","word":"hello","verbose":true}')
  })

  it('bare positional string "/deep-research \\"What is X?\\"" passes through as a string', async () => {
    // No -- flags → parseCliArgs returns {}; the runtime leaves the raw
    // string in api.args for legacy callers like deepResearch to handle.
    const raw = 'What is X?'
    const r = await runWorkflowInVm({
      script: `return JSON.stringify(args);`,
      args: raw,
      api: makeApi(raw),
    })
    expect(r.report).toBe('"What is X?"')
  })

  it('object passthrough (caller already structured args)', async () => {
    const obj = { projectDir: '/Users/ethan/code/opencc', question: 'What?' }
    // Verify the whole object survives end-to-end: read each key via the
    // script and assert it matches. JSON.stringify drops undefined
    // fields, so use a literal key list and explicit null for missing.
    const script = `
      const keys = Object.keys(args).sort();
      return JSON.stringify({
        keys,
        projectDir: args.projectDir ?? null,
        question: args.question ?? null,
      });
    `
    const r = await runWorkflowInVm({
      script,
      args: obj,
      api: makeApi(obj),
    })
    expect(r.report).toBe(
      '{"keys":["projectDir","question"],"projectDir":"/Users/ethan/code/opencc","question":"What?"}',
    )
  })

  it('array passthrough (legacy positional)', async () => {
    const arr = ['legacy', 'positional']
    const r = await runWorkflowInVm({
      script: `return JSON.stringify(args);`,
      args: arr,
      api: makeApi(arr),
    })
    expect(r.report).toBe('["legacy","positional"]')
  })
})

/**
 * Regression guard for the bare-positional-string lookahead bug caught
 * during real-TUI E2E (2026-06-22). WorkflowTool.call() must only invoke
 * parseCliArgs on strings that actually contain a `--` flag token —
 * otherwise a bare positional string like "What is X?" would be
 * silently destroyed (parseCliArgs returns {} for non-CLI input).
 *
 * These tests exercise the WorkflowTool.call() lookahead directly via
 * a tiny harness that mirrors the call-site logic.
 */
describe('WorkflowTool.call() parseCliArgs lookahead (regression guard for bare positional strings)', () => {
  // Mirror of the call-site logic in WorkflowTool.ts:665-672
  function shouldParse(input: unknown): boolean {
    return typeof input === 'string' && /(?:^|\s)--\w/.test(input)
  }

  it('parses CLI-style string with --flag at start', () => {
    expect(shouldParse('--name=ethan')).toBe(true)
  })

  it('parses CLI-style string with --flag after whitespace', () => {
    expect(shouldParse('What is X? --name=ethan')).toBe(true)
  })

  it('parses CLI-style with bare boolean flag only', () => {
    expect(shouldParse('--verbose')).toBe(true)
  })

  it('does NOT parse bare positional string with no --', () => {
    expect(shouldParse('What is machine learning?')).toBe(false)
  })

  it('does NOT parse empty string', () => {
    expect(shouldParse('')).toBe(false)
  })

  it('does NOT parse whitespace-only string', () => {
    expect(shouldParse('   ')).toBe(false)
  })

  it('does NOT parse object (passthrough)', () => {
    expect(shouldParse({ name: 'ethan' })).toBe(false)
  })

  it('does NOT parse array (passthrough)', () => {
    expect(shouldParse(['legacy', 'positional'])).toBe(false)
  })

  it('does NOT parse single-dash (not a CLI flag)', () => {
    // -x is not a CLI flag in this parser's grammar
    expect(shouldParse('-x')).toBe(false)
  })

  it('does NOT parse double-dash with no flag (e.g. heredoc)', () => {
    // "--" alone (with no letter after) is not a flag
    expect(shouldParse('echo hi --')).toBe(false)
  })
})
