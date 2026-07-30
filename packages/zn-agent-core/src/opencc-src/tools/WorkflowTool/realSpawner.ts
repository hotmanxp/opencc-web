// src/tools/WorkflowTool/realSpawner.ts
//
// Build a real LLM-backed LocalSpawner that captures the parent's
// toolUseContext / canUseTool and routes each subagent prompt through
// the AgentTool.runAgent() pipeline. Replaces the legacy no-op
// fallback (which used to return the prompt as the report — see
// opencc-workflowtool-noop-spawner-task6-deferred.md).
//
// Extracted from WorkflowTool.ts so the wiring can be unit-tested
// without running a real Worker thread.

import type { LocalSpawner } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { ToolCallRecord } from './types.js'

// Loose shape of `runAgent` (it's @ts-nocheck so we re-declare the
// surface we use). Lets us pass `toolUseContext` / `canUseTool` etc.
// without dragging in the full generic toolUseContext inference.
export type RunAgentFn = (opts: {
  agentDefinition: { agentType: string; [k: string]: unknown }
  promptMessages: unknown[]
  toolUseContext: unknown
  canUseTool: unknown
  isAsync: boolean
  querySource: unknown
  model?: unknown
  transcriptSubdir?: string
  /**
   * Required by runAgent (it destructures this and crashes with
   * `Cannot read properties of undefined (reading 'filter')` if
   * missing). Real spawner MUST pass the parent's tool pool here
   * (or an empty array). The regression test in realSpawner.test.ts
   * pins this contract.
   */
  availableTools: unknown[]
}) => AsyncGenerator<unknown, void>

export type CreateUserMessageFn = (args: { content: string }) => unknown

export type RealSpawnerDeps = {
  runAgent: RunAgentFn | null
  createUserMessage: CreateUserMessageFn | null
}

import { findFirstBalancedJsonValue } from '../StructuredOutputTool/textJsonExtractor.js'

// Re-export so existing callers of
// `import { findFirstBalancedJsonValue } from './realSpawner.js'` keep
// working without a second import path.
export { findFirstBalancedJsonValue }

/**
 * Build a real LLM-backed LocalSpawner.
 *
 * Each invocation:
 *   1. Generates a stable `agentId` (timestamp + random) so the
 *      /workflows panel can show per-subagent rows.
 *   2. Resolves the `AgentDefinition` from the parent's
 *      `toolUseContext.options.agentDefinitions.allAgents` based on
 *      `opts.agentType` (default: 'general-purpose'). If no match is
 *      found, returns an error report rather than the legacy no-op
 *      (which used to return the prompt as the report, breaking every
 *      workflow that parses JSON out of the subagent response).
 *   3. Calls `runAgent()` with the parent's `toolUseContext` /
 *      `canUseTool` so permission mode, model routing, and tool
 *      restrictions all cascade from the parent. The default
 *      `querySource: 'workflow_subagent'` keeps analytics clean.
 *   4. Streams the response, collecting the final assistant text into
 *      a `report` string. Returns an error report on hard-fail — the
 *      bridge's spawnSubagent wrapper records the failure in
 *      `state.agents`.
 *
 * The `runAgent` and `createUserMessage` imports are lazy (inside
 * `loadDefaultDeps`) to avoid the pre-existing `settings.ts ↔
 * envUtils.ts` circular TDZ. Type-erased with `as unknown as` casts
 * because the runAgent and messages modules are themselves
 * `@ts-nocheck`.
 *
 * The `deps` parameter is for test injection. In production it's
 * `undefined` and the function lazy-loads the real modules; in tests
 * it can be a stub or a mocked async generator so we can assert
 * behavior without spinning up a Worker or hitting the LLM.
 */
export async function buildRealSpawner(
  toolUseCtx: { callAgent?: LocalSpawner; options?: Record<string, unknown> } & Record<string, unknown>,
  canUseTool: unknown,
  taskId: string,
  deps: RealSpawnerDeps | undefined = undefined,
): Promise<LocalSpawner> {
  const { runAgent, createUserMessage } = deps ?? (await loadDefaultDeps())

  return async (prompt, opts) => {
    const agentId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Plan12 Task 3: auto-replay for resumeFromRunId. When the caller
    // passed `resumeRunId` (a string set by the wrapper before the
    // spawner is invoked), check the resume cache first; if we have
    // a result for this exact (prompt, opts) tuple, return it
    // instantly instead of running another LLM call.
    if (opts && typeof opts === 'object' && 'resumeRunId' in opts) {
      const resumeRunId = (opts as { resumeRunId?: unknown }).resumeRunId
      if (typeof resumeRunId === 'string' && resumeRunId.length > 0) {
        try {
          const { getCachedAgentResult } = await import(
            './workflowResumeStore.js'
          )
          const cached = getCachedAgentResult(resumeRunId, { prompt, opts })
          if (cached !== undefined) {
            const c = cached as { report?: string; agentId?: string }
            return {
              agentId: c.agentId ?? `cached-${Date.now()}`,
              report: String(c.report ?? ''),
              tokensUsed: 0,
              toolsUsed: 0,
              toolCalls: [],
              model: undefined,
            }
          }
        } catch {
          // Cache lookup is best-effort; fall through to real runAgent.
        }
      }
    }
    if (!runAgent || !createUserMessage) {
      return {
        agentId,
        report:
          'Error: workflow spawner could not load AgentTool.runAgent (circular import or build issue). ' +
          'If you saw this in production, report it — the legacy no-op fallback was removed in 2026-06-07.',
      }
    }
    const agentType = (opts?.agentType as string | undefined) ?? 'general-purpose'
    const defs = toolUseCtx.options?.agentDefinitions as
      | { allAgents?: unknown[] }
      | undefined
    const agents = (defs?.allAgents ?? []) as Array<{ agentType: string; [k: string]: unknown }>
    const agentDef = agents.find(a => a.agentType === agentType)
    if (!agentDef) {
      return {
        agentId,
        report: `Error: unknown agentType "${agentType}" (available: ${agents
          .map(a => a.agentType)
          .join(', ') || '<none>'})`,
      }
    }
    // Workflow tool override: when opts.tools is a string array,
    // shadow agentDef with that allowlist for this call. We do NOT
    // touch disallowedTools — the agent's own denylist still applies.
    // Unknown tool names are dropped later by resolveAgentTools,
    // matching the frontmatter's lenient semantics. Non-array values
    // (e.g. a bare string) are silently ignored.
    let effectiveAgentDef = agentDef
    if (
      opts &&
      typeof opts === 'object' &&
      'tools' in opts &&
      Array.isArray((opts as { tools?: unknown }).tools)
    ) {
      effectiveAgentDef = {
        ...agentDef,
        tools: (opts as { tools: string[] }).tools,
      }
    }
    let report = ''
    // Token / tool usage accumulated across the streamed run.
    // - tokensUsed: sum of input_tokens + output_tokens from each
    //   assistant message's `usage` field (Anthropic SDK shape).
    //   Cache tokens (cache_creation_input_tokens, cache_read_input_tokens)
    //   are intentionally excluded — they're free for the user and would
    //   distort the "X tok" display in the panel.
    // - toolsUsed: count of `tool_use` blocks across all assistant
    //   messages (each block = one tool invocation the agent made).
    // - toolCalls: ordered list of (name, inputSummary) for the
    //   most recent tool_use blocks. Capped at TOOL_CALL_HISTORY_CAP
    //   entries so a long-running agent doesn't blow up memory.
    // - model: the actual model the API call used (from the
    //   assistant message's `m.message.model` field). Surfaced in
    //   the /workflows panel so the user can see which model each
    //   subagent used even when the workflow script didn't pass
    //   `model` explicitly in opts.
    //
    // CRITICAL timing note: the Anthropic SDK sets `usage` via a
    // direct property MUTATION on the last yielded message, in the
    // `message_delta` event handler (claude.ts:2259). That handler
    // runs AFTER the message has been yielded to us. So if we read
    // `usage` during the for-await loop, we always see undefined.
    // The fix: keep a reference to the last assistant message and
    // re-read its `usage` field AFTER the loop completes, by which
    // point the delta has fired and mutated the field in place.
    let tokensUsed = 0
    let toolsUsed = 0
    const toolCalls: ToolCallRecord[] = []
    let lastAssistantMessage: unknown = null
    let model: string | undefined
    // Schema path: when opts.schema is set we inject a StructuredOutputTool
    // (bound to that schema) into the subagent's tool pool. The tool's
    // name is randomized per call (StructuredOutput_<8chars>); we
    // capture the actual name here so we can recognize the subagent's
    // tool_use block in the stream and pull the `data` field out for
    // validation.
    let structuredOutput: unknown = undefined
    let structuredOutputToolName: string | undefined = undefined
    // Worktree isolation: when opts.isolation === 'worktree' we wrap
    // the subagent run in withWorktreeIsolation. The worktree path
    // and whether it was auto-removed are surfaced on the SpawnResult
    // so callers can inspect or merge surviving changes.
    let worktreePath: string | undefined = undefined
    let isolationRemoved = false
    // Pre-resolve the agent definition / available tools so we can
    // append the bound StructuredOutput tool when schema is set.
    let availableToolsForRun =
      (toolUseCtx.options as { tools?: unknown[] } | undefined)?.tools ?? []
    if (opts && typeof opts === 'object' && 'schema' in opts && opts.schema) {
      const { StructuredOutputTool } = await import(
        '../StructuredOutputTool/StructuredOutputTool.js'
      )
      const bound = StructuredOutputTool.withSchema(
        opts.schema as Record<string, unknown>,
      )
      structuredOutputToolName = bound.name
      availableToolsForRun = [...availableToolsForRun, bound]
    }
    // Fire onProgress with a snapshot of the current stats. Captured
    // here so the in-loop emission and the post-loop correction both
    // share the same payload shape.
    const fireProgress = () => {
      if (opts?.onProgress) {
        // Snapshot toolCalls so a slow listener can't see the
        // array mutate underneath them mid-iteration.
        const toolCallsSnapshot = toolCalls.slice()
        opts.onProgress({
          tokensUsed,
          toolsUsed,
          toolCalls: toolCallsSnapshot,
          model,
        })
      }
    }
    // The actual subagent run, scoped to `effectiveCwd`. Extracted
    // so the worktree-isolation branch can call it with a chdir'd
    // cwd, while the non-isolation branch calls it with the
    // process's current cwd. Returns the final report string (or
    // throws) — tokensUsed / toolsUsed / model / structuredOutput
    // accumulate into the outer-scope lets via closure.
    const runInner = async (effectiveCwd: string): Promise<string> => {
      const originalCwd = process.cwd()
      const needsChdir = effectiveCwd !== originalCwd
      if (needsChdir) process.chdir(effectiveCwd)
      try {
        for await (const msg of runAgent({
          agentDefinition: effectiveAgentDef,
          promptMessages: [createUserMessage({ content: prompt })],
          // All `unknown` because runAgent is @ts-nocheck and accepts
          // the full ToolUseContext shape; we can't reconstruct the
          // narrow inferred type here. The runtime shape is preserved.
          toolUseContext: toolUseCtx,
          canUseTool,
          isAsync: false,
          querySource: 'workflow_subagent',
          model: opts?.model,
          transcriptSubdir: `workflows/${taskId}`,
          // runAgent() destructures `availableTools` (required) and
          // crashes with `Cannot read properties of undefined (reading
          // 'filter')` if it's missing. Fall back to the parent's
          // tool pool; an empty array is acceptable because the agent
          // definition's `tools` field narrows it further inside
          // resolveAgentTools(). When `opts.schema` is set, we inject
          // the bound StructuredOutputTool here so the subagent can
          // call it.
          availableTools: availableToolsForRun,
        })) {
          // Collect the final assistant text + usage stats from
          // streamed messages. The Anthropic SDK message shape is
          // `{ type, message: { content: [{ type, text, ... }], usage,
          // model } }` for assistant messages. `usage` may be unset on
          // this message (see CRITICAL timing note above) — we'll
          // re-read it after the loop.
          const m = msg as {
            type?: string
            message?: {
              content?: Array<{
                type?: string
                text?: string
                name?: string
                input?: unknown
              }>
              usage?: {
                input_tokens?: number
                output_tokens?: number
              }
              model?: string
            }
          }
          if (m.type === 'assistant') {
            lastAssistantMessage = m
            // Capture the model as soon as we see it (any assistant
            // message's model field is the model for the whole run).
            if (typeof m.message?.model === 'string' && !model) {
              model = m.message.model
            }
            const content = m.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  report += block.text
                } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                  toolsUsed++
                  if (toolCalls.length < TOOL_CALL_HISTORY_CAP) {
                    toolCalls.push({
                      name: block.name,
                      inputSummary: summarizeToolInput(block.name, block.input),
                      at: Date.now(),
                    })
                  }
                  // Schema path: capture the subagent's StructuredOutput
                  // call so we can validate the `data` field after the
                  // stream finishes.
                  if (
                    structuredOutputToolName &&
                    block.name === structuredOutputToolName &&
                    block.input &&
                    typeof block.input === 'object' &&
                    'data' in block.input
                  ) {
                    structuredOutput = (block.input as { data: unknown }).data
                  }
                }
              }
            }
            // Best-effort usage read here too: if the SDK happened
            // to set usage on an earlier assistant message (not just
            // the last), the loop catches it. The post-loop read below
            // handles the last-message case.
            const usage = m.message?.usage
            if (usage) {
              const inT = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
              const outT = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
              tokensUsed += inT + outT
            }
            // Live progress: fire after every assistant message so
            // callers (LocalWorkflowTask → dialog) can tick the UI
            // up as the agent runs, instead of waiting for the final
            // SpawnResult.
            fireProgress()
          }
        }
        // Post-loop: re-read the last assistant message's usage field
        // now that the SDK has fired message_delta and mutated it
        // in place. Overwrite the in-loop accumulation with the
        // final (cumulative) value, since the last message's usage
        // is the authoritative count for the whole run.
        if (lastAssistantMessage) {
          const lastUsage = (lastAssistantMessage as {
            message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          }).message?.usage
          if (lastUsage) {
            const inT = typeof lastUsage.input_tokens === 'number' ? lastUsage.input_tokens : 0
            const outT = typeof lastUsage.output_tokens === 'number' ? lastUsage.output_tokens : 0
            const finalTotal = inT + outT
            if (finalTotal > tokensUsed) tokensUsed = finalTotal
          }
          // Final onProgress with the corrected token count so the
          // UI converges to the authoritative value rather than the
          // in-loop estimate (which undercounts when the SDK mutates
          // usage after yielding).
          fireProgress()
        }
        return report || '(empty response from subagent)'
      } finally {
        if (needsChdir) process.chdir(originalCwd)
      }
    }
    // Outer: choose isolation vs direct. The error-report catch is
    // the same for both paths so the caller always gets a SpawnResult
    // shape (never a rejection) — required by the LocalWorkflowTask
    // wrapper.
    const wantsWorktree =
      opts &&
      typeof opts === 'object' &&
      'isolation' in opts &&
      (opts as { isolation?: unknown }).isolation === 'worktree'
    let finalReport: string
    try {
      if (wantsWorktree) {
        const { withWorktreeIsolation } = await import(
          './runtime/isolation.js'
        )
        const wtId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const wtResult = await withWorktreeIsolation({
          repoRoot: process.cwd(),
          worktreeId: wtId,
          run: (wtPath: string) => runInner(wtPath),
        })
        worktreePath = wtResult.worktreePath
        isolationRemoved = !wtResult.changed
        finalReport = wtResult.report as string
      } else {
        finalReport = await runInner(process.cwd())
      }
    } catch (e) {
      return {
        agentId,
        report: `Error: subagent run failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      }
    }
    // Schema path: validate whatever the subagent emitted via the
    // bound StructuredOutputTool. If the subagent never called the
    // tool, surface a {ok:false, error} envelope so the caller can
    // distinguish "I forgot" from "the data is bad". On validation
    // success we keep the raw captured value (the structured output
    // payload the subagent emitted) so the caller can use it
    // directly without unwrapping a `{ok,value}` envelope.
    if (opts && typeof opts === 'object' && 'schema' in opts && opts.schema) {
      const schema = opts.schema as Record<string, unknown>
      // I4: hoist the validator import — single callsite, cached by Bun.
      // If the import fails, use a stub that always returns the error
      // envelope so the schema branch below can call validate(...) safely.
      type ValidateFn = (
        schema: Record<string, unknown>,
        input: unknown,
      ) => { ok: true; value: Record<string, unknown> } | { ok: false; error: string }
      let validateUnavailable: string | undefined
      let validate: ValidateFn = () => ({
        ok: false,
        error: 'structuredOutput validator unavailable',
      })
      try {
        const m = await import('../StructuredOutputTool/schemaValidator.js')
        validate = m.validateStructuredOutput
      } catch (e) {
        validateUnavailable =
          'structuredOutput validator unavailable: ' +
          (e instanceof Error ? e.message : String(e))
        validate = () => ({ ok: false, error: validateUnavailable! })
      }
      const finalFailureEnvelope = validateUnavailable
        ? { ok: false as const, error: validateUnavailable }
        : {
            ok: false as const,
            error:
              'subagent completed without calling StructuredOutput ' +
              `(expected a tool_use to "${structuredOutputToolName}")`,
          }
      // Extract a JSON value from the prose report (or undefined if none).
      // Returns the schema-validated value on success, or undefined on
      // no match / invalid shape. The caller decides what to do when
      // both this and the captured structuredOutput are available.
      const tryTextFallback = (): unknown => {
        if (typeof finalReport !== 'string') return undefined
        const extracted = findFirstBalancedJsonValue(finalReport)
        if (extracted === undefined) return undefined
        let textParsed: unknown
        try {
          textParsed = JSON.parse(extracted)
        } catch {
          return undefined
        }
        if (textParsed && typeof textParsed === 'object') {
          // LLM may wrap as {data: {...}} (StructuredOutput mimicry).
          const candidate =
            'data' in (textParsed as Record<string, unknown>) &&
            (textParsed as { data?: unknown }).data !== null &&
            typeof (textParsed as { data?: unknown }).data === 'object'
              ? (textParsed as { data: unknown }).data
              : textParsed
          const v = validate(schema, candidate)
          return v.ok ? candidate : undefined
        }
        if (typeof textParsed === 'string') {
          // I1 fix: scalar branch is single-field-schema-only.
          const schemaProperties =
            schema.properties && typeof schema.properties === 'object'
              ? (schema.properties as Record<string, unknown>)
              : null
          const schemaKeys = schemaProperties ? Object.keys(schemaProperties) : []
          if (schemaKeys.length === 1) {
            const candidate = { [schemaKeys[0]!]: textParsed }
            const v = validate(schema, candidate)
            return v.ok ? candidate : undefined
          }
        }
        return undefined
      }

      // Orchestration: prefer the captured StructuredOutput call when it
      // validates; if it fails (or wasn't captured), try the text fallback;
      // if both fail, surface the more informative error envelope
      // (captured when available, else the generic final-failure envelope).
      if (validateUnavailable) {
        structuredOutput = finalFailureEnvelope
      } else if (structuredOutput === undefined) {
        const fromText = tryTextFallback()
        structuredOutput = fromText !== undefined ? fromText : finalFailureEnvelope
      } else {
        const v = validate(schema, structuredOutput)
        if (v.ok) {
          // Captured StructuredOutput validated — trust it.
          // (Keeps the regression test "StructuredOutput tool call wins
          // over text fallback" green.)
        } else {
          // Captured StructuredOutput is invalid (e.g. LLM called the
          // tool with the wrong shape, like `{"data": ""}`). Fall back
          // to text — the LLM often writes the answer in prose AFTER
          // giving up on the tool, and the answer is what the caller
          // wants.
          const fromText = tryTextFallback()
          if (fromText !== undefined) {
            structuredOutput = fromText
          } else {
            // Both failed — surface the captured error envelope (more
            // informative: it includes the actual data shape mismatch
            // from the LLM's attempt).
            structuredOutput = v
          }
        }
      }
    }
    // Plan12 Task 3: best-effort cache write. When the caller set
    // `resumeRunId`, persist this (prompt, opts, result) tuple so a
    // later resume can replay it. The cache key includes opts
    // (model, tools, etc.) so changing them correctly invalidates the
    // cached entry.
    if (opts && typeof opts === 'object' && 'resumeRunId' in opts) {
      const resumeRunId = (opts as { resumeRunId?: unknown }).resumeRunId
      if (typeof resumeRunId === 'string' && resumeRunId.length > 0) {
        try {
          const { saveAgentResult } = await import(
            './workflowResumeStore.js'
          )
          saveAgentResult(
            resumeRunId,
            { prompt, opts },
            { report: finalReport, agentId },
          )
        } catch {
          // Cache write is best-effort.
        }
      }
    }
    return {
      agentId,
      report: finalReport,
      tokensUsed,
      toolsUsed,
      toolCalls,
      model,
      structuredOutput,
      worktreePath,
      isolationRemoved: wantsWorktree ? isolationRemoved : undefined,
    }
  }
}

/** Cap on tool-call records stored per agent. Long-running agents
 *  (e.g. opencc-bug-hunt finders doing many codegraph + Read + Glob
 *  calls) would otherwise grow unbounded. 50 covers a 5-minute run
 *  with one tool call every 6s; the UI shows the most recent 3. */
const TOOL_CALL_HISTORY_CAP = 50

/**
 * Pick the most informative field from a tool_use `input` object and
 * render a one-line summary. Heuristic per known tool name:
 *   - Read / Write / Edit → file_path
 *   - Bash → command
 *   - Grep → pattern (+ optional -A/-B/-C context flag)
 *   - Glob → pattern
 *   - WebFetch → url
 *   - WebSearch → query
 *   - Agent / Task → description
 *   - fallback → JSON.stringify the first 80 chars
 *
 * The summary is for the /workflows panel "Activity" section, where
 * the user wants a glance of "what is this agent doing?" — not a
 * full reproducer. Keep it short.
 */
function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') {
    return ''
  }
  const obj = input as Record<string, unknown>
  const pickString = (k: string): string | undefined => {
    const v = obj[k]
    return typeof v === 'string' ? v : undefined
  }
  let summary: string | undefined
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      summary = pickString('file_path') ?? pickString('notebook_path')
      break
    case 'Bash':
      summary = pickString('command') ?? pickString('cmd')
      break
    case 'Grep':
      summary = pickString('pattern')
      if (summary && pickString('path')) summary = `${summary} in ${pickString('path')}`
      break
    case 'Glob':
      summary = pickString('pattern')
      break
    case 'WebFetch':
      summary = pickString('url')
      break
    case 'WebSearch':
      summary = pickString('query')
      break
    case 'Agent':
    case 'Task':
      summary = pickString('description') ?? pickString('prompt')
      break
  }
  if (!summary) {
    // Fallback: first string-typed field, truncated
    for (const v of Object.values(obj)) {
      if (typeof v === 'string') {
        summary = v
        break
      }
    }
    if (!summary) return JSON.stringify(input).slice(0, 80)
  }
  if (summary.length > 80) summary = summary.slice(0, 79) + '…'
  return summary
}

/**
 * Lazy-load the real runAgent + createUserMessage modules. Wrapped so
 * `buildRealSpawner` can call it without paying the import cost in
 * tests that inject their own deps.
 */
async function loadDefaultDeps(): Promise<RealSpawnerDeps> {
  try {
    const [runAgentMod, messagesMod] = await Promise.all([
      import('../../tools/AgentTool/runAgent.js') as unknown as Promise<{ runAgent: RunAgentFn }>,
      import('../../utils/messages.js') as unknown as Promise<{ createUserMessage: CreateUserMessageFn }>,
    ])
    return {
      runAgent: runAgentMod.runAgent,
      createUserMessage: messagesMod.createUserMessage,
    }
  } catch {
    return { runAgent: null, createUserMessage: null }
  }
}
