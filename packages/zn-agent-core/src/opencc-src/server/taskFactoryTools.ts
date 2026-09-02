import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import {
  createPoolTask, getTaskSummary, getTaskDetails, listTasks, moveTask, markTaskStatus, emitTaskFactoryEvent, taskFactoryRoot, taskDir,
} from './taskFactoryFiles.js'

const CREATE_DESC = 'Create a Task Factory task: initializes task.yaml, docs/spec.md, docs/plan.md, process.md under ~/.zai/task-factory/queue-tasks/<id>/. ' +
  'Call only after the requirements have been discussed with the user; title and cwd are required, agent is the executor subagent name (default "default"), spec/plan are the discussed content (optional; can still be filled in later via Edit). ' +
  'verifierAgent is the optional verification subagent name; when omitted, the task inherits the executor agent. The verifier subagent runs after the executor finishes and independently judges PASS/FAIL by reading docs/spec.md + docs/process.md. ' +
  // zai patch (2026-09-02, 任务工厂升级 priority + dependsOn):
  'priority is "P0"|"P1"|"P2"|"P3" (default "P2"; P0 most urgent); the supervisor dispatches queue-tasks in priority ASC + createdAt ASC order. ' +
  'dependsOn is a string[] of task ids that must reach status=done before this task can be dispatched (default []).'

const LIST_DESC = 'List all Task Factory tasks across the four lifecycle buckets. ' +
  'Returns a TaskBucket object: { queue: TaskSummary[], processing: TaskSummary[], verifying: TaskSummary[], finished: TaskSummary[] }. ' +
  'Each TaskSummary contains id / title / status / agent / verifierAgent / cwd / description / createdAt / ' +
  'startedAt / completedAt / executorTaskId / priority / dependsOn / bucket. ' +
  // zai patch (2026-09-02): 排序契约——priority ASC(P0 先)+ 同优先级 createdAt ASC。
  'Tasks within each bucket are sorted by priority ASC (P0 → P3) then createdAt ASC. ' +
  'Use this when you need an overview of the pipeline (queue length, processing in flight, recent failures) or ' +
  'when picking the next task to dispatch. Prefer this over enumerating SuperTasksGet calls. ' +
  'For a single task\'s full detail (spec.md / plan.md / process.md content), use SuperTasksGet(id) instead. ' +
  'NOTE: never Read task.yaml files directly — SuperTasksList / SuperTasksGet are the SOLE read paths.'

const MOVE_DESC = 'Move a Task Factory task between lifecycle buckets (queue-tasks / processing-tasks / verifying-tasks / finished-tasks) with optional executorTaskId backfill. ' +
  'Use this as the SOLE write path for task state changes — do NOT edit task.yaml by hand. ' +
  'Typical flows: ' +
  '(a) SuperTasksMove(id, "queue-tasks", "processing-tasks", executorTaskId=<subagent>) on dispatch — atomically moves the folder, sets status=processing, and backfills executorTaskId; ' +
  '(b) SuperTasksMove(id, "processing-tasks", "verifying-tasks") after the executor appends "## [DONE]" to process.md; ' +
  '(c) SuperTasksMove(id, "verifying-tasks", "finished-tasks") on verifier PASS or forced accept; ' +
  '(d) SuperTasksMove(id, "processing-tasks", "finished-tasks") on forced accept from the processing lane; ' +
  '(e) SuperTasksMove(id, "processing-tasks", "queue-tasks") to roll back a failed SpawnAgent dispatch. ' +
  'Errors: "task <id> not found in <from>" (id absent in the named source bucket — verify with getTaskSummary or ListTasks); ' +
  '"task <id> already exists in <to>" (target bucket already has a folder with this id — concurrent collision). ' +
  'When executorTaskId is provided non-empty, the task.yaml is patched in place BEFORE the folder rename so the bucket move and the field write are committed atomically (no separate Edit race).'

const RESET_DESC = 'Reset a Task Factory task back to the runnable state for retry. ' +
  'Auto-detects the current bucket (no `from` argument needed): ' +
  '(a) task in verifying-tasks → folder moves back to processing-tasks AND status is forced to "processing" with executorTaskId cleared; ' +
  '(b) task in processing-tasks with status="paused" → folder stays in processing-tasks, status forced back to "processing" with executorTaskId cleared (no bucket move); ' +
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
    })
  },
  async call(input: {
    title: string; cwd: string; description?: string; agent?: string; verifierAgent?: string; spec?: string; plan?: string
    priority?: 'P0' | 'P1' | 'P2' | 'P3'; dependsOn?: string[]
  }) {
    const s = await createPoolTask(input)
    emitTaskFactoryEvent('created', { id: s.id })
    const meta = `priority=${s.priority ?? 'P2'}${input.dependsOn?.length ? `, dependsOn=[${input.dependsOn.join(', ')}]` : ''}`
    return { data: { output: `Task created: ${s.id}\n${s.title}\nProject cwd: ${input.cwd}\nStorage dir: ${join(taskFactoryRoot(), 'queue-tasks', s.id)}\n${meta}\nNext step: persist the discussed results into docs/spec.md and docs/plan.md; before dispatching the executor subagent, read task.yaml to confirm the agent field.` } }
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
      executorTaskId: z.string().optional().describe('Optional subagent task id to backfill into task.yaml (atomic with the bucket move; typically the id returned by SpawnAgent)'),
    })
  },
  async call(input: { id: string; from: 'queue-tasks' | 'processing-tasks' | 'verifying-tasks' | 'finished-tasks'; to: 'queue-tasks' | 'processing-tasks' | 'verifying-tasks' | 'finished-tasks'; executorTaskId?: string }) {
    const summary = await getTaskSummary(input.id, input.from)
    if (!summary) {
      throw new Error(`task ${input.id} not found in ${input.from}`)
    }
    if (existsSync(taskDir(input.to, input.id))) {
      throw new Error(`task ${input.id} already exists in ${input.to}`)
    }
    if (input.executorTaskId && input.executorTaskId.length > 0) {
      await markTaskStatus(input.id, input.from, { executorTaskId: input.executorTaskId })
    }
    const moved = await moveTask(input.id, input.from, input.to)
    emitTaskFactoryEvent('moved', { id: moved.id, from: input.from, to: input.to })
    const extra = input.executorTaskId ? ` (executorTaskId=${input.executorTaskId})` : ''
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
      await markTaskStatus(input.id, 'processing-tasks', { status: 'processing', executorTaskId: null })
      emitTaskFactoryEvent('reset', { id: input.id })
      return { data: { output: `Task reset: ${input.id} (${moved.title}) → processing-tasks/status=processing (executorTaskId cleared)` } }
    }
    if (inProcessing && inProcessing.status === 'paused') {
      await markTaskStatus(input.id, 'processing-tasks', { status: 'processing', executorTaskId: null })
      emitTaskFactoryEvent('reset', { id: input.id })
      return { data: { output: `Task reset: ${input.id} (${inProcessing.title}) → processing-tasks/status=processing (executorTaskId cleared)` } }
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
  'startedAt / completedAt / executorTaskId / priority / dependsOn / bucket) plus the full text of docs/spec.md, docs/plan.md, ' +
  'process.md. ' +
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
    // 结构化 JSON 输出(主管拿来按字段取值),同时给一段人读摘要方便回看。
    const output = JSON.stringify({
      summary: details.summary,
      specMd: details.specMd,
      planMd: details.planMd,
      processMd: details.processMd,
    }, null, 2)
    return { data: { output, structured: { summary: details.summary, specMd: details.specMd, planMd: details.planMd, processMd: details.processMd } } }
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