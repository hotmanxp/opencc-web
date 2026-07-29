import { randomUUID } from 'crypto'
import type { Task, TaskStatus } from '../../Task.ts'
import type {
  SpawnOpts,
  SpawnResult,
  Workflow,
  WorkflowAgentState,
  WorkflowPhaseMeta,
} from '../../tools/WorkflowTool/types.ts'
import { registerWorkflowRun } from '../../tools/WorkflowTool/workflowRunStore.ts'
import { registerWorkflowTask, unregisterWorkflowTask } from './lifecycle.ts'
import { runWorkflowInWorker } from './schedulerBridge.ts'
import { runWorkflowInVm, type VmRunnerResult } from '../../tools/WorkflowTool/runtime/vmRunner.ts'
import type { ParsedWorkflowMeta } from '../../tools/WorkflowTool/parseMetaFromScript.ts'
import { createNestedWorkflowRunner } from '../../tools/WorkflowTool/runtime/workflowNested.ts'
import type { WorkflowApi } from '../../tools/WorkflowTool/runtime/vmContext.ts'
import { createInitialState, type LocalWorkflowTaskState } from './state.ts'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.ts'
import { logError } from '../../utils/log.ts'
import {
  writeWorkflowReport,
  type WorkflowReport,
} from '../../utils/task/diskOutput.ts'

// Re-export so consumers (notably src/tasks/types.ts) can import
// LocalWorkflowTaskState from this entrypoint.
export type { LocalWorkflowTaskState } from './state.ts'

/**
 * A pre-built spawner the parent task provides to LocalWorkflowTask. The
 * caller (WorkflowTool) captures the parent's toolUseContext / canUseTool /
 * model / etc. inside this closure, so the workflow script can call
 * spawnSubagent() without LocalWorkflowTask having to know how to build
 * an AgentTool invocation. Function shape matches the bridge's
 * SpawnSubagentFn exactly.
 */
export type LocalSpawner = (
  prompt: string,
  opts?: SpawnOpts,
) => Promise<SpawnResult>

/**
 * Minimal context LocalWorkflowTask needs from the parent task to wire
 * spawnSubagent() to the parent's runAgent pipeline. Construction-time
 * optional (via constructor) or injected later via setParentContext().
 */
export type LocalWorkflowParentContext = {
  spawner: LocalSpawner
  abortController: AbortController
  /**
   * Optional. Used by LocalWorkflowTask to (a) trigger re-renders of
   * any UI subscribed to appState.workflows when a subagent's progress
   * updates, and (b) push a system message into the chat when the
   * workflow reaches a terminal state. Both operations need access
   * to the app state slice, which the parent (WorkflowTool) holds.
   *
   * The setter is the same one WorkflowTool extracts from
   * `toolUseCtx.setAppState`. Tests / standalone callers that don't
   * have an app state can omit this — LocalWorkflowTask gracefully
   * skips the notifications.
   */
  setAppState?: (updater: (prev: unknown) => unknown) => void
}

export interface LocalWorkflowTaskOptions {
  workflow: Workflow
  argsJson: unknown
  parentContext?: LocalWorkflowParentContext
}

export class LocalWorkflowTask implements Task {
  public readonly state: LocalWorkflowTaskState
  private readonly workflow: Workflow
  private abortController = new AbortController()
  private parentContext: LocalWorkflowParentContext | null = null
  private readonly _unregisterRun: () => void
  // Task interface compliance — name is required by Task.
  public readonly name = 'LocalWorkflowTask'
  // VM runner used by start() to execute the user script. Override via
  // setVmRunner() in tests to assert wiring without spawning a VM.
  private vmRunner: typeof runWorkflowInVm = runWorkflowInVm
  // Depth counter handed to createNestedWorkflowRunner so a child
  // workflow's `workflow()` call is rejected by the runner's own
  // guard (nesting is limited to one level). 0 = parent, 1 = child.
  private _childDepth = 0

  constructor(args: LocalWorkflowTaskOptions) {
    this.workflow = args.workflow
    if (args.parentContext) {
      this.parentContext = args.parentContext
    }
    const id = `wf_${randomUUID().slice(0, 8)}`
    this.state = createInitialState({
      id,
      workflowName: args.workflow.name,
      description: `Workflow: ${args.workflow.name}`,
      argsJson: args.argsJson,
    })
    // Make the task findable by the lifecycle helpers (kill / skip / retry)
    // used by BackgroundTasksDialog and WorkflowDetailDialog.
    registerWorkflowTask(this)
    // Register with the session-level run store so /workflows can list it.
    this._unregisterRun = registerWorkflowRun(this)
  }

  get type(): 'local_workflow' {
    return 'local_workflow'
  }

  get id(): string {
    return this.state.id
  }

  /**
   * Inject the parent context. Required before start() if the workflow
   * script will call spawnSubagent(). May also be passed to the
   * constructor as a shorthand when the context is available up front.
   */
  setParentContext(ctx: LocalWorkflowParentContext): void {
    this.parentContext = ctx
  }

  /**
   * Test seam: replace the VM runner used by start(). Production code
   * should leave the default `runWorkflowInVm` in place; tests inject a
   * mock to assert that start() wires the API correctly without
   * spinning up a Node vm.Context for every assertion.
   */
  setVmRunner(fn: typeof runWorkflowInVm): void {
    this.vmRunner = fn
  }

  /**
   * Run a child workflow script inline (in a new Worker) and resolve
   * with the userScript's return value. Used by the parent's
   * schedulerBridge to handle a `kind: 'workflow'` message from a
   * running workflow's wrapper.
   *
   * The child shares the parent's `parentContext.spawner`, so
   * subagents invoked from the child still flow through the parent's
   * runAgent pipeline. A parent's abort cascades to the child via
   * the shared AbortController signal. Child tasks are NOT registered
   * with the lifecycle registry and do NOT push completion
   * notifications — they're an implementation detail of the parent.
   *
   * The synthetic workflow object is required by the Workflow type but
   * never used by the bridge (which reads the script source directly
   * from the `script` argument). Matches the bundled pattern in
   * WorkflowTool.bundled.index.
   */
  async runInline(script: string, args: unknown): Promise<unknown> {
    const report = await runWorkflowInWorker({
      workflow: {
        name: '<child>',
        source: 'bundled',
        path: '<inline>',
        run: async () => '',
      },
      script,
      args,
      spawnSubagent: this.parentContext
        ? (prompt, opts) => this.parentContext!.spawner(prompt, opts)
        : undefined,
      signal: this.abortController.signal,
      // No runId — child phase/meta messages are dropped by the
      // bridge because findWorkflowTask() returns undefined. The
      // child's UI hooks are suppressed by design.
      budgetTotal: this.state.budgetTotal ?? 0,
    })
    // Best-effort JSON-parse so the child can return a structured
    // object, not just a string. The wrapper's report message
    // JSON-stringifies non-string results; reverse that here.
    try {
      return JSON.parse(report)
    } catch {
      return report
    }
  }

  /**
   * Run the workflow script in a Node `vm` context. Replaces the prior
   * worker_threads-based path with a tighter sandbox that doesn't pay
   * the cost of spawning a Worker for every run. The VM API surface
   * (`agent`, `parallel`, `pipeline`, `workflow`, `args`, `budget`,
   * `log`, `phase`, `setTimeout`, `clearTimeout`) is the same shape
   * the worker wrapper exposed, so script-level behavior is unchanged.
   *
   * The `workflow()` global is a deliberate stub for now — wiring it
   * through to runInline() is part of Plan4 nested-workflow support
   * (Task5); children continue to be spawned via runWorkflowInWorker
   * for the remaining uses of the bridge.
   */
  async start(script: string): Promise<void> {
    if (!this.parentContext) {
      throw new Error(
        'LocalWorkflowTask.start(): parentContext not set. ' +
          'Call setParentContext() (or pass parentContext in the constructor) ' +
          'so the workflow can route spawnSubagent() calls.',
      )
    }

    this.state.status = 'running'
    this.state.script = script

    const parentContext = this.parentContext
    const spawnSubagent = this.buildSpawnSubagent(parentContext)

    // Build the WorkflowApi that the VM script sees. Mirrors the
    // shape the old worker wrapper exposed so the script can keep
    // using the same globals (agent, parallel, pipeline, args,
    // budget, log, phase, timers). `workflow()` is a deliberate
    // not-yet-wired stub; Plan4's runInline path uses the Worker
    // bridge directly for children until the VM-side RPC lands.
    const api: WorkflowApi = {
      agent: async (prompt: string, opts?: Record<string, unknown>) => {
        const spawnOpts = (opts ?? {}) as SpawnOpts
        const result = await spawnSubagent(prompt, spawnOpts)
        return {
          ok: true as const,
          agentId: result.agentId,
          report: result.report,
          structuredOutput: result.structuredOutput,
        }
      },
      parallel: async <T,>(fns: Array<() => Promise<T>>): Promise<T[]> => {
        return (await Promise.all(fns.map((f) => f()))) as T[]
      },
      pipeline: async <T,>(stages: Array<() => Promise<T>>): Promise<T[]> => {
        const out: T[] = []
        for (const s of stages) out.push(await s())
        return out
      },
      workflow: async (
        nameOrRef: string | { scriptPath: string },
        args?: unknown,
      ) => {
        // Plan4 nested-workflow support on the VM path: wire the
        // script's `workflow(name, args)` global through
        // createNestedWorkflowRunner, which enforces upstream's
        // "one level of nesting only" rule via its own nestingDepth
        // guard. The child itself is run inline via runWorkflowInVm
        // using buildVmApiForChild() — the same API surface as the
        // parent, with `workflow()` overridden to a hard error so
        // an attempt at deeper nesting throws a clear message
        // (defence in depth — the runner's nestingDepth check
        // should already reject it).
        const { getWorkflowRegistry } = await import(
          '../../tools/WorkflowTool/singleton.js'
        )
        const { readFileSync } = await import('fs')
        const { getBundledSource } = await import(
          '../../tools/WorkflowTool/bundled/index.js'
        )
        const runner = createNestedWorkflowRunner({
          resolveWorkflow: async (name: string) => {
            const def = await getWorkflowRegistry().get(name)
            if (!def) return null
            const script = def.source === 'bundled'
              ? (getBundledSource(name) ?? '')
              : readFileSync(def.path, 'utf-8')
            return { name: def.name, script }
          },
          runScript: async (script: string, childArgs: unknown) => {
            // Run the child inline in its own VM context. Same
            // API surface as the parent; one-level depth is
            // enforced by createNestedWorkflowRunner itself when
            // the child calls workflow() again. Return the
            // stringified `report` so script-level callers get a
            // value they can concatenate / log / return — the
            // raw `{ report, events, budgetSpent }` envelope is
            // an internal detail of runWorkflowInVm.
            const result = await runWorkflowInVm({
              script,
              args: childArgs,
              api: this.buildVmApiForChild(),
              timeoutMs: 30000,
            })
            return result.report
          },
          nestingDepth: this._childDepth,
        })
        return runner(nameOrRef, args)
      },
      args: this.state.args,
      budget: {
        total: this.state.budgetTotal ?? 0,
        spent: () => 0,
        remaining: () => this.state.budgetTotal ?? 0,
      },
      log: (...msgs: unknown[]) => {
        // The old worker wrapper surfaced script log() calls through
        // the bridge's `log` message handler. We don't have a
        // structured equivalent on the VM side yet — pipe to the
        // canonical error sink so /errorlog still surfaces them, and
        // prefix with [workflow] so the origin is unambiguous when
        // a developer is scanning the log.
        const line = msgs.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')
        logError(new Error(`[workflow] ${line}`))
      },
      phase: (title: string) => {
        // Mirrors the old worker's `phase` message handler: update
        // the UI-visible currentPhase so /workflows and the
        // WorkflowDetailDialog can show the active step without
        // reaching back to the bridge.
        this.state.currentPhase = String(title ?? '')
        this.bumpWorkflowsVersion(parentContext)
      },
      __setMeta: (meta: unknown) => {
        // Plan6 Task 2: the old worker-thread bridge routed
        // `__setMeta(meta)` into a `{ kind: 'meta', meta }` postMessage
        // that the parent translated onto state.meta. The VM path
        // previously had no `__setMeta` global, so the bundled
        // `deep-research` script (which calls __setMeta at the top
        // with the 5-phase list) appeared as a 0-phase workflow in
        // WorkflowDetailDialog. This handler restores the channel:
        // type-guard the unknown payload, write through to
        // state.meta, and re-render so the panel sees the new
        // phases. Per the VM API contract (__setMeta takes unknown)
        // we cannot trust the shape — non-objects are dropped.
        if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
          this.setMeta(parentContext, meta as WorkflowPhaseMeta)
        } else {
          // Noisy-but-rare: a buggy caller passing a primitive. The
          // plan-audit showed that `as any` suppression here was a
          // hotspot for type noise, so we type-guard at the boundary
          // and leave state.meta untouched.
          console.warn(
            '[LocalWorkflowTask] __setMeta ignored: expected an object, got',
            typeof meta,
          )
        }
      },
      setTimeout: ((...args: Parameters<typeof setTimeout>) =>
        setTimeout(...args)) as typeof setTimeout,
      clearTimeout: ((...args: Parameters<typeof clearTimeout>) =>
        clearTimeout(...args)) as typeof clearTimeout,
    }

    try {
      const result: VmRunnerResult = await this.vmRunner({
        script,
        args: this.state.args,
        api,
      })
      // Plan7 Task 4: acorn-parsed meta (from the script's static
      // `export const meta = {...}` declaration) takes priority over any
      // `__setMeta({...})` call the script body made at runtime. By the
      // time we get here the VM has already executed userScript() — so
      // __setMeta may have already written state.meta via the api
      // handler above. Re-applying the acorn value here overrides that
      // with the authoritative static declaration. Scripts that have no
      // `export const meta` (legacy / ad-hoc) get `result.meta ===
      // undefined` and the runtime __setMeta call (if any) survives.
      if (result.meta) {
        this.setMeta(parentContext, result.meta)
      }
      this.state.result = result.report
      this.state.status = 'completed'
    } catch (err) {
      this.state.error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }
      // If `stop()` was called (user-initiated kill), it set
      // `state.status = 'killed'` before the abort cascaded. Don't
      // clobber that with `'failed'` — the user explicitly killed
      // this run, and the chat transcript + `/workflows` panel
      // both render `'killed'` distinctly from `'failed'`
      // (different verb in formatCompletionMessage, different
      // status text). Without this guard, killing a workflow
      // would show up as "failed in 7s · Error: ..." which is
      // misleading.
      //
      // Cast widens the narrowed type — TS sees only
      // 'completed' | 'running' here, but `stop()` can set
      // 'killed' before the await rejects.
      if ((this.state.status as TaskStatus) !== 'killed') {
        this.state.status = 'failed'
      }
    } finally {
      this.state.completedAt = Date.now()

      // Persist the aggregated per-agent report before notifying so
      // the LLM can `Read` it via the path we surface in
      // formatCompletionMessage. Best-effort: a disk failure must
      // not block task completion / notification.
      try {
        const startedAt = this.state.startedAt
        const completedAt = this.state.completedAt ?? Date.now()
        const agents = this.state.agents
        const summary = {
          total: agents.length,
          completed: agents.filter(a => a.status === 'completed').length,
          failed: agents.filter(a => a.status === 'failed').length,
          skipped: agents.filter(a => a.status === 'skipped').length,
        }
        const report: WorkflowReport = {
          schemaVersion: 1,
          taskId: this.state.id,
          workflowName: this.state.name,
          description: this.state.description,
          status: this.state.status as WorkflowReport['status'],
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
          args: this.state.args,
          meta: this.state.meta,
          result: this.state.result,
          error: this.state.error,
          agents: agents.map(a => ({
            id: a.id,
            label: a.label,
            phase: a.phase,
            model: a.model,
            status: a.status,
            prompt: a.prompt,
            result: a.result,
            error: a.error,
            startedAt: a.startedAt,
            completedAt: a.completedAt,
            durationMs:
              a.startedAt && a.completedAt
                ? Math.max(0, a.completedAt - a.startedAt)
                : undefined,
            tokensUsed: a.tokensUsed,
            toolsUsed: a.toolsUsed,
            toolCalls: a.toolCalls as unknown[] | undefined,
            worktreePath: a.worktreePath,
            isolationRemoved: a.isolationRemoved,
          })),
          summary,
        }
        this.state.reportPath = await writeWorkflowReport(this.state.id, report)
      } catch (e) {
        // best-effort; never block workflow completion on disk I/O
        logError(e)
      }

      // Terminal state reached — drop from the lifecycle registry so the
      // dialog no longer offers kill / skip / retry controls for it.
      unregisterWorkflowTask(this.state.id)
      // Also remove from the session run store.
      this._unregisterRun()
      // Push a system message into the chat so the user gets
      // visible feedback that the workflow finished. Without this,
      // the run is invisible unless the user happens to open the
      // /workflows panel and dig into the per-agent result. The
      // helper is a no-op if no setAppState was injected (tests,
      // standalone callers) — we don't want to crash the run on
      // notification failure.
      try {
        this.pushCompletionMessage()
      } catch {
        // best-effort; never block workflow completion on chat UX
      }
    }
  }

  /**
   * Build and push a task-notification message into the framework's
   * pending-notification queue when the workflow reaches a terminal
   * state. The REPL main loop drains the queue and injects each
   * notification as a user-facing prompt so the LLM can process
   * the workflow result and respond to the user.
   *
   * This is the right mechanism (vs. `appendSystemMessage`):
   *   - `appendSystemMessage` only writes to the chat transcript; it
   *     does NOT trigger a new LLM turn. The user would see a
   *     system message but the LLM would have no way to process
   *     the result.
   *   - `enqueuePendingNotification({ mode: 'task-notification' })`
   *     goes through the same path as LocalAgentTask /
   *     LocalShellTask completion (see those files for examples).
   *     The framework wraps the value in `<task_notification>` XML,
   *     enqueues it as a user message, and the LLM sees the
   *     workflow result in its next turn and can summarize for
   *     the user.
   *
   * The body is the same human-readable summary that the previous
   * (broken) `appendSystemMessage` approach tried to push — we
   * just deliver it through the right channel now.
   */
  private pushCompletionMessage(): void {
    // Idempotent: stop() and runWorkflowInVm's finally both call
    // this on the way to a terminal status. Without the guard, a
    // x-stop followed by an in-flight abort resolution would
    // enqueue two completion notifications back-to-back, and the
    // LLM would see a duplicate `<task_notification>` instead of
    // the single 'killed' message it expects.
    if (this.state.notified) return
    this.state.notified = true
    const content = formatCompletionMessage({
      workflowName: this.workflow.name,
      status: this.state.status,
      startedAt: this.state.startedAt ?? Date.now(),
      completedAt: this.state.completedAt ?? Date.now(),
      agents: this.state.agents.length,
      result: this.state.result,
      error: this.state.error?.message,
      reportPath: this.state.reportPath ?? '',
    })
    enqueuePendingNotification({
      value: content,
      mode: 'task-notification',
    })
  }

  stop(): void {
    this.abortController.abort()
    this.state.status = 'killed'
    this.state.completedAt = Date.now()
    // Push the completion notification from the synchronous stop
    // path too. Without this, the message was only emitted from
    // runWorkflowInVm's finally block — which only runs after the
    // script awaits reject on the aborted signal. If the script
    // happens to be in a synchronous stretch when stop() fires, or
    // if runWorkflowInVm was still spinning up, the LLM would
    // never see a `<task_notification>` and would have no way to
    // know the workflow was killed. The idempotent guard in
    // pushCompletionMessage makes it safe to call from both
    // paths.
    try {
      this.pushCompletionMessage()
    } catch {
      // best-effort; never block stop() on chat UX
    }
  }

  pause(): void {
    this.state.status = 'paused'
  }

  /**
   * Task interface compliance — delegates to stop() so the framework-level
   * kill pipeline (TaskType dispatch in src/Task.ts) still works.
   */
  async kill(_taskId: string): Promise<void> {
    this.stop()
  }

  /**
   * Wrap the parent-supplied spawner so that:
   *  1. Every call records a WorkflowAgentState entry in state.agents
   *     (UI display + later inspection).
   *  2. The Worker sees the bridge's SpawnResult shape (it expects
   *     { agentId, report }), so we re-emit whatever the parent's
   *     spawner returned.
   *
   * The parent spawner already encodes all the runAgent dependencies,
   * so this wrapper stays narrowly focused on bookkeeping and protocol
   * adaptation. The parent's abortController is shared with the task,
   * so a stop() during an in-flight subagent cascades naturally — the
   * spawner observes the abort and rejects, the wrapper records the
   * failure, and the error propagates back to the worker.
   */
  private buildSpawnSubagent(
    ctx: LocalWorkflowParentContext,
  ): (prompt: string, opts?: SpawnOpts) => Promise<SpawnResult> {
    return async (prompt, opts) => {
      const agent: WorkflowAgentState = {
        id: `wf_${Date.now()}-${this.state.agents.length}`,
        prompt,
        status: 'running',
        startedAt: Date.now(),
        // Copy UI metadata from opts so WorkflowDetailDialog can show
        // the label / phase / model without re-parsing the prompt or
        // reaching back to the bridge.
        //
        // `phase` falls back to the most recently announced stage
        // (state.currentPhase, set by `phase('...')` in the script) when
        // the script's `agent()` call doesn't pass `opts.phase` — the
        // linear stage ordering means the current stage is always the
        // one any nested agent call belongs to. Scripts that run agents
        // outside a `phase()` block (or before the first phase()) get
        // an undefined phase, which the dialog groups as
        // "(no phase)" alongside the declared phases.
        label: opts?.label,
        phase: opts?.phase ?? this.state.currentPhase,
        model: opts?.model,
      }
      this.state.agents.push(agent)
      // Bump the workflows slice so the dialog re-renders the new
      // agent row immediately (not just on spawner completion).
      this.bumpWorkflowsVersion(ctx)
      // Live progress: the real runAgent-backed spawner fires
      // onProgress as it streams assistant messages. We mirror the
      // running stats onto the agent state and re-render so the
      // /workflows panel shows ticking tokens/tools/model while
      // the agent is still running (otherwise the row shows
      // "unknown — tok · — tools" for the whole in-flight window).
      //
      // Throttle re-renders to ~every 250ms — setAppState on every
      // streamed message would be a lot of React work for a panel
      // that only updates at human-readable cadence.
      let scheduledRender: ReturnType<typeof setTimeout> | null = null
      const onProgress = (p: {
        tokensUsed?: number
        toolsUsed?: number
        toolCalls?: import('../../tools/WorkflowTool/types.ts').ToolCallRecord[]
        model?: string
      }) => {
        if (p.tokensUsed !== undefined) agent.tokensUsed = p.tokensUsed
        if (p.toolsUsed !== undefined) agent.toolsUsed = p.toolsUsed
        if (p.toolCalls !== undefined) agent.toolCalls = p.toolCalls
        // Only overwrite the model with a non-empty value (the
        // first assistant message always has a model; later
        // events may not).
        if (p.model) agent.model = p.model
        if (scheduledRender) return
        scheduledRender = setTimeout(() => {
          scheduledRender = null
          this.bumpWorkflowsVersion(ctx)
        }, 250)
      }
      try {
        const result = await ctx.spawner(prompt, { ...opts, onProgress })
        agent.status = 'completed'
        agent.completedAt = Date.now()
        agent.result = result.report
        // Propagate usage stats from the real runAgent-backed spawner.
        // The legacy no-op and other ad-hoc LocalSpawner implementations
        // don't provide these; the UI renders "—" when undefined.
        if (result.tokensUsed !== undefined) agent.tokensUsed = result.tokensUsed
        if (result.toolsUsed !== undefined) agent.toolsUsed = result.toolsUsed
        if (result.toolCalls !== undefined) agent.toolCalls = result.toolCalls
        // Propagate worktree isolation metadata from the real
        // runAgent-backed spawner so WorkflowDetailDialog can show
        // where the subagent ran (and whether its worktree was
        // auto-removed because the run produced no file changes).
        if (result.worktreePath !== undefined) agent.worktreePath = result.worktreePath
        if (result.isolationRemoved !== undefined) agent.isolationRemoved = result.isolationRemoved
        // Auto-inject the model the subagent actually used (captured
        // by the real runAgent-backed spawner from the streamed
        // assistant message). Overrides opts.model if both are set;
        // the spawned model is more accurate than the script-declared
        // one because the API may have routed to a different model
        // (e.g. via agentRouting).
        if (result.model !== undefined) agent.model = result.model
        // Final render: cancel any pending debounced render and
        // bump immediately so the panel reflects the post-spawner
        // authoritative counts (post-loop usage re-read, etc).
        if (scheduledRender) {
          clearTimeout(scheduledRender)
          scheduledRender = null
        }
        this.bumpWorkflowsVersion(ctx)
        return result
      } catch (err) {
        agent.status = 'failed'
        agent.completedAt = Date.now()
        agent.error = err instanceof Error ? err.message : String(err)
        if (scheduledRender) {
          clearTimeout(scheduledRender)
          scheduledRender = null
        }
        this.bumpWorkflowsVersion(ctx)
        throw err
      }
    }
  }

  /**
   * Build a WorkflowApi for a child workflow running inside
   * `workflow()`. Mirrors the parent's API surface so the child
   * can use the same globals (agent, parallel, pipeline, args,
   * budget, log, phase, timers) — but overrides `workflow` to a
   * hard error so a child that tries to call workflow() again
   * throws a clear "nesting is limited to one level" message.
   * (The runner's nestingDepth guard should already reject it
   * before reaching this function, but the in-child override is
   * defence in depth in case the runner is bypassed.)
   *
   * The parent task is reused: agent() still funnels through the
   * same buildSpawnSubagent (so child subagents appear in
   * state.agents alongside parent subagents), log/phase still
   * update the same UI surface, and the same abort controller
   * cascades. This keeps parent and child observable as one run
   * for the WorkflowDetailDialog.
   */
  private buildVmApiForChild(): WorkflowApi {
    return {
      agent: async (prompt: string, opts?: Record<string, unknown>) => {
        const result = await this.buildSpawnSubagent(this.parentContext!)(prompt, opts as SpawnOpts | undefined)
        return {
          ok: true as const,
          agentId: result.agentId,
          report: result.report,
          structuredOutput: result.structuredOutput,
        }
      },
      parallel: async <T,>(fns: Array<() => Promise<T>>): Promise<T[]> => {
        return (await Promise.all(fns.map((f) => f()))) as T[]
      },
      pipeline: async <T,>(stages: Array<() => Promise<T>>): Promise<T[]> => {
        const out: T[] = []
        for (const s of stages) out.push(await s())
        return out
      },
      workflow: async () => {
        throw new Error(
          'workflow() cannot be called from within a child workflow — ' +
          'nesting is limited to one level. Inline the inner script or call its agents directly.',
        )
      },
      args: this.state.args,
      budget: {
        total: this.state.budgetTotal ?? 0,
        spent: () => 0,
        remaining: () => this.state.budgetTotal ?? 0,
      },
      log: (...msgs: unknown[]) => {
        // Reuse the parent's log sink so child logs surface in the
        // same /errorlog feed.
        const line = msgs.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')
        logError(new Error(`[workflow] ${line}`))
      },
      phase: (title: string) => {
        this.state.currentPhase = String(title ?? '')
        if (this.parentContext) this.bumpWorkflowsVersion(this.parentContext)
      },
      setTimeout: ((...args: Parameters<typeof setTimeout>) =>
        setTimeout(...args)) as typeof setTimeout,
      clearTimeout: ((...args: Parameters<typeof clearTimeout>) =>
        clearTimeout(...args)) as typeof clearTimeout,
    }
  }

  /**
   * Force a re-render of any UI subscribed to `appState.workflows`
   * by replacing the slice with a shallow copy. Cheap (one object
   * allocation per call) and lets the WorkflowDetailDialog pick up
   * in-place mutations to `state.agents[i]` made by onProgress or
   * buildSpawnSubagent. Skipped silently if no setAppState is
   * available (tests / standalone callers).
   */
  private bumpWorkflowsVersion(ctx: LocalWorkflowParentContext): void {
    if (!ctx.setAppState) return
    ctx.setAppState((prev: unknown) => {
      const p = prev as { workflows?: Record<string, unknown> }
      if (!p.workflows) return prev
      return { ...p, workflows: { ...p.workflows } }
    })
  }

  /**
   * Plan6 Task 2: persist workflow metadata declared via
   * `__setMeta({...})` from inside a script. Mirrors the
   * `{ kind: 'meta', meta }` bridge handler from the legacy
   * worker path. The dialog uses state.meta.phases to render the
   * declared phase list (5 phases for `deep-research`, etc).
   *
   * The plan spec also asks for a `recordEvent` audit hook here,
   * but no such helper exists in this file (Plan5 did not land
   * one) and the `phase()` sibling writes directly to state +
   * bumps the version — we follow that pattern for consistency.
   */
  private setMeta(
    ctx: LocalWorkflowParentContext,
    meta: WorkflowPhaseMeta | ParsedWorkflowMeta,
  ): void {
    // Plan7 Task 4: `ParsedWorkflowMeta` (from the acorn parser) is a
    // structural superset of `WorkflowPhaseMeta` — same name/description/
    // phases keys, plus an optional `model` on each phase. The UI
    // (WorkflowDetailDialog) reads from `state.meta` typed as
    // `WorkflowPhaseMeta`, and the `model` field is ignored. So the
    // structural assignment is safe; the union here lets both the
    // runtime __setMeta path (WorkflowPhaseMeta) and the static acorn
    // path (ParsedWorkflowMeta) route through the same writer.
    this.state.meta = meta as WorkflowPhaseMeta
    this.bumpWorkflowsVersion(ctx)
  }
}

// ============== Completion message helpers ==============

type CompletionMessageInput = {
  workflowName: string
  status: LocalWorkflowTaskState['status']
  startedAt: number
  completedAt: number
  agents: number
  result?: string
  error?: string
  /**
   * Absolute path to the persisted per-agent report JSON written
   * by start()'s finally block. When empty (legacy / disk write
   * failed), the report line is omitted and the LLM has no way
   * to inspect per-agent details — graceful degradation only.
   */
  reportPath: string
}

const COMPLETION_RESULT_PREVIEW_LIMIT = 500

/**
 * Build the human-readable body of the completion system message.
 *
 * Layout:
 *   [Workflow `<name>` <verb> in <duration> · N agents]
 *   <blank>
 *   <preview or error or killed line>
 *   <blank>
 *   Report: <abs path>   (omitted if reportPath is empty)
 *
 * The verb depends on status (completed / failed / killed). The
 * preview is truncated at 500 chars to keep the chat scrollable.
 * The report path lets the LLM `Read` the on-disk JSON for full
 * per-agent details after /workflows evicts the run from
 * appState.workflows.
 */
export function formatCompletionMessage(input: CompletionMessageInput): string {
  const dur = formatDurationMs(input.completedAt - input.startedAt)
  const verb = statusVerb(input.status)
  const header = `[Workflow \`${input.workflowName}\` ${verb} in ${dur} · ${input.agents} agent${input.agents === 1 ? '' : 's'}]`
  // Always include the on-disk report path so the LLM can `Read`
  // it after the run evicts from /workflows. Empty path means the
  // disk write failed; omit the line instead of showing empty.
  const reportLine = input.reportPath
    ? `\n\nReport: ${input.reportPath}\n(Use Read tool to inspect per-agent details.)`
    : ''
  if (input.status === 'completed') {
    const preview = (input.result ?? '').trim()
    if (!preview) {
      return `${header}${reportLine}`
    }
    const truncated = preview.length > COMPLETION_RESULT_PREVIEW_LIMIT
      ? preview.slice(0, COMPLETION_RESULT_PREVIEW_LIMIT) + '\n…'
      : preview
    return `${header}\n\n${truncated}${reportLine}`
  }
  if (input.status === 'failed') {
    return `${header}\n\nError: ${input.error ?? '(unknown error)'}${reportLine}`
  }
  if (input.status === 'killed') {
    return `${header}\n\nKilled by user.${reportLine}`
  }
  // pending / running — shouldn't reach here in the finally block
  return header
}

function statusVerb(status: CompletionMessageInput['status']): string {
  switch (status) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'killed': return 'killed'
    case 'paused': return 'paused'
    default: return 'ended'
  }
}

function statusToLevel(status: CompletionMessageInput['status']): 'info' | 'warning' | 'error' {
  switch (status) {
    case 'completed': return 'info'
    case 'failed': return 'error'
    case 'killed': return 'warning'
    default: return 'info'
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 0) return '0s'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h ${remMin}m`
}
