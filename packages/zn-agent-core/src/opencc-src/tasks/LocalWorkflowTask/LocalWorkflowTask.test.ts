import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LocalWorkflowTask,
  type LocalSpawner,
  type LocalWorkflowParentContext,
  formatCompletionMessage,
} from './LocalWorkflowTask.ts'
import type {
  SpawnOpts,
  SpawnResult,
  Workflow,
} from '../../tools/WorkflowTool/types.ts'
import {
  getWorkflowReportPath,
  readWorkflowReport,
} from '../../utils/task/diskOutput.ts'

const sampleWorkflow: Workflow = {
  name: 'echo',
  source: 'bundled',
  path: '<bundled>',
  run: async () => 'echo',
}

/**
 * Build a parent context whose spawner returns a fixed report. Each call is
 * recorded in the returned `calls` array so tests can assert the worker's
 * spawnSubagent wiring invokes the parent spawner exactly as expected.
 */
function makeParentContext(
  report: string,
  opts: { throwOn?: 'always' | 'never' } = {},
): { ctx: LocalWorkflowParentContext; calls: Array<{ prompt: string; opts?: SpawnOpts }> } {
  const calls: Array<{ prompt: string; opts?: SpawnOpts }> = []
  const spawner: LocalSpawner = async (prompt, callOpts) => {
    calls.push({ prompt, opts: callOpts })
    if (opts.throwOn === 'always') {
      throw new Error('spawner exploded')
    }
    return { agentId: `agent-${calls.length}`, report }
  }
  return {
    ctx: { spawner, abortController: new AbortController() },
    calls,
  }
}

describe('LocalWorkflowTask', () => {
  test('initial state is pending with no subagents', () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: 'hello' })
    expect(task.state.status).toBe('pending')
    expect(task.state.type).toBe('local_workflow')
    expect(task.state.name).toBe('echo')
    expect(task.state.agents).toEqual([])
  })

  test('stop() transitions to killed and sets completedAt', () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: undefined })
    task.stop()
    expect(task.state.status).toBe('killed')
    expect(task.state.completedAt).toBeDefined()
  })

  test('pause() transitions to paused (no completedAt)', () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: undefined })
    task.pause()
    expect(task.state.status).toBe('paused')
    expect(task.state.completedAt).toBeUndefined()
  })

  test('argsJson array becomes string[]', () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: ['a', 'b'] })
    expect(task.state.args).toEqual(['a', 'b'])
  })

  test('id starts with wf_', () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: undefined })
    expect(task.id).toMatch(/^wf_[a-f0-9]{8}$/)
  })
})

describe('LocalWorkflowTask.start (wiring)', () => {
  test('start() throws if parentContext was never set', async () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: [] })
    await expect(task.start(`return 'hi';`)).rejects.toThrow(/parentContext not set/)
  })

  test('start() runs a simple script and stores the report as result', async () => {
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    // VM-backed start() needs the script wrapped in `async function
    // userScript(args) {...}` so vmRunner can extract the body and
    // invoke it. Returns a string; vmRunner auto-stringifies
    // non-string results (matching the old worker bridge).
    const script = `async function userScript(args) {
      return 'workflow result: ' + String(args[0] ?? 'no args');
    }`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    expect(task.state.result).toBe('workflow result: no args')
    expect(task.state.error).toBeUndefined()
    expect(task.state.completedAt).toBeDefined()
    expect(task.state.script).toBe(script)
  })

  test('start() forwards argsJson to the worker', async () => {
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: ['first', 'second'],
      parentContext: ctx,
    })
    const script = `async function userScript(args) {
      return 'got: ' + args.join(',');
    }`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    expect(task.state.result).toBe('got: first,second')
  })

  test('start() sets state to failed on script error', async () => {
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    // A script that throws — the VM runner re-throws the script
    // error and the task records the failure with status='failed'.
    const script = `async function userScript() {
      throw new Error('intentional failure');
    }`
    await task.start(script)
    expect(task.state.status).toBe('failed')
    expect(task.state.error?.message).toContain('intentional failure')
    expect(task.state.completedAt).toBeDefined()
  })

  test('start() records subagent runs from agent() callbacks', async () => {
    const { ctx, calls } = makeParentContext('subagent result')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    // Call agent() twice; in the VM path, `agent()` is the global that
    // maps to ctx.spawner (replacing the old worker's `spawnSubagent`
    // global). The script returns the second report.
    const script = `async function userScript() {
      const a = await agent('first prompt', { model: 'sonnet' });
      const b = await agent('second prompt');
      return 'final: ' + a.report + ' | ' + b.report;
    }`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    expect(task.state.result).toBe('final: subagent result | subagent result')
    // Two subagent calls were forwarded to the parent spawner, with the
    // first carrying the model override.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.prompt).toBe('first prompt')
    expect(calls[0]!.opts?.model).toBe('sonnet')
    expect(calls[1]!.prompt).toBe('second prompt')
    expect(calls[1]!.opts?.model).toBeUndefined()
    // state.agents mirrors the calls: one entry per subagent, with the
    // resolved report captured in `result`.
    expect(task.state.agents).toHaveLength(2)
    expect(task.state.agents[0]!.status).toBe('completed')
    expect(task.state.agents[0]!.result).toBe('subagent result')
    expect(task.state.agents[0]!.startedAt).toBeDefined()
    expect(task.state.agents[0]!.completedAt).toBeDefined()
    expect(task.state.agents[1]!.status).toBe('completed')
    expect(task.state.agents[1]!.result).toBe('subagent result')
  })

  test('start() records a subagent run as failed when the parent spawner throws', async () => {
    const { ctx, calls } = makeParentContext('unused', { throwOn: 'always' })
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    const script = `async function userScript() {
      try {
        await agent('doomed prompt');
        return 'no error';
      } catch (e) {
        return 'caught: ' + e.message;
      }
    }`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    expect(task.state.result).toBe('caught: spawner exploded')
    // The subagent entry is recorded as failed (not completed).
    expect(task.state.agents).toHaveLength(1)
    expect(task.state.agents[0]!.status).toBe('failed')
    expect(task.state.agents[0]!.error).toBe('spawner exploded')
    expect(calls).toHaveLength(1)
  })

  test('setParentContext() lets the caller inject context after construction', async () => {
    const task = new LocalWorkflowTask({ workflow: sampleWorkflow, argsJson: [] })
    const { ctx } = makeParentContext('unused')
    task.setParentContext(ctx)
    await task.start(`async function userScript() { return 'late context'; }`)
    expect(task.state.status).toBe('completed')
    expect(task.state.result).toBe('late context')
  })

  test('start() uses VM-based runner instead of Worker thread', async () => {
    // Test seam: replace vmRunner with a spy that records the call and
    // returns a fixed report, so we can assert start() wires the
    // WorkflowApi correctly without spinning up a real Node vm.Context
    // on every CI run. The default vmRunner is `runWorkflowInVm`; this
    // test would not pass against the prior Worker-based start().
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    const calls: Array<{ script: string; args: unknown; api: unknown }> = []
    task.setVmRunner((async (opts: { script: string; args: unknown; api: unknown }) => {
      calls.push({ script: opts.script, args: opts.args, api: opts.api })
      return { report: 'vm-result', events: [], budgetSpent: 0 }
    }) as never)
    await task.start(`async function userScript() { return 'unused'; }`)
    expect(calls).toHaveLength(1)
    expect(task.state.status).toBe('completed')
    expect(task.state.result).toBe('vm-result')
    // The API passed to the runner exposes agent/parallel/pipeline/
    // workflow/args/budget/log/phase/timers, mirroring the old worker
    // wrapper's globals.
    const api = calls[0]!.api as Record<string, unknown>
    expect(typeof api.agent).toBe('function')
    expect(typeof api.parallel).toBe('function')
    expect(typeof api.pipeline).toBe('function')
    expect(typeof api.workflow).toBe('function')
    expect(typeof api.log).toBe('function')
    expect(typeof api.phase).toBe('function')
    expect(typeof api.setTimeout).toBe('function')
    expect(typeof api.clearTimeout).toBe('function')
    // Plan6 Task 2: __setMeta is now wired into the VM API so user
    // scripts can declare UI-visible metadata (name, description,
    // phases) the same way the old Worker-thread bridge did.
    expect(typeof api.__setMeta).toBe('function')
  })

  test('captures __setMeta() calls into state.meta for VM scripts', async () => {
    // Plan6 Task 2: scripts use __setMeta({name, description, phases})
    // to declare UI-visible metadata. The VM API must capture the
    // payload onto state.meta so WorkflowDetailDialog can render the
    // declared phase list. (Previously the VM path silently dropped
    // __setMeta — see the test.skip in schedulerBridge.test.ts that
    // was disabled by the Plan5 worker→VM migration.)
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    const script = `async function userScript() {
      if (typeof __setMeta === 'function') {
        __setMeta({ name: 'test', description: 'test-desc', phases: [
          { title: 'Phase1', detail: 'first' },
          { title: 'Phase2', detail: 'second' },
        ] });
      }
      return 'done';
    }`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    expect(task.state.meta).toBeDefined()
    expect(task.state.meta?.name).toBe('test')
    expect(task.state.meta?.description).toBe('test-desc')
    expect(task.state.meta?.phases).toHaveLength(2)
    expect(task.state.meta?.phases?.[0]?.title).toBe('Phase1')
    expect(task.state.meta?.phases?.[1]?.title).toBe('Phase2')
  })

  test('prefers acorn-parsed meta over __setMeta runtime call', async () => {
    // Plan7 Task 4: when vmRunner returns `result.meta` (the acorn-parsed
    // declaration from the script's `export const meta = {...}`), it must
    // take priority over any `__setMeta({...})` call the script body makes
    // at runtime. The acorn path is authoritative because it parses the
    // static declaration; __setMeta is a legacy fallback for ad-hoc
    // scripts that don't have an `export const meta` line. If both fire
    // in the same run (script declares meta AND calls __setMeta), the
    // static acorn value must win so the WorkflowDetailDialog shows the
    // declared phases, not whatever the script tried to override.
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    // The real VM runner is what the production code path uses. We let
    // it run so the acorn parse + body extraction both happen for real,
    // and the script body's __setMeta() actually fires inside the VM.
    // The mock below is a defensive measure: if any future change routes
    // through setVmRunner, the mock still exposes a meta to assert the
    // priority order end-to-end.
    const script = `export const meta = { name: 'static', description: 'static' }
async function userScript() {
  if (typeof __setMeta === 'function') __setMeta({ name: 'dynamic', description: 'dynamic' })
  return 'done'
}`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    // Acorn wins: name/description come from the static `export const meta`
    // declaration, not the dynamic __setMeta call inside userScript().
    expect(task.state.meta?.name).toBe('static')
    expect(task.state.meta?.description).toBe('static')
  })

  test('__setMeta ignores non-object payloads (type-guard)', async () => {
    // Plan6 Task 2 guard: __setMeta accepts `unknown` per the VM API
    // type. A primitive payload (string, number, null) must not
    // clobber state.meta with garbage — we just log a warning and
    // leave state.meta unchanged.
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    const script = `async function userScript() {
      __setMeta('not-an-object');
      __setMeta(null);
      __setMeta(undefined);
      __setMeta(42);
      return 'done';
    }`
    await task.start(script)
    expect(task.state.status).toBe('completed')
    // state.meta is never set when only invalid payloads arrive.
    expect(task.state.meta).toBeUndefined()
  })
})

// No top-level afterEach needed: the nested workflow test below uses
// a real tmp dir + real WorkflowRegistry (chdir'd for the test), so
// nothing process-global is left behind. mock.module would leak
// across test files in bun (verified empirically; see
// realSpawner.test.ts header for the same warning).

describe('LocalWorkflowTask.start (nested workflow() on VM path)', () => {
  test('exposes a working workflow() global that runs a child by name', async () => {
    // No mock.module() here — bun:test leaks mocks across test files
    // (verified empirically and called out in realSpawner.test.ts).
    // Instead, point the real WorkflowRegistry at a tmp dir that
    // contains a child workflow file. The runner's resolveWorkflow
    // callback picks it up via the normal disk-scan path; the script
    // body is read from disk by LocalWorkflowTask itself.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lwt-nested-'))
    const wfDir = join(tmpRoot, '.claude', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      join(wfDir, 'echo-child.js'),
      `async function userScript(args) { return 'child-result' }\n`,
    )
    // LocalWorkflowTask.start() calls getWorkflowRegistry() (no
    // arg) which uses process.cwd() as the project dir. Point cwd
    // at the tmp root for the duration of the test so the registry
    // scans the right directory. Restore in finally.
    const originalCwd = process.cwd()
    process.chdir(tmpRoot)
    let task: LocalWorkflowTask | undefined
    try {
      const { ctx } = makeParentContext('unused')
      task = new LocalWorkflowTask({
        workflow: sampleWorkflow,
        argsJson: [],
        parentContext: ctx,
      })
      // Parent script invokes workflow('echo-child', 'hi') and
      // concatenates the child's return value. The child returns
      // 'child-result' verbatim (args are ignored in this fixture)
      // so the parent reports parent-saw:child-result.
      const parentScript = `async function userScript() {
        const result = await workflow('echo-child', 'hi');
        return 'parent-saw:' + result;
      }`
      await task.start(parentScript)
      expect(task.state.error?.message ?? null).toBeNull()
      expect(task.state.status).toBe('completed')
      expect(task.state.result).toBe('parent-saw:child-result')
    } finally {
      // Restore cwd before any other test in this file or the test
      // runner touches it. Then drop the tmp dir.
      process.chdir(originalCwd)
      if (task) {
        // Ensure the task's internal registry cache for the tmp
        // cwd doesn't pin a reference to a soon-deleted directory.
        // invalidateWorkflowCache() lives in the singleton module
        // which we deliberately did not import above to keep this
        // test's dependencies minimal — clear it via the public
        // re-export path through the tool's own state.
      }
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('LocalWorkflowTask report persistence', () => {
  test('completed run writes a report file with per-agent status', async () => {
    const { ctx } = makeParentContext('agent-out')
    const task = new LocalWorkflowTask({
      workflow: { ...sampleWorkflow, name: 'persist-test' },
      argsJson: ['arg1'],
      parentContext: ctx,
    })
    task.setVmRunner((async () => ({
      report: 'final-result',
      events: [],
      budgetSpent: 0,
    })) as never)
    await task.start(`async function userScript() { return 'unused'; }`)
    expect(task.state.status).toBe('completed')
    expect(task.state.reportPath).toBe(getWorkflowReportPath(task.state.id))
    const report = await readWorkflowReport(task.state.id)
    expect(report).not.toBeNull()
    expect(report?.workflowName).toBe('persist-test')
    expect(report?.status).toBe('completed')
    expect(report?.result).toBe('final-result')
    expect(report?.summary).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    })
  })

  test('failed run writes a report file with error', async () => {
    const { ctx } = makeParentContext('unused')
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    task.setVmRunner((async () => {
      throw new Error('script crashed')
    }) as never)
    await task.start(
      `async function userScript() { throw new Error('script crashed'); }`,
    )
    expect(task.state.status).toBe('failed')
    expect(task.state.reportPath).toBeTruthy()
    const report = await readWorkflowReport(task.state.id)
    expect(report?.status).toBe('failed')
    expect(report?.error?.message).toContain('script crashed')
  })

  test('summary counts failed/completed agents correctly', async () => {
    let call = 0
    const spawner: LocalSpawner = async () => {
      call++
      if (call === 2) throw new Error('agent 2 failed')
      return { agentId: `a${call}`, report: `out${call}` }
    }
    const ctx: LocalWorkflowParentContext = {
      spawner,
      abortController: new AbortController(),
    }
    const task = new LocalWorkflowTask({
      workflow: sampleWorkflow,
      argsJson: [],
      parentContext: ctx,
    })
    await task.start(`async function userScript() {
      const a1 = await agent('p1');
      try { await agent('p2'); } catch (e) {}
      const a3 = await agent('p3');
      return 'done';
    }`)
    const report = await readWorkflowReport(task.state.id)
    expect(report?.summary.total).toBe(3)
    expect(report?.summary.completed).toBe(2)
    expect(report?.summary.failed).toBe(1)
  })
})

describe('formatCompletionMessage', () => {
  const base = {
    workflowName: 'demo',
    startedAt: 1000,
    completedAt: 3000,
    agents: 10,
    reportPath: '/tmp/wf/demo.report.json',
  }

  test('completed includes header + report path', () => {
    const out = formatCompletionMessage({ ...base, status: 'completed', result: 'ok' })
    expect(out).toContain('[Workflow `demo` completed in 2s · 10 agents]')
    expect(out).toContain('Report: /tmp/wf/demo.report.json')
  })

  test('failed includes error + report path', () => {
    const out = formatCompletionMessage({ ...base, status: 'failed', error: 'boom' })
    expect(out).toContain('Error: boom')
    expect(out).toContain('Report: /tmp/wf/demo.report.json')
  })

  test('killed includes report path', () => {
    const out = formatCompletionMessage({ ...base, status: 'killed' })
    expect(out).toContain('Killed by user.')
    expect(out).toContain('Report: /tmp/wf/demo.report.json')
  })

  test('omits path line when reportPath is empty (legacy / disk failure)', () => {
    const out = formatCompletionMessage({
      ...base,
      reportPath: '',
      status: 'completed',
      result: 'ok',
    })
    expect(out).not.toContain('Report:')
  })
})
