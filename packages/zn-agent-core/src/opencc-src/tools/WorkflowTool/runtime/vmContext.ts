import vm from 'node:vm'

export type WorkflowApi = {
  /**
   * Run a subagent from within a workflow script.
   *
   * @param opts Supported fields:
   *   - agentType?: string         // default 'general-purpose'
   *   - model?: string             // override model for this call
   *   - schema?: JSONSchema        // inject StructuredOutputTool (additive, not restrictive)
   *   - isolation?: 'worktree'     // run in a git worktree
   *   - resumeRunId?: string       // cache replay for resumable workflows
   *   - onProgress?: (s) => void   // progress callback
   *   - tools?: string[]           // allowlist that REPLACES agentDef.tools for
   *                                 // this call. Unknown names silently dropped
   *                                 // (matches resolveAgentTools lenient policy).
   *                                 // [] = no tools. ['*'] = all tools.
   *                                 // Non-array values ignored.
   */
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: <T>(fns: Array<() => Promise<T>>) => Promise<T[]>
  pipeline: <T>(stages: Array<() => Promise<T>>) => Promise<T[]>
  workflow: (nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>
  args: unknown
  budget: { total: number | null; spent(): number; remaining(): number | null }
  log: (...msgs: unknown[]) => void
  phase: (title: string) => void
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  /**
   * Optional channel for scripts to declare UI-visible metadata
   * (name, description, phases). Mirrors the legacy
   * `__setMeta` global from workerScript.ts. The host wires
   * this to forward `{ kind: 'meta', payload }` events so the
   * WorkflowDetailDialog can render the declared phases.
   */
  __setMeta?: (meta: unknown) => void
}

/**
 * Build a Node `vm` context configured for workflow scripts.
 *
 * Security model (matches upstream):
 * - codeGeneration:{strings:false, wasm:false} blocks `eval()`,
 *   `new Function()`, and WebAssembly.compile at the V8 level.
 * - Functions are NOT exposed to scripts — agents/parallel/etc are
 *   invoked via the hostFn wrapper pattern that upstream uses.
 * - The context has no `require`, `process`, `Buffer`, `globalThis`
 *   access — those are not on the context object.
 */
export function createWorkflowVmContext(api: WorkflowApi): vm.Context {
  const ctx = vm.createContext({
    agent: (...args: unknown[]) => api.agent(...(args as [string, Record<string, unknown>])),
    parallel: (...args: unknown[]) => api.parallel(...(args as [Array<() => Promise<unknown>>])),
    pipeline: (...args: unknown[]) => api.pipeline(...(args as [Array<() => Promise<unknown>>])),
    workflow: (...args: unknown[]) => api.workflow(...(args as [string | { scriptPath: string }, unknown])),
    args: api.args,
    budget: Object.freeze({
      total: api.budget.total,
      spent: api.budget.spent,
      remaining: api.budget.remaining,
    }),
    log: api.log,
    phase: api.phase,
    setTimeout: api.setTimeout,
    clearTimeout: api.clearTimeout,
    // __setMeta is optional — the host may omit it (e.g. callers
    // that don't care about workflow metadata). When present,
    // expose it on the context as a no-throw global so the
    // script's `__setMeta(meta)` call survives the VM boundary.
    ...(api.__setMeta ? { __setMeta: api.__setMeta } : {}),
  }, {
    codeGeneration: { strings: false, wasm: false },
    name: 'workflow-vm-context',
  })

  return ctx
}

/**
 * Compile a user script with `codeGeneration:false` and run it in
 * the context. Returns the script's final value via the upstream
 * hostFn pattern: the script body is wrapped in `(async () => {...})()`.
 */
export function runWorkflowScript(
  source: string,
  ctx: vm.Context,
  opts: { timeout?: number } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeout ?? 30000
  const wrapped = `(async () => {\n${source}\n})()`
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Workflow script timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    try {
      // Plan14 Task 1: block dynamic `import()` from workflow scripts.
      // Mirrors upstream `vm.Script({ importModuleDynamically: () => { throw tq_(...) } })`.
      // Date/Math.random are caught earlier in runWorkflowInVm via
      // assertResumeSafe (pre-flight, host-side), so by the time we get
      // here the source is already resume-safe.
      const result = vm.runInContext(wrapped, ctx, {
        timeout: timeoutMs,
        importModuleDynamically: () => {
          throw new Error('import() is not available in workflow scripts.')
        },
      })
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Async scripts return a Promise — chain to deliver the value
      // once it settles. Errors propagate through `catch` below.
      Promise.resolve(result).then(resolve, reject)
    } catch (err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err as Error)
    }
  })
}