import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import {
  createPoolTask, getTaskSummary, getTaskDetails, listTasks, moveTask, markTaskStatus, emitTaskFactoryEvent, taskFactoryRoot, taskDir,
} from './taskFactoryFiles.js'

const execFileAsync = promisify(execFile)

const CREATE_DESC = 'Create a Task Factory task: initializes task.yaml, docs/spec.md, docs/plan.md, process.md under ~/.zai/task-factory/queue-tasks/<id>/. ' +
  'Call only after the requirements have been discussed with the user; title and cwd are required, agent is the executor subagent name (default "default"), spec/plan are the discussed content (optional; can still be filled in later via Edit). ' +
  'verifierAgent is the optional verification subagent name; when omitted, the task inherits the executor agent. The verifier subagent runs after the executor finishes and independently judges PASS/FAIL by reading docs/spec.md + docs/process.md. ' +
  // zai patch (2026-09-02, 任务工厂升级 priority + dependsOn):
  'priority is "P0"|"P1"|"P2"|"P3" (default "P2"; P0 most urgent); the supervisor dispatches queue-tasks in priority ASC + createdAt ASC order. ' +
  'dependsOn is a string[] of task ids that must reach status=done before this task can be dispatched (default []). ' +
  // zai patch (2026-09-04, quick-intake):
  'mode is "quick"|"full" (default "full"): quick = lightweight task for small fixes / copy edits / styling tweaks — ' +
  'skips brainstorming, generates ONLY task.yaml + process.md + a minimal docs/spec.md (title/description/priority/cwd snapshot), ' +
  'does NOT generate docs/plan.md or docs/brainstorm.md; the intake gate and verifier then only check / audit docs/spec.md. ' +
  'Use quick when the user opens the 「快速创建」 button (task-intake-quick main agent will set this for you).'

const LIST_DESC = 'List all Task Factory tasks across the four lifecycle buckets. ' +
  'Returns a TaskBucket object: { queue: TaskSummary[], processing: TaskSummary[], verifying: TaskSummary[], finished: TaskSummary[] }. ' +
  'Each TaskSummary contains id / title / status / agent / verifierAgent / cwd / description / createdAt / ' +
  'startedAt / completedAt / executorTaskId / verifierTaskId / priority / dependsOn / mode / bucket. ' +
  // zai patch (2026-09-02): 排序契约——priority ASC(P0 先)+ 同优先级 createdAt ASC。
  'Tasks within each bucket are sorted by priority ASC (P0 → P3) then createdAt ASC. ' +
  // zai patch (2026-09-04, quick-intake):
  '`mode` is "quick"|"full" (defaults to "full" for legacy tasks). Quick tasks skip the brainstorming / plan.md / brainstorm.md workflow and use lightweight verification — keep them on the same dispatch lane as full tasks; they share priority / dependsOn semantics. ' +
  'Use this when you need an overview of the pipeline (queue length, processing in flight, recent failures) or ' +
  'when picking the next task to dispatch. Prefer this over enumerating SuperTasksGet calls. ' +
  'For a single task\'s full detail (spec.md / plan.md / process.md content), use SuperTasksGet(id) instead. ' +
  'NOTE: never Read task.yaml files directly — SuperTasksList / SuperTasksGet are the SOLE read paths.'

const MOVE_DESC = 'Move a Task Factory task between lifecycle buckets (queue-tasks / processing-tasks / verifying-tasks / finished-tasks) with optional executorTaskId / verifierTaskId backfill. ' +
  'Use this as the SOLE write path for task state changes — do NOT edit task.yaml by hand. ' +
  'Typical flows: ' +
  '(a) SuperTasksMove(id, "queue-tasks", "processing-tasks", executorTaskId=<subagent>) on dispatch — atomically moves the folder, sets status=processing, and backfills executorTaskId; ' +
  '(b) SuperTasksMove(id, "processing-tasks", "verifying-tasks") after the executor appends "## [DONE]" to process.md; ' +
  '(b2) SuperTasksMove(id, "verifying-tasks", "verifying-tasks", verifierTaskId=<verifierSubagentId>) — in-place backfill right after SpawnAgent returns the verifier task id (from == to means: no folder move, only patch the field; status stays verifying); ' +
  '(b3) SuperTasksMove(id, "processing-tasks", "processing-tasks", executorTaskId=<newSubagentId>) — in-place backfill after a FAIL-retry re-spawn (Reset cleared executorTaskId, the task is already in processing-tasks); ' +
  '(c) SuperTasksMove(id, "verifying-tasks", "finished-tasks") on verifier PASS or forced accept; ' +
  '(d) SuperTasksMove(id, "processing-tasks", "finished-tasks") on forced accept from the processing lane; ' +
  '(e) SuperTasksMove(id, "processing-tasks", "queue-tasks") to roll back a failed SpawnAgent dispatch. ' +
  'Errors: "task <id> not found in <from>" (id absent in the named source bucket — verify with getTaskSummary or ListTasks); ' +
  '"task <id> already exists in <to>" (target bucket already has a folder with this id — concurrent collision; only applies when from != to); ' +
  '"in-place move requires..." (from == to without any executorTaskId/verifierTaskId — nothing to patch). ' +
  'When executorTaskId / verifierTaskId is provided non-empty, the task.yaml is patched in place BEFORE the folder rename so the bucket move and the field write are committed atomically (no separate Edit race).'

const RESET_DESC = 'Reset a Task Factory task back to the runnable state for retry. ' +
  'Auto-detects the current bucket (no `from` argument needed): ' +
  '(a) task in verifying-tasks → folder moves back to processing-tasks AND status is forced to "processing" with executorTaskId AND verifierTaskId cleared; ' +
  '(b) task in processing-tasks with status="paused" → folder stays in processing-tasks, status forced back to "processing" with executorTaskId AND verifierTaskId cleared (no bucket move); ' +
  '(c) task in queue-tasks / finished-tasks / processing-tasks with status!="paused" / not found anywhere → throws "task <id> cannot be reset (current state: bucket=..., status=...)". ' +
  'Use this after a verifier FAIL on round N < 3 to put the task back into the runnable lane so the supervisor can re-SpawnAgent the executor with the verifier feedback path included in the prompt. ' +
  'After Reset, the supervisor must re-SpawnAgent the executor — Reset does NOT cancel or pause any existing subagent; if the previous executor subagent is still alive, the supervisor should BackgroundRuntime.cancel it first.'

const PAUSE_DESC = 'Pause a Task Factory task in place without moving it between buckets. ' +
  'Auto-detects the current bucket (no `from` argument needed): ' +
  '(a) task in processing-tasks → status forced to "paused" and executorTaskId cleared (folder stays in processing-tasks); ' +
  '(b) task in verifying-tasks → status forced to "paused" and executorTaskId cleared (folder stays in verifying-tasks so the user can still force-accept or reset later); ' +
  '(c) task in queue-tasks / finished-tasks / not found → throws "task <id> cannot be paused (current state: bucket=..., status=...)". ' +
  'Pause does NOT cancel the executor subagent — the supervisor is responsible for calling BackgroundRuntime.cancel(executorTaskId) BEFORE Pause so the in-flight subagent is killed first; ' +
  'Pause only writes the paused status. Use this on FAIL round == 3 (after cancel) to freeze the task pending a human decision, or when the user explicitly requests a temporary freeze.'

export const superTasksCreateTool = buildTool({
  name: 'SuperTasksCreate',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return CREATE_DESC },
  async prompt() { return CREATE_DESC },
  get inputSchema() {
    return z.object({
      title: z.string().min(1).describe('Task title (the title field in task.yaml)'),
      cwd: z.string().min(1).describe('Absolute path of the project directory the task belongs to (working directory of the executor subagent; different tasks may live in different code projects)'),
      description: z.string().optional().describe('One-sentence task goal description'),
      agent: z.string().optional().describe('Executor subagent name, defaults to "default"'),
      verifierAgent: z.string().optional().describe('Verification subagent name, defaults to the executor agent. The verifier independently judges PASS/FAIL by reading docs/spec.md + docs/process.md after the executor finishes.'),
      spec: z.string().optional().describe('The discussed requirement spec (markdown)'),
      plan: z.string().optional().describe('The discussed execution plan (markdown)'),
      // zai patch (2026-09-02, 任务工厂升级 priority + dependsOn):
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional()
        .describe('Dispatch priority (default "P2"; P0 most urgent, P3 least urgent). Supervisor dispatches queue-tasks in priority ASC + createdAt ASC.'),
      dependsOn: z.array(z.string().min(4)).optional()
        .describe('Task ids that must reach status=done before this task is dispatched (default []). Self-reference is rejected.'),
      // zai patch (2026-09-04, quick-intake):
      mode: z.enum(['quick', 'full']).optional()
        .describe('Task creation mode (default "full"). "quick" = lightweight (no brainstorming, no plan.md / brainstorm.md, intake gate and verifier only check docs/spec.md); "full" = standard intake flow with three required docs.'),
    })
  },
  async call(input: {
    title: string; cwd: string; description?: string; agent?: string; verifierAgent?: string; spec?: string; plan?: string
    priority?: 'P0' | 'P1' | 'P2' | 'P3'; dependsOn?: string[]; mode?: 'quick' | 'full'
  }) {
    const s = await createPoolTask(input)
    emitTaskFactoryEvent('created', { id: s.id, mode: s.mode })
    const mode = s.mode ?? 'full'
    const meta = `priority=${s.priority ?? 'P2'}, mode=${mode}${input.dependsOn?.length ? `, dependsOn=[${input.dependsOn.join(', ')}]` : ''}`
    const nextStep = mode === 'quick'
      ? 'Next step (quick mode): the task directory has only task.yaml + process.md + a minimal docs/spec.md snapshot. Skip brainstorming — the user already specified the requirements in the QuickCreate form. Report the task id to the user.'
      : 'Next step: persist the discussed results into docs/spec.md and docs/plan.md (replace the skeleton placeholders), and write the discussion minutes to docs/brainstorm.md — a programmatic intake gate checks all three docs when the user closes the modal and feeds missing ones back to you. Before dispatching the executor subagent, read task.yaml to confirm the agent field.'
    return { data: { output: `Task created: ${s.id}\n${s.title}\nProject cwd: ${input.cwd}\nStorage dir: ${join(taskFactoryRoot(), 'queue-tasks', s.id)}\n${meta}\n${nextStep}` } }
  },
  // Tool 接口要求实现结果序列化(缺了会在 runtime 落 tool_result 时抛
  // "mapToolResultToToolResultBlockParam is not a function" —— 2026-09-02
  // intake 弹窗实跑暴露;单测直调 call() 覆盖不到这条链路)。
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksCreate',
})

const BUCKET_ENUM = z.enum(['queue-tasks', 'processing-tasks', 'verifying-tasks', 'finished-tasks'])

export const superTasksMoveTool = buildTool({
  name: 'SuperTasksMove',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return MOVE_DESC },
  async prompt() { return MOVE_DESC },
  get inputSchema() {
    return z.object({
      id: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4'),
      from: BUCKET_ENUM.describe('Source bucket the task is currently in (must match the actual folder location)'),
      to: BUCKET_ENUM.describe('Destination bucket to move the task folder into (must be empty for this id)'),
      executorTaskId: z.string().optional().describe('Optional executor subagent task id to backfill into task.yaml (atomic with the bucket move; typically the id returned by SpawnAgent)'),
      verifierTaskId: z.string().optional().describe('Optional verifier subagent task id to backfill into task.yaml (use with from == to == "verifying-tasks" right after SpawnAgent returns the verifier id)'),
    })
  },
  async call(input: { id: string; from: 'queue-tasks' | 'processing-tasks' | 'verifying-tasks' | 'finished-tasks'; to: 'queue-tasks' | 'processing-tasks' | 'verifying-tasks' | 'finished-tasks'; executorTaskId?: string; verifierTaskId?: string }) {
    const summary = await getTaskSummary(input.id, input.from)
    if (!summary) {
      throw new Error(`task ${input.id} not found in ${input.from}`)
    }
    const patch: { executorTaskId?: string; verifierTaskId?: string } = {}
    if (input.executorTaskId && input.executorTaskId.length > 0) patch.executorTaskId = input.executorTaskId
    if (input.verifierTaskId && input.verifierTaskId.length > 0) patch.verifierTaskId = input.verifierTaskId
    // 就地回填:from === to 时不做目录移动,只写 task.yaml 字段(b2/b3 流程)。
    if (input.from === input.to) {
      if (Object.keys(patch).length === 0) {
        throw new Error(
          `in-place move requires executorTaskId or verifierTaskId (from == to == ${input.from}, nothing to patch)`,
        )
      }
      const patched = await markTaskStatus(input.id, input.from, patch)
      emitTaskFactoryEvent('moved', { id: patched.id, from: input.from, to: input.to, inPlace: true })
      const extra = Object.entries(patch).map(([k, v]) => ` (${k}=${v})`).join('')
      return { data: { output: `Task patched in place: ${patched.id} (${patched.title}) in ${input.from}${extra}` } }
    }
    if (existsSync(taskDir(input.to, input.id))) {
      throw new Error(`task ${input.id} already exists in ${input.to}`)
    }
    if (Object.keys(patch).length > 0) {
      await markTaskStatus(input.id, input.from, patch)
    }
    const moved = await moveTask(input.id, input.from, input.to)
    emitTaskFactoryEvent('moved', { id: moved.id, from: input.from, to: input.to })
    const extra = Object.entries(patch).map(([k, v]) => ` (${k}=${v})`).join('')
    return { data: { output: `Task moved: ${moved.id} (${moved.title}) ${input.from} → ${input.to}${extra}` } }
  },
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksMove',
})

export const superTasksResetTool = buildTool({
  name: 'SuperTasksReset',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return RESET_DESC },
  async prompt() { return RESET_DESC },
  get inputSchema() {
    return z.object({ id: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4') })
  },
  async call(input: { id: string }) {
    const [inQueue, inProcessing, inVerifying, inFinished] = await Promise.all([
      getTaskSummary(input.id, 'queue-tasks'),
      getTaskSummary(input.id, 'processing-tasks'),
      getTaskSummary(input.id, 'verifying-tasks'),
      getTaskSummary(input.id, 'finished-tasks'),
    ])
    if (inVerifying) {
      const moved = await moveTask(input.id, 'verifying-tasks', 'processing-tasks')
      await markTaskStatus(input.id, 'processing-tasks', { status: 'processing', executorTaskId: null, verifierTaskId: null })
      emitTaskFactoryEvent('reset', { id: input.id })
      return { data: { output: `Task reset: ${input.id} (${moved.title}) → processing-tasks/status=processing (executorTaskId/verifierTaskId cleared)` } }
    }
    if (inProcessing && inProcessing.status === 'paused') {
      await markTaskStatus(input.id, 'processing-tasks', { status: 'processing', executorTaskId: null, verifierTaskId: null })
      emitTaskFactoryEvent('reset', { id: input.id })
      return { data: { output: `Task reset: ${input.id} (${inProcessing.title}) → processing-tasks/status=processing (executorTaskId/verifierTaskId cleared)` } }
    }
    const bucket = inQueue ? 'queue-tasks' : inProcessing ? 'processing-tasks' : inFinished ? 'finished-tasks' : '(not found)'
    const status = inProcessing?.status ?? (inQueue ? 'queued' : inVerifying ? 'verifying' : inFinished ? 'done' : 'unknown')
    throw new Error(`task ${input.id} cannot be reset (current state: bucket=${bucket}, status=${status})`)
  },
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksReset',
})

export const superTasksPauseTool = buildTool({
  name: 'SuperTasksPause',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return PAUSE_DESC },
  async prompt() { return PAUSE_DESC },
  get inputSchema() {
    return z.object({ id: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4') })
  },
  async call(input: { id: string }) {
    const [inQueue, inProcessing, inVerifying, inFinished] = await Promise.all([
      getTaskSummary(input.id, 'queue-tasks'),
      getTaskSummary(input.id, 'processing-tasks'),
      getTaskSummary(input.id, 'verifying-tasks'),
      getTaskSummary(input.id, 'finished-tasks'),
    ])
    if (inProcessing) {
      await markTaskStatus(input.id, 'processing-tasks', { status: 'paused', executorTaskId: null })
      emitTaskFactoryEvent('paused', { id: input.id })
      return { data: { output: `Task paused: ${input.id} (${inProcessing.title}) in processing-tasks (executorTaskId cleared)` } }
    }
    if (inVerifying) {
      await markTaskStatus(input.id, 'verifying-tasks', { status: 'paused', executorTaskId: null })
      emitTaskFactoryEvent('paused', { id: input.id })
      return { data: { output: `Task paused: ${input.id} (${inVerifying.title}) in verifying-tasks (executorTaskId cleared)` } }
    }
    const bucket = inQueue ? 'queue-tasks' : inFinished ? 'finished-tasks' : '(not found)'
    const status = inQueue ? 'queued' : inFinished ? 'done' : 'unknown'
    throw new Error(`task ${input.id} cannot be paused (current state: bucket=${bucket}, status=${status})`)
  },
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksPause',
})

const GET_DESC = 'Read a Task Factory task\'s structured metadata + content files. ' +
  'Returns TaskSummary (id / title / status / agent / verifierAgent / cwd / description / createdAt / ' +
  // zai patch (2026-09-02, priority + dependsOn 字段):
  'startedAt / completedAt / executorTaskId / verifierTaskId / priority / dependsOn / mode / bucket) plus the full text of docs/spec.md, docs/plan.md, ' +
  'process.md, docs/verification.md. ' +
  // zai patch (2026-09-04, quick-intake):quick 任务不生成 plan.md / brainstorm.md,
  // spec.md 只是 title/description/priority/cwd 快照;读取返回空字符串属正常,
  // 调用方按 mode 分流决定是否读取 plan.md / brainstorm.md。
  '`mode` is "quick"|"full" (defaults to "full"). For quick tasks, plan.md / brainstorm.md do NOT exist and will be returned as empty strings — that is expected, not an error. ' +
  'Use this BEFORE dispatching the executor (so you can extract `agent` and `cwd` for SpawnAgent and `verifierAgent` for the verification round). ' +
  'Use this AFTER the executor completes to re-read `process.md` and confirm "## [DONE]" before moving to verifying. ' +
  'Use this in the verification round to read `docs/spec.md` (acceptance criteria) and the latest verification.md round. ' +
  'Use this to check a task\'s `dependsOn` array before dispatching — every id must have status=done (otherwise the task stays queued). ' +
  'Errors: "task <id> not found" — verify with getTaskSummary or ListTasks. ' +
  'NOTE: do NOT Read <task_dir>/task.yaml directly — SuperTasksGet is the SOLE read path for task metadata; ' +
  'task.yaml is a YAML file and bypassing this tool risks inconsistent schema.'

export const superTasksGetTool = buildTool({
  name: 'SuperTasksGet',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async description() { return GET_DESC },
  async prompt() { return GET_DESC },
  get inputSchema() {
    return z.object({
      id: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4'),
    })
  },
  async call(input: { id: string }) {
    const details = await getTaskDetails(input.id)
    if (!details) throw new Error(`task ${input.id} not found`)
    // 结构化 JSON 输出(调度官拿来按字段取值),同时给一段人读摘要方便回看。
    const output = JSON.stringify({
      summary: details.summary,
      specMd: details.specMd,
      planMd: details.planMd,
      processMd: details.processMd,
      verificationMd: details.verificationMd,
    }, null, 2)
    return { data: { output, structured: { summary: details.summary, specMd: details.specMd, planMd: details.planMd, processMd: details.processMd, verificationMd: details.verificationMd } } }
  },
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksGet',
})

export const superTasksListTool = buildTool({
  name: 'SuperTasksList',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async description() { return LIST_DESC },
  async prompt() { return LIST_DESC },
  get inputSchema() {
    // 故意设为空对象 —— list 任务没有任何入参(bucket 过滤由调用方读完四个数组自行筛选,避免实现泄漏)。
    return z.object({})
  },
  async call() {
    const buckets = await listTasks()
    // 输出 JSON 字符串方便 model 解析;同时给一个简短的人读摘要(各桶计数)帮助回看。
    const counts = {
      queue: buckets.queue.length,
      processing: buckets.processing.length,
      verifying: buckets.verifying.length,
      finished: buckets.finished.length,
    }
    const output = JSON.stringify({ buckets, counts }, null, 2)
    return { data: { output, structured: { buckets, counts } } }
  },
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksList',
})

// ---------------------------------------------------------------------------
// CreateWorktree (zai patch 2026-09-03): 并行任务同仓库冲突隔离。
// 任务调度官检测到多个可派发任务共享同一 repo 时,为每个任务建独立 git worktree
// (~/.zai/task-factory/worktrees/<taskId>/,分支 task-<taskId>),再以
// cwd=<worktreePath> 派发 executor;验证 PASS 后任务调度官在原始仓库合回分支并
// 移除 worktree。路径按 taskId 确定性生成,调度官会话重启后可重建。
// ---------------------------------------------------------------------------

const CREATE_WORKTREE_DESC =
  'Create an isolated git worktree for Task Factory work so parallel executors on the SAME repository do not conflict. ' +
  'Runs `git worktree add <path> -b <branch> [baseRef]` in the source repo; when the branch already exists, falls back to checking it out (`git worktree add <path> <branch>`). ' +
  'Modes: ' +
  '(1) TASK mode (defaults): branch=task-<taskId>, path=~/.zai/task-factory/worktrees/<taskId>/ — one executor workspace per conflicting task; deterministic path — safe to re-call after a supervisor restart, and an existing worktree is returned as-is (FAIL-retry reuse). ' +
  '(2) INTEGRATION mode (verification lane): branch="integration-main" (create from the repo main branch via baseRef on first use), slot="integration-<repoDirName>" — one shared worktree per repo where accepted task branches are merged for verification. ' +
  'Task branches NEVER merge into the repo base branch from here — feature/bugfix branches land via PR review created by the user. ' +
  'Use BEFORE SpawnAgent when the dispatch batch contains two or more tasks sharing the same repo cwd: dispatch those executors with cwd=<worktreePath> instead of the original repo path. ' +
  'On task FAIL the supervisor reverts the integration lane (git reset --hard to the pre-merge sha recorded in process.md) so a broken branch never persists in integration-main; on PASS the branch stays in integration-main and keeps the task worktree/branch for PR.'

export const createWorktreeTool = buildTool({
  name: 'CreateWorktree',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return CREATE_WORKTREE_DESC },
  async prompt() { return CREATE_WORKTREE_DESC },
  get inputSchema() {
    return z.object({
      taskId: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4 — drives default branch (task-<taskId>) and path slot (<taskId>)'),
      repoPath: z.string().min(1).describe('Absolute path of the repository the task belongs to (the task cwd)'),
      baseRef: z.string().optional().describe('Git ref to branch from when CREATING a new branch (default: current HEAD; pass the repo main branch for integration-main on first creation)'),
      branch: z.string().optional().describe('Branch to create/check out (default task-<taskId>). Integration verification passes "integration-main".'),
      slot: z.string().optional().describe('Worktree path segment under ~/.zai/task-factory/worktrees/ (default <taskId>). Integration verification uses a per-repo segment like "integration-<repoDirName>" so multiple repos keep separate integration worktrees.'),
    })
  },
  async call(input: { taskId: string; repoPath: string; baseRef?: string; branch?: string; slot?: string }) {
    const { taskId, repoPath } = input
    const branch = input.branch && input.branch.length > 0 ? input.branch : `task-${taskId}`
    const slot = input.slot && input.slot.length > 0 ? input.slot : taskId
    const worktreePath = join(taskFactoryRoot(), 'worktrees', slot)
    if (existsSync(join(worktreePath, '.git'))) {
      return {
        data: {
          output: `Worktree already exists (reusing): repo=${repoPath} branch=${branch} path=${worktreePath}`,
          structured: { worktreePath, branch, reused: true },
        },
      }
    }
    await mkdir(join(taskFactoryRoot(), 'worktrees'), { recursive: true })
    const gitErr = (err: unknown) => err instanceof Error
      ? `${err.message}${(err as { stderr?: string }).stderr ? `\n${(err as { stderr: string }).stderr}` : ''}`
      : String(err)
    try {
      try {
        const args = ['worktree', 'add', worktreePath, '-b', branch]
        if (input.baseRef && input.baseRef.length > 0) args.push(input.baseRef)
        await execFileAsync('git', ['-C', repoPath, ...args])
      } catch (err) {
        const msg = gitErr(err)
        // 分支已存在(上轮建过 / integration-main 已在仓库):退化为 checkout 既有分支。
        if (!/already exists|already checked out/i.test(msg)) {
          throw new Error(`git worktree add failed for ${repoPath} (branch ${branch}): ${msg}`)
        }
        await execFileAsync('git', ['-C', repoPath, 'worktree', 'add', worktreePath, branch])
      }
    } catch (err) {
      throw new Error(`CreateWorktree failed: ${gitErr(err)}`)
    }
    return {
      data: {
        output: `Worktree ready: repo=${repoPath} branch=${branch} path=${worktreePath}`,
        structured: { worktreePath, branch, reused: false },
      },
    }
  },
  mapToolResultToToolResultBlockParam(content: { output: string }, toolUseID: string) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: content.output }],
    }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'CreateWorktree',
})