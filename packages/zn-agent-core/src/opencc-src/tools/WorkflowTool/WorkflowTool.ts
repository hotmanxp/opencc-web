// src/tools/WorkflowTool/WorkflowTool.ts
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type React from 'react'
import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import type { LocalSpawner } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  resolveClaudeConfigHomeDir,
  resolveConfigDirEnv,
} from '../../utils/envUtils.js'
import { parseCliArgs } from './cliArgs.js'
import { getBundledSource } from './bundled/index.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { buildRealSpawner } from './realSpawner.js'
import { getWorkflowRegistry } from './singleton.js'
import { listWorkflowRuns } from './workflowRunStore.js'
import { registerWorkflowInAppState } from '../../tasks/LocalWorkflowTask/lifecycle.js'

/**
 * List all workflow runs in this session. Newest-first.
 * Exposed here so the /workflows slash command can call it.
 */
export const listRuns = listWorkflowRuns

// Re-export the real spawner builder for direct use in tests and for
// callers that want to wire the spawner into their own parent
// context (instead of relying on the WorkflowTool.call() default).
export { buildRealSpawner }

export const workflowInputSchema = z
  .object({
    workflowName: z
      .string()
      .optional()
      .describe(
        'Name of the workflow to run (e.g. "deep-research"). Mutually exclusive with scriptPath.',
      ),
    scriptPath: z
      .string()
      .optional()
      .describe(
        'Path to a workflow script file written earlier via Write/Edit. Mutually exclusive with workflowName.',
      ),
    // Port of upstream claude-code 2.1.185 WorkflowTool schema (binary
    // extract at .agent_working_dir/claude-raw/2.1.185/all-strings.txt:490384
    // — `args: E.unknown().optional().describe("Optional input value ...")`).
    // Replaces the older OpenCC union that restricted args to
    // string | string[] | Record<string, unknown> — that union rejected
    // legitimate values like null, booleans, numbers, array-of-objects,
    // and deeply-nested structures. Upstream accepts any JSON-serializable
    // value because the script's `args` global is passed verbatim, and the
    // script's downstream `args.filter` / `args.map` calls would crash on
    // a type the schema wrongly narrowed.
    //
    // OpenCC fork addendum (2026-06-22): when the LLM passes a raw CLI
    // string (e.g. `args: "--name=ethan --word=hello --verbose"`),
    // the runtime parses it into an object {name: 'ethan', word: 'hello',
    // verbose: true} before injecting into the script's `args` global
    // (see WorkflowTool.call() below). Scripts therefore read
    // `args.name` / `args.word` directly — no manual `args[0].split('=')`
    // boilerplate. Objects and arrays pass through unchanged so legacy
    // callers keep working.
    args: z
      .unknown()
      .optional()
      .describe(
        'Input value exposed to the script as the global `args`. ' +
        'For named workflows, prefer a raw CLI string — e.g. ' +
        '`args: "--name=ethan --word=hello --verbose"`. The runtime ' +
        'parses CLI-style strings into an object {name: "ethan", ' +
        'word: "hello", verbose: true} before injecting into the ' +
        'script. Use `--key=value` for string params and bare `--flag` ' +
        'for booleans. Pass an OBJECT directly only when the script ' +
        'needs a shape that CLI parsing cannot express (e.g. nested ' +
        'arrays). NEVER pass a JSON-stringified value — a stringified ' +
        'list breaks `args.filter`/`args.map` in the script. Use this ' +
        'to parameterize named workflows.',
      ),
    description: z
      .string()
      .optional()
      .describe('Optional: free-form task description if running an ad-hoc workflow'),
    // Plan12 Task 2: port of upstream's resumeFromRunId. Re-uses cached
    // agent results from a prior run; only new/edited calls re-run.
    // Caller MUST stop the prior run first.
    resumeFromRunId: z
      .string()
      .regex(
        /^wf_[a-z0-9-]{6,}$/,
        'Run ID must match ^wf_[a-z0-9-]{6,}$',
      )
      .optional()
      .describe(
        'Run ID of a prior Workflow invocation to resume from. Cached agent() calls with same (prompt, opts) return instantly; only edited/new calls re-run. Stop the prior run first before resuming.',
      ),
  })
  .refine(d => !(d.workflowName && d.scriptPath), {
    message: 'workflowName and scriptPath are mutually exclusive',
  })
  .refine(
    d => d.workflowName || d.scriptPath || d.resumeFromRunId,
    { message: 'Must provide workflowName, scriptPath, or resumeFromRunId' },
  )

/**
 * WorkflowTool — the LLM-facing entry point for running a dynamic workflow.
 *
 * When the LLM calls this tool:
 *  1. Look up the workflow by name (bundled, project, or user) via the registry.
 *  2. Read its source — bundled workflows ship their script inline, project/
 *     user workflows are .js files on disk.
 *  3. Create a `LocalWorkflowTask` and start it in a Worker thread.
 *  4. Return a `{ taskId }` result immediately so the LLM turn can continue.
 *
 * Progress is visible via the background-tasks dialog (`/tasks`) and the
 * workflow detail dialog. The final report is persisted on the task state
 * and surfaced to the user via the UI, matching how `run_in_background: true`
 * works for AgentTool.
 *
 * Note on the `as unknown as Tool` cast: the Tool interface declares
 * `call` as a strict async function returning `Promise<ToolResult<Output>>`,
 * but we need an async generator pattern to yield the taskId before the
 * worker finishes. The runtime shape satisfies the contract via duck-typing
 * (the `toolToAPISchema` caller only uses `.prompt()`, the runtime caller
 * only uses `Symbol.asyncIterator`). This pattern is used elsewhere in the
 * codebase.
 *
 * Note on the lazy `LocalWorkflowTask` / `logError` imports: pulling these
 * in at module top-level would transitively import `bootstrap/state.ts`,
 * which (via `Task.ts → diskOutput.ts → bootstrap/state.ts → settingsCache.ts`)
 * triggers a circular-import TDZ in the existing `settings.ts` ↔ `envUtils.ts`
 * cycle. Deferring the import to the call body keeps module-load clean
 * (the tool definition is just metadata until the LLM actually invokes it).
 */
const WORKFLOW_DESCRIPTION =
  'Run a dynamic workflow: a JavaScript script that orchestrates subagents at scale. ' +
  'Workflows run in the background — a ' +
  '<task-notification> arrives when the workflow completes. Use /workflows to watch live progress.\n\n' +
  'A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), ' +
  'to be confident (independent perspectives and adversarial checks before committing), or to take on scale ' +
  'one context can\'t hold (migrations, audits, broad sweeps). The script is where you encode that structure: ' +
  'what fans out, what verifies, what synthesizes.\n\n' +
  'ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can ' +
  'spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not ' +
  'have it inferred. Explicit opt-in means one of:\n' +
  '- The user included the keyword "ultracode" in their prompt (you\'ll see a system-reminder confirming it).\n' +
  '- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** below.\n' +
  '- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ' +
  '("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents").\n' +
  '- The user invoked a skill or slash command whose instructions tell you to call Workflow.\n' +
  '- The user asked you to run a specific named or saved workflow.\n\n' +
  'For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. ' +
  'Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could ' +
  'do and how much it would roughly cost, and ask the user whether to run it. ' +
  'Mention they can ask for one with "use a workflow" in a future message to skip the ask.\n\n' +
  'When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don\'t need to know the shape before the *task* \u2014 only before the *orchestration step*.\n\n' +
  'Common single-phase workflows you can chain across turns:\n' +
  '- **Understand** \u2014 parallel readers over relevant subsystems \u2192 structured map\n' +
  '- **Design** \u2014 judge panel of N independent approaches \u2192 scored synthesis\n' +
  '- **Review** \u2014 dimensions \u2192 find \u2192 adversarially verify (example below)\n' +
  '- **Research** \u2014 multi-modal sweep \u2192 deep-read \u2192 synthesize\n' +
  '- **Migrate** \u2014 discover sites \u2192 transform each (worktree isolation) \u2192 verify\n\n' +
  'For larger work, run several in sequence \u2014 read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.\n\n' +
  '**Ultracode.** When a system-reminder confirms ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce \u2014 token cost is not a constraint. For multi-phase work (understand \u2192 design \u2192 implement \u2192 review), that often means several workflows in sequence \u2014 one per phase \u2014 so you stay in the loop between them. The quality patterns below (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings \u2014 unless the work is trivial or already verified. Solo only on conversational turns or trivial mechanical edits. When a reminder says ultracode is off, revert to the opt-in rule above.\n\n' +
  // Task 4: verbatim script-syntax section from claude-code 2.1.177
  // (binary offset 210896464\u2013210902560; byte-exact extract in
  // .agent_working_dir/claude-code-files/workflow-desc-region.txt).
  // Placeholder resolutions (from upstream binary string table):
  //   ${TwO}\u2192""  ${qwO}\u2192""  ${KwO}\u2192"'worktree'"
  //   ${OwO}\u2192""  ${ZVH}\u2192"subagent"
  'Pass the script inline via `script` \u2014 do not Write it to a file first. Every invocation automatically persists its script to a file under the session directory and returns the path in the tool result. To iterate on a workflow, edit that file with Write/Edit and re-invoke Workflow with `{scriptPath: "<path>"}` instead of resending the full script.\n\n' +
  'Every script must begin with `export const meta = {...}`:\n' +
  '  export const meta = {\n' +
  '    name: \'find-flaky-tests\',\n' +
  '    description: \'Find flaky tests and propose fixes\',   // one-line, shown in permission dialog\n' +
  '    phases: [                                            // one entry per phase() call\n' +
  '      { title: \'Scan\', detail: \'grep test logs for retries\' },\n' +
  '      { title: \'Fix\', detail: \'one agent per flaky test\' },\n' +
  '    ],\n' +
  '  }\n' +
  '  // script body starts here \u2014 use agent()/parallel()/pipeline()/phase()/log()\n' +
  '  phase(\'Scan\')\n' +
  '  const flaky = await agent(\'grep CI logs for retry markers\', {schema: FLAKY_SCHEMA})\n' +
  '  ...\n\n' +
  'The `meta` object must be a PURE LITERAL \u2014 no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse` (shown in the workflow list), `phases`. Use the SAME phase titles in meta.phases as in phase() calls \u2014 titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model override.\n\n' +
  'Script body hooks:\n' +
  '- agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, isolation?: \'worktree\', agentType?: string}): Promise<any> \u2014 spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object \u2014 no parsing needed. Returns null if the user skips the agent mid-run or the subagent dies on a terminal API error after retries (filter with .filter(Boolean)). opts.label overrides the display label. opts.phase explicitly assigns this agent to a progress group (use this inside pipeline()/parallel() stages to avoid races on the global phase() state \u2014 same phase string \u2192 same group box). opts.model overrides the model for this agent call. Default to omitting it \u2014 the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you\'re highly confident a different tier fits the task; when unsure, omit. opts.isolation: \'worktree\' runs the agent in a fresh git worktree \u2014 EXPENSIVE (~200-500ms setup + disk per agent), use ONLY when agents mutate files in parallel and would otherwise conflict; the worktree is auto-removed if unchanged. opts.agentType uses a custom subagent type (e.g. \'Explore\', \'code-reviewer\') instead of the default workflow subagent \u2014 resolved from the same registry as the Agent tool; composes with schema (the custom agent\'s system prompt gets a StructuredOutput instruction appended).\n' +
  '- pipeline(items, stage1, stage2, ...): Promise<any[]> \u2014 run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) \u2014 use originalItem/index in later stages to label work without threading context through stage 1\'s return value. A stage that throws drops that item to `null` and skips its remaining stages.\n' +
  '- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> \u2014 run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to `null` in the result array \u2014 the call itself never rejects, so `.filter(Boolean)` before using the results. Use ONLY when you genuinely need all results together.\n' +
  '- log(message: string): void \u2014 emit a progress message to the user (shown as a narrator line above the progress tree)\n' +
  '- phase(title: string): void \u2014 start a new phase; subsequent agent() calls are grouped under this title in the progress display\n' +
  '- args: any — the value passed as Workflow\'s `args` input. For named workflows, prefer a raw CLI string — e.g. `args: "--name=ethan --word=hello --verbose"`. The runtime parses CLI-style strings into an object {name: "ethan", word: "hello", verbose: true} before injecting into the script (so the script reads `args.name` / `args.word` directly). Pass an object directly only when the script needs a shape that CLI parsing cannot express (e.g. nested arrays). Bare positional strings (e.g. `/deep-research "What is X?"`) are passed through as-is — the script handles them with `Array.isArray`/string checks. NEVER pass a JSON-stringified value — a stringified list breaks `args.filter`/`args.map` in the script. Use this to parameterize named workflows.\n' +
  '- budget: {total: number|null, spent(): number, remaining(): number} \u2014 the turn\'s token target from the user\'s "+500k"-style directive. `budget.total` is null if no target was set. `budget.spent()` returns output tokens spent this turn across the main loop and all workflows \u2014 the pool is shared, not per-workflow. `budget.remaining()` returns `max(0, total - spent())`, or `Infinity` if no target. The target is a HARD ceiling, not advisory: once `spent()` reaches `total`, further `agent()` calls throw. Use for dynamic loops: `while (budget.total && budget.remaining() > 50_000) { ... }`, or static scaling: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.\n' +
  '- workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any> \u2014 run another workflow inline as a sub-step and return whatever it returns. Pass a name to invoke a saved workflow (same registry as {name: "..."}), or {scriptPath} to run a script file you Wrote earlier. The child shares this run\'s concurrency cap, agent counter, abort signal, and token budget \u2014 its agents appear under a "subagent name" group in /workflows and its tokens count toward budget.spent(). The args param becomes the child\'s `args` global. Nesting is one level only: workflow() inside a child throws. Throws on unknown name / unreadable scriptPath / child syntax error; catch to handle gracefully.\n\n' +
  'Subagents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option \u2014 validation happens at the tool-call layer so the model retries on mismatch.\n\n' +
  'Workflow agents can reach all session-connected MCP tools via ToolSearch \u2014 schemas load on demand per agent. Caveat: interactively-authenticated MCP servers (e.g. claude.ai) may be absent in headless/cron runs.\n\n' +
  'Scripts are plain JavaScript, NOT TypeScript \u2014 type annotations (`: string[]`), interfaces, and generics fail to parse. The script body runs in an async context \u2014 use await directly. Standard JS built-ins (JSON, Math, Array, etc.) are available \u2014 EXCEPT `Date.now()`/`Math.random()`/argless `new Date()`, which throw (they would break resume); pass timestamps in via `args`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. No filesystem or Node.js API access.\n\n' +
  'DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.\n\n' +
  'A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:\n' +
  '- Dedup/merge across the full result set before expensive downstream work\n' +
  '- Early-exit if the total count is zero ("0 bugs found \u2192 skip verification entirely")\n' +
  '- Stage N\'s prompt references "the other findings" for comparison\n\n' +
  'A barrier is NOT justified by:\n' +
  '- "I need to flatten/map/filter first" \u2014 do it inside a pipeline stage: pipeline(items, stageA, r => transform([r]).flat(), stageB)\n' +
  '- "The stages are conceptually separate" \u2014 that\'s what pipeline() models. Separate stages \u2260 synchronized stages.\n' +
  '- "It\'s cleaner code" \u2014 barrier latency is real. If 5 finders run and the slowest takes 3\xD7 the fastest, a barrier wastes 2/3 of the fast finders\' idle time.\n\n' +
  'Smell test: if you wrote\n' +
  '  const a = await parallel(...)\n' +
  '  const b = transform(a)        // flatten, map, filter \u2014 no cross-item dependency\n' +
  '  const c = await parallel(b.map(...))\n' +
  'that middle transform doesn\'t need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.\n\n' +
  'Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow \u2014 excess calls queue and run as slots free up. You can still pass 100 items to parallel()/pipeline() and they all complete; only ~10 run at any moment. Total agent count across a workflow\'s lifetime is capped at 1000 \u2014 a runaway-loop backstop set far above any real workflow. A single parallel()/pipeline() call accepts at most 4096 items; passing more is an explicit error, not a silent truncation.\n\n' +
  'The canonical multi-stage pattern \u2014 pipeline by default, each dimension verifies as soon as its review completes:\n' +
  '  export const meta = {\n' +
  '    name: \'review-changes\',\n' +
  '    description: \'Review changed files across dimensions, verify each finding\',\n' +
  '    phases: [{ title: \'Review\' }, { title: \'Verify\' }],\n' +
  '  const DIMENSIONS = [{key: \'bugs\', prompt: \'...\'}, {key: \'perf\', prompt: \'...\'}]\n' +
  '  const results = await pipeline(\n' +
  '    DIMENSIONS,\n' +
  '    d => agent(d.prompt, {label: `review:${d.key}`, phase: \'Review\', schema: FINDINGS_SCHEMA}),\n' +
  '    review => parallel(review.findings.map(f => () =>\n' +
  '      agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: \'Verify\', schema: VERDICT_SCHEMA})\n' +
  '        .then(v => ({...f, verdict: v}))\n' +
  '  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)\n' +
  '  return { confirmed }\n' +
  '  // Dimension \'bugs\' findings verify while dimension \'perf\' is still reviewing. No wasted wall-clock.\n\n' +
  'When a barrier IS correct \u2014 dedup across all findings before expensive verification:\n' +
  '  const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))\n' +
  '  const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once\n' +
  '  const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))\n\n' +
  'Loop-until-count pattern \u2014 accumulate to a target:\n' +
  '  const bugs = []\n' +
  '  while (bugs.length < 10) {\n' +
  '    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})\n' +
  '    bugs.push(...result.bugs)\n' +
  '    log(`${bugs.length}/10 found`)\n' +
  '}\n\n' +
  'Loop-until-budget pattern \u2014 scale depth to the user\'s "+500k" directive. Guard on budget.total: with no target set, remaining() is Infinity and the loop would run straight to the 1000-agent cap.\n' +
  '  const bugs = []\n' +
  '  while (budget.total && budget.remaining() > 50_000) {\n' +
  '    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})\n' +
  '    bugs.push(...result.bugs)\n' +
  '    log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)\n' +
  '}\n\n' +
  'Composing patterns \u2014 exhaustive review (find \u2192 dedup vs seen \u2192 diverse-lens panel \u2192 loop-until-dry):\n' +
  '  const seen = new Set(), confirmed = []\n' +
  '  let dry = 0\n' +
  '  while (dry < 2) {                                              // loop-until-dry\n' +
  '    const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round\n' +
  '      agent(f.prompt, {phase: \'Find\', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)\n' +
  '    const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen \u2014 plain code, not an agent\n' +
  '    if (!fresh.length) { dry++; continue }\n' +
  '    dry = 0; fresh.forEach(b => seen.add(key(b)))\n' +
  '    const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...\n' +
  '      parallel([\'correctness\',\'security\',\'repro\'].map(lens => () =>   // ...each by 3 distinct lenses\n' +
  '        agent(`Judge "${b.desc}" via the ${lens} lens \u2014 real?`, {phase: \'Verify\', schema: VERDICT}))\n' +
  '        .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))\n' +
  '    confirmed.push(...judged.filter(v => v.real).map(v => v.b))\n' +
  '  }\n' +
  '  return confirmed\n' +
  '  // dedup vs `seen`, NOT `confirmed` \u2014 else judge-rejected findings reappear every round and it never converges.\n\n' +
  'Quality patterns \u2014 common shapes; pick by task and compose freely:\n' +
  '- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if \u2265majority refute. Prevents plausible-but-wrong findings from surviving.\n' +
  '    const votes = await parallel(Array.from({length: 3}, () => () =>\n' +
  '      agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, {schema: VERDICT})))\n' +
  '    const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2\n' +
  '- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters \u2014 diversity catches failure modes redundancy can\'t.\n' +
  '- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.\n' +
  '- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.\n' +
  '- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won\'t find everything.\n' +
  '- Completeness critic: a final agent that asks "what\'s missing \u2014 modality not run, claim unverified, source unread?" What it finds becomes the next round of work.\n' +
  '- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped \u2014 silent truncation reads as "covered everything" when it didn\'t.\n\n' +
  'Scale to what the user asked for. "find any bugs" \u2192 a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" \u2192 larger finder pool, 3\u20135 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.\n\n' +
  'These patterns aren\'t exhaustive \u2014 compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).\n\n' +
  'Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.\n\n' +
  '## Resume\n' +
  'The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) \u2014 the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args \u2192 100% cache hit. Date.now()/Math.random()/new Date() are unavailable in scripts (they would break this) \u2014 stamp results after the workflow returns, or pass timestamps via args. Fallback when no journal is available: Read agent-<id>.jsonl files in the transcript directory and hand-author a continuation script.'

export const WorkflowTool = {
  name: WORKFLOW_TOOL_NAME,
  inputSchema: workflowInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  // Required by the Tool interface: API schema uses prompt() (see
  // src/utils/api.ts:toolToAPISchema), UI uses description() for activity
  // display. Both signatures are required even when the copy is identical.
  async prompt(): Promise<string> {
    return WORKFLOW_DESCRIPTION
  },
  async description(): Promise<string> {
    return WORKFLOW_DESCRIPTION
  },
  userFacingName(): string {
    return 'Run Workflow'
  },

  // Required by the Tool interface — without this, the runtime throws
  // "renderToolUseMessage is not a function" when the LLM's tool_use
  // block is rendered in the conversation tree. Returns a one-line
  // description that fits alongside the workflow name in the chat UI.
  // See src/tools/McpAuthTool/McpAuthTool.ts:72 for the same pattern.
  renderToolUseMessage(input: {
    workflowName?: string
    scriptPath?: string
  }): React.ReactNode {
    if (input?.scriptPath) return `Run ad-hoc workflow: ${input.scriptPath}`
    const name = input?.workflowName
    return name ? `Run workflow: ${name}` : 'Run workflow'
  },

  // Required by the Tool interface (src/Tool.ts:517). The runtime
  // calls this before tool.call; if it's missing the tool never
  // executes and the workflow never reaches registerWorkflowInAppState
  // — which is why /workflows panel was empty for the user.
  //
  // Permission gating strategy for dynamic workflows:
  //   1. If the user previously answered `yes-always` for this
  //      workflowName, short-circuit to `allow` so the dialog never
  //      re-fires. The consent file lives in
  //      `~/.claude/workflow-consents.json` (see workflowConsent.ts).
  //   2. Otherwise, return `ask` with the WorkflowPermissionDialog
  //      prompt. The runtime permission system is responsible for
  //      rendering the dialog and calling `onPermissionAnswer` with
  //      the user's choice (`yes` / `yes-always` / `no`).
  //
  // We deliberately do NOT pre-analyze the script here — the dialog
  // itself reads from the bundled registry on demand, so a missing
  // or renamed workflow still surfaces the dialog (and the user can
  // cancel cleanly) instead of failing inside checkPermissions.
  async checkPermissions(input: {
    workflowName?: string
    scriptPath?: string
    args?: unknown
    description?: string
  }): Promise<
    | { behavior: 'allow'; updatedInput: typeof input }
    | { behavior: 'ask'; message: string; updatedInput?: typeof input }
  > {
    if (input.workflowName) {
      const { getWorkflowConsent } = await import('./workflowConsent.js')
      if (await getWorkflowConsent(input.workflowName)) {
        return { behavior: 'allow', updatedInput: input }
      }
    }
    // scriptPath invocations always prompt — ad-hoc scripts are
    // exactly the case where the user most wants to see the
    // WorkflowPermissionDialog (per-run, can't be pre-approved via
    // yes-always for a "name" that doesn't exist in the registry).
    return {
      behavior: 'ask',
      message: 'Run a dynamic workflow?',
      updatedInput: input,
    }
  },

  /**
   * Called by the runtime permission system after the user answers
   * the WorkflowPermissionDialog. Persists `yes-always` and `no`
   * decisions to disk so future calls of the same workflow can
   * short-circuit. `yes` (one-shot) is intentionally not persisted.
   *
   * Not part of the Tool interface — this is the hook the
   * WorkflowPermissionDialog hands its answer to. Wrapped on the
   * WorkflowTool plain object so callers don't need to import
   * workflowConsent.ts directly.
   */
  async onPermissionAnswer(
    input: { workflowName?: string },
    answer: 'yes' | 'yes-always' | 'no',
  ): Promise<void> {
    if (!input.workflowName) return
    const { setWorkflowConsent } = await import('./workflowConsent.js')
    if (answer === 'yes-always') {
      await setWorkflowConsent(input.workflowName, true)
    } else if (answer === 'no') {
      await setWorkflowConsent(input.workflowName, false)
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const msg =
      typeof output === 'object' && output !== null && 'message' in output
        ? String((output as { message: string }).message)
        : String(output ?? '')
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: msg,
    }
  },

  async call(
    {
      workflowName: inputWorkflowName,
      scriptPath,
      args,
      resumeFromRunId,
    }: z.infer<typeof workflowInputSchema>,
    toolUseCtx?: { abortController?: AbortController; setAppState?: (updater: (prev: unknown) => unknown) => void; [k: string]: unknown },
    _canUseTool?: unknown,
  ) {
    try {
      // Enforce the Zod refine() invariant defensively. The schema
      // declares workflowName and scriptPath as mutually exclusive, but
      // tests + internal callers bypass the schema parse and hand us
      // the raw object — so re-check here so the call() function and
      // the schema share a single source of truth.
      if (inputWorkflowName && scriptPath) {
        return {
          data: {
            message: 'workflowName and scriptPath are mutually exclusive — pass one or the other, not both.',
          },
        }
      }

      // Plan12 Task 2: resumeFromRunId. If the caller provided a prior
      // run's ID, refuse to resume if that run is still going (cache
      // would race against the in-flight worker). The full cache-driven
      // replay wiring is in Task 3 (workflowResumeStore + realSpawner);
      // this branch only handles the input-validation side and falls
      // through to the normal scriptPath/registry lookup so a future
      // task can re-use the prior script + args.
      if (resumeFromRunId) {
        // Lazy-load to avoid the pre-existing settings.ts ↔ envUtils.ts
        // circular TDZ.
        const { listWorkflowRuns } = await import('./workflowRunStore.js')
        const prior = listWorkflowRuns().find(r => r.id === resumeFromRunId)
        if (prior && prior.status === 'running') {
          return {
            data: {
              message: `Workflow ${resumeFromRunId} is still running. Stop it first before resuming.`,
            },
          }
        }
        // If we have a prior run with a non-empty workflowPath, fall
        // through using its path so the normal launcher re-reads the
        // script. (For bundled workflows workflowPath is '' — the
        // caller must re-supply workflowName in that case.)
        if (prior && prior.workflowPath && !scriptPath && !inputWorkflowName) {
          scriptPath = prior.workflowPath
        }
        // If a prior run was found, also carry forward its args when
        // the caller didn't supply fresh ones. `args` is `unknown` on
        // both sides after the 2026-06-22 widening (CLI string /
        // parsed object / legacy string[]), so a truthy check covers
        // all three shapes — previously this gated on
        // `prior.args.length > 0` which assumed the legacy string[].
        if (prior && prior.args != null && args === undefined) {
          args = prior.args
        }
      }

      // Plan4 Task 1 — scriptPath mode: when the LLM passes a path to a
      // workflow script on disk, run it directly without going through
      // the registry. This is the foundation for the iterative
      // "Write a workflow → run it → see results → tweak → re-run"
      // loop, where each iteration writes a new .js file to the same
      // path. The run is tagged with the synthetic name '<ad-hoc>' so
      // the /workflows panel can label it differently from named
      // workflows (e.g. "deep-research").
      //
      // Resolution order:
      //   1. scriptPath: read the file from disk, synthesize a Workflow
      //      object (name '<ad-hoc>', source 'project').
      //   2. workflowName: look up in the registry (bundled / project /
      //      user). Bundled workflows read from getBundledSource;
      //      project/user workflows read workflow.path.
      //   3. Neither: refuse with a clear message.
      let workflow: import('./types.js').Workflow
      let workflowName: string

      if (scriptPath) {
        let script: string
        try {
          script = readFileSync(scriptPath, 'utf-8')
        } catch (e) {
          return {
            data: {
              message: `Cannot read workflow source at ${scriptPath}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            },
          }
        }
        // Synthesize a Workflow object so the downstream
        // LocalWorkflowTask / scheduler / run-store pipeline doesn't
        // need a special case. We have to read the file twice (once
        // here for the early validation, again later via
        // workflow.path) — but readFileSync is cheap and the
        // duplication is cheaper than threading `script` through
        // every helper. The body of the file becomes the script we
        // hand to the worker; the `run` field is required by the
        // Workflow type but never invoked (see bundled/deepResearch.ts
        // for the same pattern).
        void script
        workflow = {
          name: '<ad-hoc>',
          source: 'project',
          path: scriptPath,
          run: async () => '',
        }
        workflowName = '<ad-hoc>'
      } else if (inputWorkflowName) {
        const registry = getWorkflowRegistry()
        const looked = await registry.get(inputWorkflowName)
        if (!looked) {
          return {
            data: {
              message: `Unknown workflow: ${inputWorkflowName}. Run /workflows to see available.`,
            },
          }
        }
        workflow = looked
        workflowName = inputWorkflowName
      } else {
        return {
          data: {
            message:
              'Either workflowName, scriptPath, or resumeFromRunId (with a prior scriptPath) is required.',
          },
        }
      }

      // For bundled workflows, source is held in the bundled registry.
      // For project/user workflows (and ad-hoc scriptPath), read the
      // .js file from disk. The script is captured into a local so
      // both this block and the task.start() call downstream see the
      // same string (and so we can return early on a missing bundle).
      let script: string
      if (workflow.source === 'bundled') {
        const src = getBundledSource(workflowName)
        if (!src) {
          return {
            data: {
              message: `Bundled workflow has no source: ${workflowName}`,
            },
          }
        }
        script = src
      } else {
        try {
          script = readFileSync(workflow.path, 'utf-8')
        } catch (e) {
          return {
            data: {
              message: `Cannot read workflow source at ${workflow.path}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            },
          }
        }
      }

      // Plan4 Task 2 — persist the script so the LLM can re-invoke
      // it via `{ scriptPath }` for iterative editing. When the
      // caller passed `scriptPath` directly, the on-disk file IS
      // the persisted path — just echo it back. When the caller
      // passed `workflowName`, the script came from either the
      // bundled registry or a project/user `.js` file; we write a
      // copy to the session's `workflows/` subdir so the LLM can
      // see a stable path it can read (and later re-run) without
      // re-resolving the registry.
      //
      // Placement: AFTER the disable check (a disabled call must
      // not write to disk) and BEFORE the task spawn (so the
      // persisted path is included in the result.data the LLM
      // sees). The `script` and `workflowName` locals are already
      // resolved by the earlier blocks — this block is the
      // single source of truth for the final `persistedPath`.
      //
      // Session id source: `CLAUDE_SESSION_ID` env var is not
      // currently set anywhere in OpenCC (verified via
      // `process.env.CLAUDE_SESSION_ID` grep), and importing
      // `getSessionId` from `bootstrap/state.ts` from this module
      // risks the same pre-existing settings ↔ envUtils TDZ the
      // rest of this file dodges. Falling back to `process.pid` is
      // stable for the lifetime of a single CLI run and matches
      // the "session-scoped dir per run" intent — different CLI
      // invocations get different subdirs, and re-invoking the
      // same script in the same session reuses the same dir.
      let persistedPath: string
      if (scriptPath) {
        // Caller already owns the file. Don't re-write — just
        // surface the path so the LLM gets a uniform `scriptPath`
        // field on the result regardless of invocation mode.
        persistedPath = scriptPath
      } else {
        const sessionId = process.env.CLAUDE_SESSION_ID ?? String(process.pid)
        // Resolve the config dir inline rather than calling the
        // lodash-memoized `getClaudeConfigHomeDir()`. That memoize cache
        // captures the resolved dir keyed on the env vars at first call,
        // so any process-local `process.env.CLAUDE_CONFIG_DIR` or
        // `OPENCC_CONFIG_DIR` mutation done after the first call (notably
        // from test setup `beforeEach` blocks in the shared bun test
        // process) silently observes a stale `~/.claude` / `~/.opencc`
        // value and the workflow script lands under the wrong dir. The
        // exported pure functions below re-derive the value on every
        // invocation; cheap (just `existsSync` for the legacy-default
        // resolution branch) and correct.
        const configHomeDir = resolveClaudeConfigHomeDir({
          configDirEnv: resolveConfigDirEnv({
            openccConfigDir: process.env.OPENCC_CONFIG_DIR,
            legacyConfigDir: process.env.CLAUDE_CONFIG_DIR,
          }),
        })
        const sessionDir = join(
          configHomeDir,
          'sessions',
          sessionId,
          'workflows',
        )
        mkdirSync(sessionDir, { recursive: true })
        persistedPath = join(
          sessionDir,
          `${workflowName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.js`,
        )
        writeFileSync(persistedPath, script)
      }

      // Build a parent context. The real spawnSubagent() wiring
      // (calling runAgent() with the parent's toolUseContext / canUseTool)
      // is supplied by the parent caller via `toolUseCtx.callAgent` when
      // it knows the agent pipeline shape. When no override is present
      // (e.g. tests, or any caller that didn't bother wiring
      // toolUseCtx.callAgent), we fall back to a real LLM-backed
      // spawner that captures toolUseCtx + canUseTool itself and runs
      // each subagent prompt through runAgent() — so a workflow that
      // calls spawnSubagent() in production never gets a "pending"
      // agentId or a prompt-as-report from the fallback path.
      //
      // The real spawner is built AFTER the LocalWorkflowTask is
      // constructed (via setParentContext) so it can use `task.id` as
      // the transcriptSubdir — that groups each subagent's transcript
      // under subagents/workflows/<runId>/ for easier debugging.
      const overrideSpawner = (toolUseCtx as unknown as {
        callAgent?: LocalSpawner
      })?.callAgent

      // Lazy-import LocalWorkflowTask + logError here (not at module top
      // level) to avoid the pre-existing circular-import TDZ. See the
      // module-level comment above.
      const [{ LocalWorkflowTask }, { logError }] = await Promise.all([
        import('../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'),
        import('../../utils/log.js'),
      ])

      // Create background task without parentContext — we inject it
      // below after we've built the spawner (which needs task.id).
      //
      // If the LLM passed `args` as a raw CLI string, parse it into an
            // object here so the worker script's `args` global is a plain
            // object the script can read as `args.name`, `args.word`, etc.
            // Object/array inputs pass through unchanged (legacy callers
            // and ad-hoc scripts that read `args[0]`/`args[1]` keep working).
            // Primitives (number, boolean, null) also pass through unchanged.
            //
            // IMPORTANT — only parse strings that actually look like CLI
            // input (contain a `--` flag). A bare positional string like
            // `"What is X?"` (e.g. `/deep-research What is X?` legacy
            // path) MUST pass through verbatim — parseCliArgs would return
            // `{}` and silently destroy the original question. The real
            // TUI verification (2026-06-22) caught this regression before
            // merge; without the lookahead below, scripts like
            // bundled/deepResearch.ts that expect a raw positional string
            // would receive `args = {}` instead of `args = "What is X?"`.
            const parsedArgs =
              typeof args === 'string' && /(?:^|\s)--\w/.test(args)
                ? parseCliArgs(args)
                : args
      const task = new LocalWorkflowTask({
        workflow,
        argsJson: parsedArgs,
      })

      const realSpawner: LocalSpawner = overrideSpawner
        ? (async () => ({ agentId: 'unreachable', report: '' })) as LocalSpawner
        : await buildRealSpawner(
            (toolUseCtx ?? {}) as { callAgent?: LocalSpawner; options?: Record<string, unknown> } & Record<string, unknown>,
            _canUseTool,
            task.id,
          )
      const spawner: LocalSpawner = (overrideSpawner ?? realSpawner) as LocalSpawner

      task.setParentContext({
        spawner,
        abortController: toolUseCtx?.abortController ?? new AbortController(),
        // Pass the app-state setter so LocalWorkflowTask can
        // trigger re-renders of the /workflows dialog on live
        // subagent progress. Best-effort and degrades to a no-op
        // if the caller didn't wire a setAppState (e.g. tests).
        setAppState: (toolUseCtx as unknown as {
          setAppState?: (updater: (prev: unknown) => unknown) => void
        })?.setAppState,
      })

      // Start the task. The task wraps its own start() promise — we
      // attach a .catch() to log unexpected errors (the task itself
      // records state.error for callers to inspect).
      task.start(script).catch(e => logError(e))

      // Register the task in appState.workflows so the /workflows panel
      // can find it. Without this, the task runs invisibly — the user
      // only sees the LLM's tool_result, not the progress UI. The runtime
      // at toolExecution.ts:1294 spreads `toolUseContext` into the second
      // arg, so setAppState is in scope. We use the dedicated
      // `appState.workflows` slice (separate from `appState.tasks` so the
      // /workflows and /tasks panels don't fight over the same data).
      const setAppState = (toolUseCtx as unknown as {
        setAppState?: (f: (prev: any) => any) => void
      })?.setAppState
      if (setAppState) {
        // Static import — eliminates the async gap that let `task.start()`
        // (fire-and-forget at line 710) flip `task.state.status` to
        // 'completed' before registerWorkflowInAppState wrote the slice.
        // See memory/team/feedback/feedback_workflow_monitor_no_agent_info.md
        // Round 9 for the root-cause analysis. lifecycle.ts has no circular
        // dependency on Task.ts (only imports `SetAppState` type + framework
        // `registerTask`), so the previous lazy import's justification
        // ("avoid loading Task.ts eagerly") doesn't apply.
        const unregister = registerWorkflowInAppState(task, setAppState)
        // Poll task.state.status every 1s. When the task reaches a
        // terminal state (completed/failed/killed), keep the row visible
        // for KEEPALIVE_MS so the user can see the result before it
        // disappears from the /workflows panel. The status stays in its
        // terminal value (e.g. 'completed' / 'failed') during this
        // window so the panel can render it with the right icon.
        // Safety stop after 1h in case the task hangs.
        const KEEPALIVE_MS = 5_000
        const startedAt = Date.now()
        const pollHandle = setInterval(() => {
          const status = task.state.status
          const isTerminal =
            status === 'completed' || status === 'failed' || status === 'killed'
          if (isTerminal) {
            const sinceTerminal = Date.now() - (task.state.completedAt ?? startedAt)
            if (sinceTerminal >= KEEPALIVE_MS) {
              clearInterval(pollHandle)
              unregister()
            }
          } else if (Date.now() - startedAt > 60 * 60 * 1000) {
            clearInterval(pollHandle)
          }
        }, 1000)
      }

      // Return Promise<ToolResult<Output>>. The Tool interface declares
      // call() as `async (...args) => Promise<ToolResult>`, and the
      // runtime at src/services/tools/toolExecution.ts:1294 does
      // `await tool.call(...)` then reads `result.data`. An async-
      // generator signature would have caused `await` to resolve to
      // the AsyncGenerator object itself, leaving result.data
      // undefined and the LLM receiving an empty tool_result block
      // (the original "功能似乎不行" bug). The shape here matches
      // mapToolResultToToolResultBlockParam above, which extracts
      // .message from an object payload.
      //
      // CRITICAL: `taskId` is the Run ID the user/WorkflowTool
      // exchange depends on. `mapToolResultToToolResultBlockParam`
      // (line 119-130) only forwards `output.message` to the LLM,
      // so we must inline the taskId into the message — otherwise
      // the LLM's tool result wouldn't carry the Run ID and the
      // user's LLM would have no way to surface it. (The LLM saw
      // "Run ID wasn't returned in the start result" before this
      // fix because the `data` object was silently dropped.)
      const runId = task.id
      const message =
        `Workflow ${workflowName} started (Run ID: ${runId}). ` +
        `Run /workflows to see progress; completion will arrive as ` +
        `a system task-notification.`
      return {
        data: {
          taskId: runId,
          workflowName,
          // Plan4 Task 2: surface the persisted script path so the
          // LLM can re-invoke the same workflow with `{ scriptPath }`
          // for iterative editing (Read → Edit → re-run). For
          // `scriptPath` invocations, this is the input path
          // verbatim (see the persistence block above).
          scriptPath: persistedPath,
          status: 'running',
          message,
        },
      }
    } catch (e) {
      return {
        data: {
          message: e instanceof Error ? e.message : String(e),
        },
      }
    }
  },
} as unknown as Tool
