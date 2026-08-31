import { z as z4 } from 'zod/v4'
import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import {
  getSubagentRegistry,
  type SubagentResult,
} from '../../subagents/registry.js'
import { formatSubagentProviderSection } from '../../subagents/promptSection.js'
import { spawnCliAgent, type CliAgentSpawn } from '../../subagents/cliAgent/spawn.js'
import {
  mirrorAppendBgEvent,
  mirrorAttachTaskToBg,
  mirrorFinalizeBgTask,
} from '../../runtime/agentTaskBridge.js'
// zai patch (2026-08-31, plan spawnagent-async): the lifecycle helpers
// (`completeAgentTask` / `killAsyncAgent` / `enqueueAgentNotification`)
// transitively pull in BashTool.tsx and other heavy vendor modules that
// fail to evaluate under vitest ESM (pre-existing test-infra issue).
// Loading them lazily inside `runCliSubagentLifecycle` keeps the top-level
// module load light: zai-server (Node ESM) triggers them only on the first
// SpawnAgent call, and the unit tests that exercise only the tool's
// surface / wrapper don't trigger the heavy chain at all.
//
// All opencc-src imports below are intentionally `import type` (erased at
// compile time, no runtime load) or lazy `await import(...)` inside the
// lifecycle. None of them should appear at the top level.
import type { AgentToolResult } from '../../../opencc-src/tools/AgentTool/agentToolUtils.js'
import type { LocalAgentTaskState } from '../../../opencc-src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { SetAppState } from '../../../opencc-src/Task.js'

/**
 * SpawnAgent — OPENCC native tool that delegates to a CLI subagent
 * (`claude-code` CLI or `dsh` DeepSeek Harness SDK runtime).
 *
 * Modeled on vendor `AgentTool`'s async-from-start branch (AgentTool.tsx
 * lines 897-973): the tool call returns immediately with a task_id; the
 * CLI runs detached; lifecycle transitions are tracked via vendor
 * LocalAgentTask so `TaskOutput(task_id)` and the task panel work the same
 * as for built-in agents.
 *
 * Lifecycle mapping:
 *   - register: `registerTask` with `type: 'local_agent'`, `agentType:
 *     spawn.agent_type` ('claude-code' | 'dsh'), independent abort
 *     controller (deliberately NOT linked to the parent query's controller,
 *     mirroring AgentTool.tsx:905-907 — ESC on the main thread must not
 *     kill detached children).
 *   - detach: `void runCliSubagentLifecycle(...)` — subscribes to provider
 *     events, mirrors to bg runtime + SSE drawer, awaits `run.result`, and
 *     on settle calls `completeLocalAgentTaskWithResultText` (with
 *     resultText plumbed to bg) / `killAsyncAgent` / `finalizeAsFailed`
 *     plus `enqueueAgentNotification` so the parent receives a
 *     `<task-notification>` carrying an inline `<result>` block.
 *   - kill: `chat:killAgents` calls `killAsyncAgent(taskId, setAppState)`
 *     which aborts the task's controller, propagating to the spawn signal
 *     and the provider's `cancel()`.
 *
 * The tool's `description()` lists registered providers via
 * `formatSubagentProviderSection(registry)` so the model knows which
 * `subagent_type` values are live at call time.
 */
const SpawnAgentInputV4 = z4.object({
  /** Model-facing short label (3-5 words). */
  description: z4.string(),
  /** The task text the CLI subagent receives. */
  prompt: z4.string(),
  /**
   * Which provider to spawn. Only registry-registered CLI agents
   * (`claude-code` / `dsh`) route here; the description lists what's live.
   */
  subagent_type: z4.string().describe(
    'Which CLI subagent provider to spawn. Use a registered external subagent provider (see the provider list in the tool description) — `claude-code` / `dsh`.',
  ),
  /** Optional model override; providers may ignore. */
  model: z4.string().optional(),
  /** Absolute cwd override; falls back to `process.cwd()` if omitted. */
  cwd: z4
    .string()
    .describe('Absolute path to run the agent in. Defaults to the parent session cwd.')
    .optional(),
  /** Optional addressable name (mirrors AgentTool `name`). */
  name: z4.string().optional(),
  /** Optional team name — makes agent_id `name@team` (mirrors AgentTool `team_name`). */
  team_name: z4.string().optional(),
})

type SpawnAgentInput = z4.infer<typeof SpawnAgentInputV4>

const SpawnAgentBaseDescription =
  'Spawn a CLI subagent to delegate a standalone task to an external agent engine ' +
  '(claude-code CLI or dsh / DeepSeek Harness SDK runtime). Each runs as an ' +
  'independent process in its own context and inherits no parent conversation. ' +
  'Choose the engine via `subagent_type`; give it a complete, self-contained prompt ' +
  'because it cannot see this conversation. The tool always returns a task_id ' +
  'immediately — poll progress with `TaskOutput(task_id)` or read the output file ' +
  'path returned in the result; you will be notified on completion.'

function buildDescription(): string {
  const section = formatSubagentProviderSection(getSubagentRegistry())
  return (
    SpawnAgentBaseDescription +
    (section
      ? '\n\n' + section
      : '\n\n(no external subagent providers are registered at this time)')
  )
}

/** Payload shape returned to the LLM after a successful (async) spawn. */
interface AsyncLaunchedPayload {
  isAsync: true
  status: 'async_launched'
  agentId: string
  description: string
  prompt: string
  outputFile: string
  canReadOutputFile: boolean
}

/** Manual tool object — function description + zod/v4 inputSchema + call. */
export const spawnAgentTool = {
  name: 'SpawnAgent',
  description: buildDescription,
  inputSchema: SpawnAgentInputV4,
  async call(args: unknown, ctx: unknown): Promise<{ data: AsyncLaunchedPayload } | { output: string }> {
    const parsed = SpawnAgentInputV4.safeParse(args)
    if (!parsed.success) {
      return {
        output: `[error] invalid input for SpawnAgent: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      }
    }
    return executeSpawn(parsed.data, ctx)
  },
}

async function executeSpawn(
  args: SpawnAgentInput,
  ctx: unknown,
): Promise<{ data: AsyncLaunchedPayload } | { output: string }> {
  const {
    description,
    prompt,
    subagent_type,
    model,
    cwd,
    name,
    team_name,
  } = args

  const registry = getSubagentRegistry()
  const provider = registry.getProvider(subagent_type)
  if (!provider) {
    const message =
      `SpawnAgent: no subagent provider named '${subagent_type}'. ` +
      `Registered: ${registry.list().join(', ') || '∅'} — route via ` +
      `subagent_type: 'claude-code' | 'dsh' (or whichever are registered).`
    throw new Error(message)
  }

  // Independent abort controller — deliberately NOT chained to the parent
  // query's controller (mirrors AgentTool.tsx:905-907). Background children
  // survive ESC on the main thread; kill via `chat:killAgents` / explicit
  // TaskStop, which routes through `killAsyncAgent(taskId, setAppState)`
  // and aborts this controller, propagating to the spawn signal.
  const spawnAbort = new AbortController()

  const spawn = await spawnCliAgent({
    name,
    agentType: subagent_type as 'claude-code' | 'dsh',
    prompt,
    description,
    teamName: team_name,
    cwd: cwd ?? process.cwd(),
    model,
    signal: spawnAbort.signal,
  })

  const taskId = spawn.task_id
  const setAppState = readSetAppStateFromCtx(ctx)
  const toolUseId = readToolUseIdFromCtx(ctx)

  // Lazy-load the vendor task framework so the heavy BashTool /
  // LocalAgentTask chain only fires on the first SpawnAgent call (and
  // not at all in unit tests that exercise only the tool surface).
  const [
    { createTaskStateBase },
    { registerTask },
    { registerCleanup },
  ] = await Promise.all([
    import('../../../opencc-src/Task.js'),
    import('../../../opencc-src/utils/task/framework.js'),
    import('../../../opencc-src/utils/cleanupRegistry.js'),
  ])

  // Register the LocalAgentTask so TaskOutput / task panel / SSE drawer
  // pick up the detached run. `agentType` carries the CLI provider kind
  // (AgentTool normally carries an `AgentDefinition.agentType`; for CLI
  // children we use the provider name directly — it stays a `string` per
  // LocalAgentTaskState.agentType).
  const taskState = {
    ...createTaskStateBase(taskId, 'local_agent', description, toolUseId),
    type: 'local_agent' as const,
    status: 'running' as const,
    agentId: taskId,
    prompt,
    agentType: spawn.agent_type,
    abortController: spawnAbort,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [] as string[],
    retain: false,
    diskLoaded: false,
    unregisterCleanup: registerCleanup(async () => {
      const { killAsyncAgent } = await import(
        '../../../opencc-src/tasks/LocalAgentTask/LocalAgentTask.js'
      )
      await killAsyncAgent(taskId, setAppState)
    }),
  }
  registerTask(taskState, setAppState)

  // Fire-and-forget lifecycle. The actual CLI work happens here; the tool
  // call resolves before the run settles.
  void runCliSubagentLifecycle({
    spawn,
    taskId,
    abortController: spawnAbort,
    setAppState,
    description,
    prompt,
    toolUseId,
    parentSessionId: readZaiCurrentSessionIdBridge(),
    outputFile: taskState.outputFile,
  })

  // Return the AgentTool-shaped async_launched payload. Tool.tsx:118 +
  // mapToolResultToToolResultBlockParam below surface this to the model
  // with the standard "use TaskOutput / wait for notification" wording.
  return {
    data: {
      isAsync: true,
      status: 'async_launched',
      agentId: taskId,
      description,
      prompt,
      outputFile: taskState.outputFile,
      canReadOutputFile: true,
    },
  }
}

/**
 * Drive a spawned CLI subagent from attach → terminal notification.
 *
 * Mirrors vendor `runAsyncAgentLifecycle` (agentToolUtils.ts:534) but
 * adapted for the CLI event stream: we don't iterate over opencc Messages
 * (the provider emits `agentMessage` / `toolCall` / `toolResult` /
 * `commentary` / `turnStarted` / `turnCompleted` instead, mapped via
 * `mapSubagentEventType` for bg-runtime consumption). The four state
 * transitions map onto:
 *   - completed → `completeLocalAgentTaskWithResultText`
 *                 (status 'completed' + bg finalized with resultText so
 *                 SubagentNotifier inlines `<result>` in the parent
 *                 session's `<task-notification>`; result text is also
 *                 written to `output_file` for direct Read access)
 *   - aborted   → `killAsyncAgent`     (status 'killed'   + bg cancelled)
 *   - error     → `finalizeAsFailed`   (status 'failed'   + bg finalized)
 *   - throw     → `finalizeAsFailed`   (same as error)
 *
 * `enqueueAgentNotification` fires the `<task-notification>` so the parent
 * conversation learns about terminal state on its next loop iteration.
 */
async function runCliSubagentLifecycle({
  spawn,
  taskId,
  abortController: _abortController,
  setAppState,
  description,
  prompt: _prompt,
  toolUseId,
  parentSessionId,
  outputFile,
}: {
  spawn: CliAgentSpawn
  taskId: string
  abortController: AbortController
  setAppState: SetAppState
  description: string
  prompt: string
  toolUseId?: string
  parentSessionId?: string
  /** Disk path where the result text is persisted so `Read` can find it.
   *  Sourced from `LocalAgentTaskState.outputFile` (= `getTaskOutputPath(taskId)`). */
  outputFile: string
}): Promise<void> {
  // 1. attach to bg runtime (SSE drawer + parentSessionId for notifier)
  await mirrorAttachTaskToBg({
    id: taskId,
    input: {
      prompt: spawn.prompt,
      cwd: undefined,
      agent: spawn.agent_type,
      model: spawn.model ?? undefined,
    },
    metadata: {
      parentSessionId,
      agentType: spawn.agent_type,
      description,
      invocationKind: 'spawn',
    },
  })

  // 2. pump events to bg runtime (non-fatal; failures swallowed like
  //    subagentProviderBridge does — terminal state still arrives via
  //    `run.result`).
  void pumpEventsToBg(spawn.run, taskId)

  // 3. wait for terminal state
  let result: SubagentResult
  try {
    result = await spawn.run.result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finalizeAsFailed(taskId, message, setAppState)
    // Write the error to the output file too so `Read output_file` is a
    // viable recovery path (the <task-notification> already carries the
    // error in its summary, but the file is the durable record).
    await writeResultToOutputFile(outputFile, `[error] ${message}`)
    const { enqueueAgentNotification } = await import(
      '../../../opencc-src/tasks/LocalAgentTask/LocalAgentTask.js'
    )
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: message,
      setAppState,
      toolUseId,
    })
    return
  }

  // 4. terminal transition — lazy-load the vendor helpers to keep the
  // top-level module load light (see import comments above).
  const {
    enqueueAgentNotification,
    killAsyncAgent,
  } = await import('../../../opencc-src/tasks/LocalAgentTask/LocalAgentTask.js')

  if (result.stopReason === 'completed') {
    // Write result text to disk BEFORE finalizing. The async pipeline is:
    //   1. write file  →  Read tool can find it (we promised `output_file`
    //      points to a real file in the tool_result)
    //   2. completeTaskState → mirror bg with resultText (so SubagentNotifier
    //      inlines <result>{text}</result> in the parent session's
    //      <task-notification> — parent agent sees the result without a
    //      follow-up TaskOutput / Read round trip)
    // We bypass vendor `completeAgentTask` because it calls
    // `mirrorFinalizeBgTask(taskId, 'completed')` without resultText.
    const resultText = result.text ?? ''
    await writeResultToOutputFile(outputFile, resultText)
    const agentResult = buildAgentToolResult(taskId, spawn.agent_type, result)
    completeLocalAgentTaskWithResultText(agentResult, setAppState, resultText || undefined)
    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState,
      finalMessage: resultText || undefined,
      toolUseId,
    })
    return
  }

  if (result.stopReason === 'aborted') {
    // killAsyncAgent no-ops if TaskStop already moved us to 'killed'; we
    // still call it to handle the case where the abort signal fired but
    // the task hasn't transitioned yet.
    killAsyncAgent(taskId, setAppState) // includes mirrorFinalizeBgTask(cancelled)
    enqueueAgentNotification({
      taskId,
      description,
      status: 'killed',
      setAppState,
      toolUseId,
    })
    return
  }

  // 'error' or anything else — drive LocalAgentTask to 'failed' with the
  // provider's error message; mirror bg with the subagent_provider_error
  // category so the SSE drawer can distinguish CLI subagent failures from
  // in-process internal errors.
  const errorMessage =
    result.errorMessage ?? `subagent stopped with stopReason=${result.stopReason}`
  await finalizeAsFailed(taskId, errorMessage, setAppState)
  await writeResultToOutputFile(outputFile, `[error] ${errorMessage}`)
  enqueueAgentNotification({
    taskId,
    description,
    status: 'failed',
    error: errorMessage,
    setAppState,
    toolUseId,
  })
}

/**
 * Mark the LocalAgentTask as failed AND mirror the bg-runtime terminal
 * state. We avoid `failAgentTask` because it hard-codes
 * `category: 'internal'`; for CLI subagent failures we want
 * `subagent_provider_error` so the drawer can distinguish them from
 * in-process internal errors.
 */
async function finalizeAsFailed(
  taskId: string,
  error: string,
  setAppState: SetAppState,
): Promise<void> {
  const { updateTaskState, PANEL_GRACE_MS } = await import(
    '../../../opencc-src/utils/task/framework.js'
  )
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    task.unregisterCleanup?.()
    return {
      ...task,
      status: 'failed',
      error,
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined,
    }
  })
  void mirrorFinalizeBgTask(taskId, 'failed', {
    message: error,
    category: 'subagent_provider_error',
  })
}

/**
 * Build a minimal AgentToolResult so `TaskOutputTool.getTaskOutputData` can
 * read the in-memory transcript. Token / tool-use counters are unknown for
 * CLI children — fill with 0.
 */
function buildAgentToolResult(
  taskId: string,
  agentType: string,
  result: SubagentResult,
): AgentToolResult {
  return {
    agentId: taskId,
    agentType,
    content: result.text ? [{ type: 'text', text: result.text }] : [],
    totalToolUseCount: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
  }
}

/**
 * zai patch (2026-08-31, plan spawnagent-result-inline): vendor
 * `completeAgentTask` (LocalAgentTask.tsx:416) calls
 * `mirrorFinalizeBgTask(taskId, 'completed')` without forwarding
 * `resultText`, so the bg BackgroundTask's `resultText` field stays empty
 * and the parent session's `<task-notification>` ships without a `<result>`
 * block (parent agent has to follow up with TaskOutput / Read output_file).
 *
 * This helper mirrors vendor `completeAgentTask` verbatim but plumbs
 * `resultText` through to `mirrorFinalizeBgTask` so SubagentNotifier can
 * inline the result. Vendor `completeAgentTask` stays untouched — used by
 * AgentTool where dispatch-path streaming already sets `resultText` and
 * the parallel mirror call would just be redundant.
 */
async function completeLocalAgentTaskWithResultText(
  result: AgentToolResult,
  setAppState: SetAppState,
  resultText: string | undefined,
): Promise<void> {
  const [
    { updateTaskState, PANEL_GRACE_MS },
    { evictTaskOutput },
  ] = await Promise.all([
    import('../../../opencc-src/utils/task/framework.js'),
    import('../../../opencc-src/utils/task/diskOutput.js'),
  ])
  const taskId = result.agentId
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    task.unregisterCleanup?.()
    return {
      ...task,
      status: 'completed',
      result,
      endTime: Date.now(),
      evictAfter: task.retain ? undefined : Date.now() + PANEL_GRACE_MS,
      abortController: undefined,
      unregisterCleanup: undefined,
      selectedAgent: undefined,
    }
  })
  void evictTaskOutput(taskId)
  // mirrorFinalizeBgTask signature is (taskId, status, error?, resultText?).
  // resultText gets persisted on the bg BackgroundTask; SubagentNotifier
  // (zai/src/server/services/subagentNotifier.ts:92) reads it and inlines
  // it into <result>{text}</result> in the parent session's
  // <task-notification>.
  void mirrorFinalizeBgTask(taskId, 'completed', undefined, resultText)
}

/**
 * Write the final result text to `outputFile` so the model can `Read` it
 * directly. Vendor AgentTool wires this via `initTaskOutputAsSymlink` →
 * transcript JSONL, but attach-path callers (SpawnAgent) don't have a
 * transcript — the simplest durable representation is the result text
 * itself, written verbatim. Best-effort: any fs failure is silently
 * swallowed (TaskOutput still works via in-memory `task.result.content`).
 */
async function writeResultToOutputFile(
  outputFile: string,
  text: string,
): Promise<void> {
  if (!text) return
  try {
    const [{ writeFile, mkdir }, { dirname }] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ])
    await mkdir(dirname(outputFile), { recursive: true })
    await writeFile(outputFile, text, 'utf8')
  } catch {
    // best-effort; Read tool can still fail but TaskOutput stays functional
  }
}

/**
 * Forward `run.events` to the bg runtime. Mirrors `subagentProviderBridge`
 * tolerance — event-pump failures never fail the run; terminal state still
 * arrives via `run.result`.
 */
async function pumpEventsToBg(
  run: CliAgentSpawn['run'],
  taskId: string,
): Promise<void> {
  try {
    for await (const event of run.events) {
      await mirrorAppendBgEvent(taskId, {
        type: mapSubagentBgEventType(event.type),
        text: event.text,
        phase: event.phase,
        raw: event.raw,
      } as { type: string; [k: string]: unknown })
    }
  } catch {
    // intentional no-op (see comment above)
  }
}

/** Map provider event vocabulary to bg-event keys the SSE drawer selects on. */
function mapSubagentBgEventType(type: string): string {
  switch (type) {
    case 'agentMessage':
      return 'assistant_message'
    case 'toolCall':
      return 'tool_use'
    case 'toolResult':
      return 'tool_result'
    case 'commentary':
      return 'commentary'
    case 'turnStarted':
      return 'subagent_turn_started'
    case 'turnCompleted':
      return 'subagent_turn_completed'
    default:
      return type
  }
}

/**
 * Build the opencc ctx → zai ToolCallCtx transform. Mirrors SkillTool.ts
 * (SkillBridgeContext): inject sessionId + abortSignal. setAppState /
 * setAppStateForTasks are passed through via `...o` (we need
 * setAppStateForTasks specifically for task registration to reach the root
 * store, not the no-op'd async-agent setAppState — see
 * opencc-src/Tool.ts:213-221).
 */
function buildSpawnTransformCtx() {
  return (openccCtx: unknown) => {
    const o = openccCtx as {
      sessionId?: string
      abortController?: { signal?: AbortSignal }
    }
    return {
      ...o,
      sessionId: o?.sessionId,
      abortSignal: o?.abortController?.signal,
    }
  }
}

/** Read the always-shared setAppState (or fall back to setAppState) from ctx. */
function readSetAppStateFromCtx(ctx: unknown): SetAppState {
  const o = ctx as {
    setAppStateForTasks?: SetAppState
    setAppState?: SetAppState
  }
  // Defensive fallback: zai-native unit tests and early-boot paths pass an
  // empty ctx; registerTask would crash on undefined. A no-op lets the
  // detached run register and reach terminal state without updating the
  // root store (the bg runtime mirror is still reachable through the
  // globalThis bridge).
  return (
    o?.setAppStateForTasks ??
    o?.setAppState ??
    (() => {})
  )
}

/** Read the parent tool-use id from ctx (used for `<task-notification>` linkage). */
function readToolUseIdFromCtx(ctx: unknown): string | undefined {
  const o = ctx as { toolUseId?: string; toolUseID?: string }
  return o?.toolUseId ?? o?.toolUseID
}

/** Read the parent session id via the zai globalThis bridge (best-effort). */
function readZaiCurrentSessionIdBridge(): string | undefined {
  const v = (globalThis as { __zaiCurrentSessionId?: string | null }).__zaiCurrentSessionId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Wrap SpawnAgent as an opencc-compatible Tool so vendor's `query()` can
 * call it. Registered in `getOpenccBuiltinTools()` (compat/tools/opencc/
 * builtin.ts) alongside AskUserQuestion / Skill wrappers. Reads the
 * registry + session bridge at CALL time (globalThis), so the cached
 * wrapper stays correct across concurrent sessions.
 *
 * The default wrapper's `mapToolResultToToolResultBlockParam` JSON-stringifies
 * the data, which would dump the raw async_launched shape at the LLM. We
 * override it to mirror AgentTool's user-facing wording ("use TaskOutput /
 * read output_file / wait for <task-notification>") so the model knows how
 * to query progress for the spawned task.
 */
export function wrapSpawnAgentToolAsOpencc(): unknown {
  const base = wrapAsOpenccTool(spawnAgentTool as never, {
    transformCtx: buildSpawnTransformCtx(),
  })
  return {
    ...base,
    mapToolResultToToolResultBlockParam(data: unknown, toolUseID: string) {
      const d = data as { status?: string; agentId?: string; outputFile?: string } | null
      if (d && typeof d === 'object' && d.status === 'async_launched' && typeof d.agentId === 'string') {
        const outputFile = typeof d.outputFile === 'string' ? d.outputFile : ''
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUseID,
          content: [
            {
              type: 'text' as const,
              text:
                `Async subagent launched successfully.\n` +
                `agentId: ${d.agentId}\n` +
                `The CLI subagent is running in the background. You will be notified automatically when it completes.\n` +
                `output_file: ${outputFile}\n` +
                `If asked, you can check progress before completion by using TaskOutput(task_id: '${d.agentId}') ` +
                `or by reading the output file with Read / Bash tail.`,
            },
          ],
        }
      }
      // Fall back to the default wrapper behaviour for any non-async result
      // (e.g. the `[error] invalid input` payload).
      return base.mapToolResultToToolResultBlockParam(data, toolUseID)
    },
  }
}
