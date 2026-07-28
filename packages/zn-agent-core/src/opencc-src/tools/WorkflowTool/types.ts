// src/tools/WorkflowTool/types.ts
import type { UUID } from 'crypto'
import { z } from 'zod/v4'

/**
 * Status of a single workflow run.
 */
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'

/** Status of a single subagent run spawned by a workflow. */
export type SubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

/** A workflow defined in a .js file or registered programmatically. */
export type Workflow = {
  name: string
  description?: string
  /**
   * Optional upstream-style `whenToUse` string — short usage hint
   * shown next to the workflow in the slash-command autocomplete and
   * surfaced through `createWorkflowCommand`. Matches upstream
   * `QEK`/`whenToUse` field on `Workflow`.
   */
  whenToUse?: string
  /**
   * Optional verbatim script source. Used by
   * `createWorkflowCommand` to set `contentLength: H.script.length`
   * on the resulting slash command, matching upstream behavior.
   * Bundled workflows (e.g. deepResearch) pass the script here.
   */
  script?: string
  /**
   * True when the workflow author wrote a custom `description` (vs
   * the registry using a default fallback). Surfaced through
   * `createWorkflowCommand` as `hasUserSpecifiedDescription:!0` so
   * downstream consumers can tell user-written from auto-generated.
   */
  hasUserSpecifiedDescription?: boolean
  /**
   * Upstream `loadedFrom` discriminator — `'bundled' | 'plugin' |
   * 'skills'`. Distinct from `source` (which is the OpenCC fork's
   * `'project' | 'user' | 'bundled' | 'plugin'`); `loadedFrom`
   * captures *how* the command was loaded into the slash-command
   * table, `source` captures *where the script lives on disk*.
   */
  loadedFrom?: 'bundled' | 'plugin' | 'skills'
  /**
   * Upstream plugin provenance (top-level fields, NOT nested under
   * `pluginInfo`): when `source === 'plugin'`, the manifest and
   * repository URL of the plugin that contributed the workflow.
   * Forwarded through `createWorkflowCommand` as
   * `pluginInfo: { pluginManifest: H.pluginManifest, repository: H.plugin }`.
   * Upstream's binary reads them as `H.pluginManifest` and `H.plugin`
   * directly on the Workflow, not nested.
   *
   * Intentionally typed as `unknown` (not a stricter manifest shape):
   * upstream's manifest schema is plugin-defined and varies, so we
   * preserve full fidelity through `createWorkflowCommand` rather than
   * narrow it. Tighten with care — would reject manifests with extra
   * fields that today's `unknown` accepts.
   */
  pluginManifest?: unknown
  plugin?: string
  source: 'project' | 'user' | 'bundled' | 'plugin'
  path: string
  run: (args: string[]) => Promise<string>
}

/** Options passed to spawnSubagent() from inside a workflow script. */
export type SpawnOpts = {
  model?: string
  tools?: string[]
  signal?: AbortSignal
  /**
   * Optional agent registry key (e.g. 'tui-func-verifier', 'Explore',
   * 'general-purpose'). When set, the main-process spawnSubagent handler
   * is expected to route to that registered agent instead of calling the
   * LLM directly with the schema prompt. Forwarded through the
   * WorkerOutbound protocol; the runtime transport is the only thing this
   * type currently expresses — actual registry lookup is a follow-up.
   */
  agentType?: string
  /**
   * Optional UI label. Display-only — doesn't affect dispatch. The
   * `agent()` wrapper forwards this onto the WorkflowAgentState entry so
   * the WorkflowDetailDialog can show short readable names (e.g.
   * "finder F1: Error handling 黑洞") instead of the first ~80 chars of
   * the prompt.
   */
  label?: string
  /**
   * Optional phase tag. Set by the script via `phase('Title')` and
   * forwarded through `agent({ phase: 'Title', ... })`. The LocalWorkflow
   * Task records the phase on each WorkflowAgentState entry so the dialog
   * can group agents by phase and show "Discovery: 6 lens 扫描 · 6
   * agents" headings.
   */
  phase?: string
  /**
   * Optional live progress callback. Invoked by the real runAgent-backed
   * spawner each time a streamed message or tool_use block is processed,
   * so the caller can update its own state store for live UI rendering
   * (e.g. ticking up the tokens counter while the agent is still
   * running, instead of waiting for the final SpawnResult).
   *
   * The legacy no-op and stub spawners never call this callback, so
   * callers that depend on it for UX should fall back to the final
   * SpawnResult fields if no progress arrives.
   *
   * The spawner may fire onProgress many times per run (once per
   * assistant message); callers should debounce expensive re-renders.
   */
  onProgress?: (progress: {
    tokensUsed?: number
    toolsUsed?: number
    toolCalls?: ToolCallRecord[]
    model?: string
  }) => void
  /**
   * Optional JSON Schema (as a plain object) describing the structured
   * output the caller wants from the subagent. When set, the real
   * runAgent-backed spawner binds a StructuredOutputTool that validates
   * the subagent's final payload against this schema, and the result is
   * surfaced via SpawnResult.structuredOutput. Schema and isolation
   * travel together: isolation governs the worktree the schema-validated
   * output is produced in.
   */
  schema?: Record<string, unknown>
  /**
   * Optional isolation mode for the subagent run. Reserved string-typed
   * value so future transports (e.g. 'worktree', 'container') can be
   * added without breaking changes. The current real spawner ignores it
   * — only `schema` is wired end-to-end today.
   */
  isolation?: 'worktree' | string
}

/** A single tool_use invocation captured during a subagent run. */
export type ToolCallRecord = {
  /** Tool name (e.g. "Read", "Bash", "Grep", "codegraph_search"). */
  name: string
  /**
   * Brief one-line summary of the tool's input (e.g. file path for
   * Read, command for Bash, pattern for Grep). Computed by the
   * real spawner from the tool_use block's `input` field; the
   * heuristic picks the most useful field per known tool.
   */
  inputSummary: string
  /** ISO-ish timestamp from when the tool_use block was yielded
   *  (Date.now() in the main process). Used for ordering only. */
  at: number
}

/** Result of spawnSubagent() — final report from the subagent. */
export type SpawnResult = {
  agentId: string
  report: string
  /**
   * Optional cumulative API token usage for the subagent run. The
   * real runAgent-backed spawner extracts this from the streamed
   * messages' `usage` field (sum of input_tokens + output_tokens
   * across assistant turns). The legacy no-op and any caller that
   * doesn't pass through real LLM output leaves this undefined,
   * which the UI renders as "—".
   */
  tokensUsed?: number
  /**
   * Optional count of tool_use blocks the subagent emitted. The
   * real spawner counts these across all assistant messages in the
   * stream. Used by the /workflows panel to show "X tools" next
   * to each subagent row.
   */
  toolsUsed?: number
  /**
   * Optional ordered list of tool_use invocations the subagent
   * made. The real spawner captures these as they're yielded;
   * capped at 50 entries to keep memory bounded for agents that
   * fan out heavily (e.g. opencc-bug-hunt finders running codegraph
   * + Read + Glob for hours). UI shows the most recent 3 by default
   * with a "+N more" indicator.
   */
  toolCalls?: ToolCallRecord[]
  /**
   * Model the subagent actually used (e.g. "MiniMax-M3",
   * "claude-3-5-sonnet-..."). The real runAgent-backed spawner
   * captures this from the assistant message's `model` field, so
   * the workflow script doesn't have to pass it explicitly. The
   * /workflows panel surfaces it in the per-agent row and detail
   * pane. Leave undefined for callers that don't track model
   * (the legacy no-op).
   */
  model?: string
  /**
   * Optional validated structured output, populated only when the
   * caller invoked `agent({ schema })`. The real runAgent-backed
   * spawner injects a bound StructuredOutputTool into the subagent's
   * tool pool, captures whatever the subagent passed to it, and
   * validates the data against the bound JSON Schema.
   *
   *   - On success: the raw validated value (already validated by the
   *     bound StructuredOutputTool when subagent called it).
   *   - On subagent never calling StructuredOutput: `{ok:false, error: '...'}`.
   *   - On validation failure: `{ok:false, error: '...'}` envelope (defense-in-depth re-validation in realSpawner post-loop).
   *
   * Undefined for non-schema callers (backward compat with all
   * existing agent() invocations that don't pass a schema).
   */
  structuredOutput?: unknown
  /**
   * Optional path to the git worktree the subagent ran in, populated
   * only when the caller invoked `agent({ isolation: 'worktree' })`.
   * The real runAgent-backed spawner wraps the subagent run in
   * `withWorktreeIsolation({ ... })`; if the worktree was unchanged
   * after the run, it's auto-removed (see `isolationRemoved`) and
   * this path no longer exists on disk.
   */
  worktreePath?: string
  /**
   * True if the worktree was auto-removed because the subagent
   * produced no file changes. Populated alongside `worktreePath`
   * when `isolation: 'worktree'` is set. False (or undefined) means
   * the worktree is still on disk for inspection / merge.
   */
  isolationRemoved?: boolean
}

/** Function injected into the Worker as `spawnSubagent` global. */
export type SpawnSubagentFn = (
  prompt: string,
  opts?: SpawnOpts,
) => Promise<SpawnResult>

/** A single subagent's run state. */
export type SubagentRun = {
  id: string
  prompt: string
  status: SubagentStatus
  startedAt?: number
  finishedAt?: number
  report?: string
  error?: string
}

/** Full run state — kept in main process. */
export type WorkflowRun = {
  id: string
  workflowName: string
  source: 'project' | 'user' | 'bundled'
  workflowPath: string
  // OpenCC fork (2026-06-22): widened from `string[]` to `unknown`.
  // Workflows now accept the full args space the schema allows (raw CLI
  // string → parsed object, pre-parsed object, or array of positional
  // strings for scripts that read `args[0]`/`args[1]`). The script's
  // `args` global is already `unknown` at the VM boundary; state-side
  // alignment keeps the type system honest end-to-end.
  args: unknown
  status: WorkflowRunStatus
  startedAt: number
  finishedAt?: number
  subagentRuns: SubagentRun[]
  finalReport?: string
  error?: { message: string; stack?: string }
  totalCostUsd: number
}

/** Worker ↔ main process message protocol. */
export type WorkerInbound =
  | { kind: 'init'; args: string[]; runId: string; budgetTotal: number }
  | { kind: 'cancel' }
  | {
      kind: 'spawnSubagentResult'
      callId: string
      agentId?: string
      report?: string
      error?: string
      structuredOutput?: unknown
    }
  | {
      /**
       * Reply to a `kind: 'workflow'` request from the wrapper. Resolves
       * (or rejects) the pending `workflow()` Promise in the worker.
       * `result` is whatever the child script returned (string or JSON-
       * serializable object). `error` is set on failure.
       */
      kind: 'workflowResult'
      callId: number
      result?: unknown
      error?: string
    }

/** Metadata declared via `__setMeta({...})` from inside a workflow script. */
export type WorkflowPhaseMeta = {
  name?: string
  description?: string
  /**
   * Phase list declared by the workflow via __setMeta. `detail` is an
   * optional human-readable one-liner (e.g. for the PermissionDialog
   * tooltip and the WorkflowDetailDialog phase header). It is only
   * required for bundled workflows like deep-research; legacy
   * user/project scripts that just declare `{ title }` keep working.
   */
  phases?: { title: string; detail?: string; model?: string }[]
}

export type WorkerOutbound =
  | { kind: 'spawnSubagent'; callId: string; prompt: string; opts?: SpawnOpts }
  | { kind: 'report'; value: string }
  | { kind: 'error'; message: string; stack?: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'phase'; title: string }
  | { kind: 'meta'; meta: WorkflowPhaseMeta }
  | {
      /**
       * A script called `workflow(nameOrRef, args)`. The bridge should
       * resolve the workflow (by name or by reading the scriptPath),
       * execute the child script in a fresh worker, and post back a
       * `kind: 'workflowResult'` message with the same callId. Refs
       * are normalized to a wire-friendly shape because functions over
       * the worker boundary must be reduced to message passing.
       */
      kind: 'workflow'
      callId: number
      ref: { kind: 'name'; value: string } | { kind: 'scriptPath'; value: string }
      args?: unknown
    }

/** Zod schema for SpawnOpts (runtime validation in spawnSubagent). */
export const SpawnOptsSchema = z.object({
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  signal: z.instanceof(AbortSignal).optional(),
  label: z.string().optional(),
  phase: z.string().optional(),
  agentType: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  isolation: z.string().optional(),
})



/** State of a single spawned subagent within a workflow run (UI-friendly). */
export type WorkflowAgentState = {
  id: string
  prompt: string
  /** Optional human-readable label (e.g. "finder F1: Error handling")
   *  — copied from SpawnOpts.label. */
  label?: string
  /** Optional phase tag (e.g. "Discovery: 6 lens 扫描") — copied from
   *  SpawnOpts.phase. WorkflowDetailDialog groups agents by this. */
  phase?: string
  /** Optional model name used (e.g. "MiniMax-M3") — surfaced in the
   *  dialog's per-agent line. */
  model?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  startedAt?: number
  completedAt?: number
  result?: string
  error?: string
  /**
   * Cumulative API tokens used by the subagent run. Populated by
   * LocalWorkflowTask.buildSpawnSubagent from the spawner's
   * SpawnResult.tokensUsed. UI shows "—" if undefined.
   */
  tokensUsed?: number
  /**
   * Number of tool_use blocks the subagent emitted. Populated by
   * LocalWorkflowTask.buildSpawnSubagent from the spawner's
   * SpawnResult.toolsUsed. UI shows "—" if undefined.
   */
  toolsUsed?: number
  /**
   * Ordered list of tool_use invocations the subagent made.
   * Populated by LocalWorkflowTask.buildSpawnSubagent from the
   * spawner's SpawnResult.toolCalls. Capped at 50 entries by the
   * real spawner. Drives the "Activity" section in the per-agent
   * detail pane.
   */
  toolCalls?: ToolCallRecord[]
  /**
   * Path to the git worktree the subagent ran in, populated only
   * when the caller invoked `agent({ isolation: 'worktree' })` and
   * the real runAgent-backed spawner wrapped the run in
   * withWorktreeIsolation. Surfaced in the per-agent detail pane
   * so the user knows where to look for the subagent's work.
   */
  worktreePath?: string
  /**
   * True if the worktree was auto-removed because the subagent
   * produced no file changes. Paired with `worktreePath`; the UI
   * appends "(cleaned up)" vs "(kept)" to make the distinction
   * obvious at a glance.
   */
  isolationRemoved?: boolean
}
