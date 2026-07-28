import { describe, expect, it } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkerScript } from './workerScript.js'

/**
 * End-to-end test for the workflow() RPC path: parent workflow -> bridge
 * -> child workflow. This is what Tasks 4-5 wired (buildWorkerScript
 * exposes workflow() that posts {kind:'workflow', callId, ref, args};
 * the bridge posts back {kind:'workflowResult', callId, result|error}).
 *
 * The plan's e2e sketch suggested re-spawning a child in the same
 * worker, but the actual architecture is RPC. So the test acts as the
 * bridge: when the parent worker posts {kind:'workflow', ...}, the
 * test resolves the child script and spawns a fresh child Worker,
 * piping the child's final {kind:'report'} back to the parent as
 * {kind:'workflowResult', callId, result}.
 */

type WorkerMsg =
  | { kind: 'report'; value: string }
  | { kind: 'error'; message: string; stack?: string }
  | {
      kind: 'workflow'
      callId: number
      ref: { kind: 'name'; value: string } | { kind: 'scriptPath'; value: string }
      args?: unknown
    }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'phase'; title: string }
  | { kind: 'meta'; meta: unknown }

/**
 * Run a workflow script in a fresh Worker, with a minimal bridge that
 * handles workflow() RPC calls by spawning a new Worker for the child
 * script (the way the real schedulerBridge does). Resolves with the
 * parent's final report.value, or rejects on error.
 */
async function runParentScript(
  parentScript: string,
  args: unknown,
  timeoutMs = 10_000,
): Promise<string> {
  const wrapper = buildWorkerScript(parentScript)
  const parent = new Worker(wrapper, { eval: true, workerData: {} })

  // Track every child worker we spawn so we can terminate them on
  // resolve/reject. The parent worker cleans itself up via the bridge
  // when it sees the 'report' message; we only need to manage children
  // here.
  const childWorkers: Worker[] = []

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const timeoutHandle = setTimeout(() => {
      if (settled) return
      settled = true
      for (const w of childWorkers) void w.terminate().catch(() => {})
      void parent.terminate().catch(() => {})
      reject(new Error(`parent worker timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = (err?: Error, value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      for (const w of childWorkers) void w.terminate().catch(() => {})
      void parent.terminate().catch(() => {})
      if (err) reject(err)
      else resolve(value ?? '')
    }

    // Handle a single workflow() RPC: spawn a child Worker for the
    // child script, wait for its final report, and post back the
    // result. Mirrors schedulerBridge's runChildScript path.
    const handleWorkflowCall = (
      callId: number,
      ref: { kind: 'name'; value: string } | { kind: 'scriptPath'; value: string },
      wfArgs: unknown,
    ) => {
      let childScript: string
      try {
        if (ref.kind === 'scriptPath') {
          childScript = readFileSync(ref.value, 'utf-8')
        } else {
          cleanup(
            new Error(
              `test bridge: name-kind workflow() not supported in this e2e test (ref=${ref.value})`,
            ),
          )
          return
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        try {
          parent.postMessage({
            kind: 'workflowResult',
            callId,
            error: message,
          })
        } catch {}
        return
      }

      const childWrapper = buildWorkerScript(childScript)
      const child = new Worker(childWrapper, { eval: true, workerData: {} })
      childWorkers.push(child)

      child.on('message', (msg: WorkerMsg) => {
        if (msg.kind === 'report') {
          try {
            parent.postMessage({
              kind: 'workflowResult',
              callId,
              result: msg.value,
            })
          } catch {}
        } else if (msg.kind === 'error') {
          try {
            parent.postMessage({
              kind: 'workflowResult',
              callId,
              error: msg.message,
            })
          } catch {}
        }
      })
      child.on('error', (err: Error) => {
        try {
          parent.postMessage({
            kind: 'workflowResult',
            callId,
            error: err.message,
          })
        } catch {}
      })
      child.on('exit', (code) => {
        if (code !== 0 && !settled) {
          // Child exited without sending report/error — surface as a
          // workflowResult error so the parent doesn't hang.
          try {
            parent.postMessage({
              kind: 'workflowResult',
              callId,
              error: `child worker exited with code ${code} before reporting`,
            })
          } catch {}
        }
      })
      child.postMessage({
        kind: 'init',
        args: Array.isArray(wfArgs) ? (wfArgs as string[]) : wfArgs === undefined ? [] : [String(wfArgs)],
        runId: 'pending',
        budgetTotal: 0,
      })
    }

    parent.on('message', (msg: WorkerMsg) => {
      if (msg.kind === 'report') {
        cleanup(undefined, msg.value)
        return
      }
      if (msg.kind === 'error') {
        cleanup(new Error(msg.message))
        return
      }
      if (msg.kind === 'workflow') {
        handleWorkflowCall(msg.callId, msg.ref, msg.args)
        return
      }
      // 'log' / 'phase' / 'meta' are ignored in this minimal bridge.
    })

    parent.on('error', (err: Error) => {
      cleanup(err)
    })

    parent.on('exit', (code) => {
      if (settled) return
      if (code === 0) {
        cleanup(new Error('parent worker exited cleanly without sending a result'))
      } else {
        cleanup(new Error(`parent worker exited with code ${code} before reporting`))
      }
    })

    // Kick off the parent script. The test bridge doesn't care about
    // the parent's runId; it only handles the workflow() RPC.
    parent.postMessage({
      kind: 'init',
      args: Array.isArray(args) ? (args as string[]) : args === undefined ? [] : [String(args)],
      runId: 'pending',
      budgetTotal: 0,
    })
  })
}

describe('nested workflow end-to-end (RPC)', () => {
  it('parent workflow() -> bridge -> child worker -> result back to parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-nested-'))
    const childPath = join(dir, 'child.js')
    writeFileSync(
      childPath,
      `return 'child-got:' + String(args);`,
    )

    // Build parent script as a string. Note the childPath is JSON-serialized
    // so backslashes / special chars survive the worker boundary intact
    // (matches the production schedulerBridge.test.ts pattern).
    const parentScript = `
      const child = await workflow({ scriptPath: ${JSON.stringify(childPath)} }, 'hello')
      return 'parent-saw:' + child
    `

    const result = await runParentScript(parentScript, 'top-args')
    expect(result).toBe('parent-saw:child-got:hello')
  })

  it('propagates child errors to the parent via workflowResult.error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-nested-err-'))
    const childPath = join(dir, 'child-err.js')
    writeFileSync(
      childPath,
      `throw new Error('boom-from-child');`,
    )

    const parentScript = `
      try {
        await workflow({ scriptPath: ${JSON.stringify(childPath)} }, 'irrelevant')
        return 'parent-should-not-reach'
      } catch (e) {
        return 'parent-caught:' + e.message
      }
    `

    const result = await runParentScript(parentScript, undefined)
    expect(result).toBe('parent-caught:boom-from-child')
  })

  it('propagates a child scriptPath read failure as a workflow() error', async () => {
    // The child scriptPath does not exist on disk. The bridge-side
    // handler in this test returns a workflowResult with error:...,
    // which the parent receives and surfaces via the workflow() Promise
    // rejection.
    const dir = mkdtempSync(join(tmpdir(), 'wf-nested-missing-'))
    const missingPath = join(dir, 'does-not-exist.js')

    const parentScript = `
      try {
        await workflow({ scriptPath: ${JSON.stringify(missingPath)} }, 'irrelevant')
        return 'parent-should-not-reach'
      } catch (e) {
        return 'parent-caught:' + e.message
      }
    `

    const result = await runParentScript(parentScript, undefined)
    expect(result).toMatch(/^parent-caught:/)
    // The underlying error should mention something about the missing file
    // (ENOENT or similar) so the user can diagnose it.
    expect(result).toMatch(/ENOENT|no such file|cannot find/i)
  })
})
