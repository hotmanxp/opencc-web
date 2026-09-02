import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import {
  createPoolTask, getTaskSummary, moveTask, emitTaskFactoryEvent, taskFactoryRoot, taskDir,
} from './taskFactoryFiles.js'

const CREATE_DESC = 'Create a Task Factory task: initializes index.md, docs/spec.md, docs/plan.md, process.md under ~/.zai/task-factory/queue-tasks/<id>/. ' +
  'Call only after the requirements have been discussed with the user; title and cwd are required, agent is the executor subagent name (default "default"), spec/plan are the discussed content (optional; can still be filled in later via Edit). ' +
  'verifierAgent is the optional verification subagent name; when omitted, the task inherits the executor agent. The verifier subagent runs after the executor finishes and independently judges PASS/FAIL by reading docs/spec.md + docs/process.md.'

const MARK_DESC = 'Accept a completed task: moves processing-tasks/<id> to finished-tasks/<id> and sets status: done. ' +
  'Call only after the verifier subagent has reported PASS (or the user has explicitly forced acceptance via the verifying lane).'

const VERIFY_DESC = 'Move a processing task into the verifying lane so a verification subagent can judge its deliverables. ' +
  'The task must currently be in processing-tasks with status=processing (calling this from paused or verifying is illegal and will throw). ' +
  'Behavior: (1) read verifierAgent (input override > index.md field > task agent), (2) compute the next verification round N = existing ## 轮次 N sections in docs/verification.md + 1 (no file → 1), ' +
  '(3) write a new "## 轮次 N" header into docs/verification.md with timestamp and the round target, ' +
  '(4) moveTask(id, processing-tasks → verifying-tasks) which sets status=verifying, ' +
  '(5) return verifierAgent and cwd so the caller (the supervisor agent) can SpawnAgent the verifier subagent with subagent_type=verifierAgent, cwd=task.cwd, prompt asking it to append "结论: PASS|FAIL\n原因: ..." to docs/verification.md under the current round header. ' +
  'After SpawnAgent returns, the supervisor reads verification.md, parses the conclusion, then either calls SuperTasksMarkDone (PASS) or resumes the task with the feedback path (FAIL, round < 3) or pauses the task (FAIL, round == 3).'

export const superTasksCreateTool = buildTool({
  name: 'SuperTasksCreate',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return CREATE_DESC },
  async prompt() { return CREATE_DESC },
  get inputSchema() {
    return z.object({
      title: z.string().min(1).describe('Task title (the title field in index.md)'),
      cwd: z.string().min(1).describe('Absolute path of the project directory the task belongs to (working directory of the executor subagent; different tasks may live in different code projects)'),
      description: z.string().optional().describe('One-sentence task goal description'),
      agent: z.string().optional().describe('Executor subagent name, defaults to "default"'),
      verifierAgent: z.string().optional().describe('Verification subagent name, defaults to the executor agent. The verifier independently judges PASS/FAIL by reading docs/spec.md + docs/process.md after the executor finishes.'),
      spec: z.string().optional().describe('The discussed requirement spec (markdown)'),
      plan: z.string().optional().describe('The discussed execution plan (markdown)'),
    })
  },
  async call(input: { title: string; cwd: string; description?: string; agent?: string; verifierAgent?: string; spec?: string; plan?: string }) {
    const s = await createPoolTask(input)
    emitTaskFactoryEvent('created', { id: s.id })
    return { data: { output: `Task created: ${s.id}\n${s.title}\nProject cwd: ${input.cwd}\nStorage dir: ${join(taskFactoryRoot(), 'queue-tasks', s.id)}\nNext step: persist the discussed results into docs/spec.md and docs/plan.md; before dispatching the executor subagent, read index.md to confirm the agent field.` } }
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

export const superTasksMarkDoneTool = buildTool({
  name: 'SuperTasksMarkDone',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  async description() { return MARK_DESC },
  async prompt() { return MARK_DESC },
  get inputSchema() {
    return z.object({ id: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4') })
  },
  async call(input: { id: string }) {
    // 接受 processing-tasks(主动验收)/ verifying-tasks(强制通过,跳过 verifier 直接归档)。
    // queue/finished/不存在 → 抛错。
    const inProcessing = await getTaskSummary(input.id, 'processing-tasks')
    const inVerifying = await getTaskSummary(input.id, 'verifying-tasks')
    const summary = inProcessing ?? inVerifying
    if (!summary) {
      const anywhere = await getTaskSummary(input.id)
      throw new Error(anywhere
        ? `task ${input.id} is not in processing-tasks/verifying-tasks (current bucket: ${anywhere.bucket}), acceptance rejected`
        : `task ${input.id} not found`)
    }
    const from = summary.bucket
    const done = await moveTask(input.id, from, 'finished-tasks')
    emitTaskFactoryEvent('finished', { id: done.id })
    return { data: { output: `Task done: ${done.id} (${done.title}) moved to finished-tasks (forced from ${from})` } }
  },
  // 同 SuperTasksCreate:runtime 序列化 tool_result 必需(2026-09-02 补)。
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
  userFacingName: () => 'SuperTasksMarkDone',
})

/**
 * 读取 docs/verification.md 中已有的 `## 轮次 N` 段数,决定下一轮序号。
 * 文件不存在 / 没有段 → 1。
 */
async function nextVerificationRound(dir: string): Promise<number> {
  const file = join(dir, 'docs', 'verification.md')
  if (!existsSync(file)) return 1
  const text = await readFile(file, 'utf-8')
  const matches = text.match(/^## 轮次 \d+/gm)
  return (matches?.length ?? 0) + 1
}

export const superTasksVerifyTool = buildTool({
  name: 'SuperTasksVerify',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return VERIFY_DESC },
  async prompt() { return VERIFY_DESC },
  get inputSchema() {
    return z.object({
      id: z.string().min(4).describe('Task id, e.g. tf-a1b2c3d4'),
      verifierAgent: z.string().optional().describe('Optional verifier subagent name override (defaults to index.md verifierAgent field, then task agent)'),
    })
  },
  async call(input: { id: string; verifierAgent?: string }) {
    // 严格状态:仅 processing + status=processing 接受。从 paused/verifying 起验证是非法状态。
    const summary = await getTaskSummary(input.id, 'processing-tasks')
    if (!summary) {
      const anywhere = await getTaskSummary(input.id)
      throw new Error(anywhere
        ? `task ${input.id} is not in processing-tasks (current bucket: ${anywhere.bucket}, status: ${anywhere.status}), verification rejected`
        : `task ${input.id} not found`)
    }
    if (summary.status !== 'processing') {
      throw new Error(`task ${input.id} status=${summary.status} (must be "processing" to enter verification), rejected`)
    }

    const verifierAgent = input.verifierAgent ?? summary.verifierAgent ?? summary.agent ?? null
    const dir = taskDir('processing-tasks', input.id)
    await mkdir(join(dir, 'docs'), { recursive: true })
    const round = await nextVerificationRound(dir)
    const header = [
      `## 轮次 ${round}`,
      '',
      `- 时间戳: ${new Date().toISOString()}`,
      `- 验证目标: ${summary.title}`,
      `- 验证 agent: ${verifierAgent ?? '(fallback to task agent)'}`,
      '',
    ].join('\n')
    const file = join(dir, 'docs', 'verification.md')
    if (!existsSync(file)) {
      await appendFile(file, '# 验证记录\n\n', 'utf-8')
    }
    await appendFile(file, header, 'utf-8')

    const moved = await moveTask(input.id, 'processing-tasks', 'verifying-tasks')
    emitTaskFactoryEvent('verifying', { id: moved.id, round, verifierAgent })

    return {
      data: {
        output:
          `Task verifying: ${moved.id} (${moved.title}) moved to verifying-tasks\n` +
          `Round: ${round}\n` +
          `Verifier agent: ${verifierAgent ?? '(fallback to task agent)'}\n` +
          `Cwd: ${moved.cwd}\n` +
          `Storage dir: ${taskDir('verifying-tasks', moved.id)}\n` +
          `Verification log: ${join(taskDir('verifying-tasks', moved.id), 'docs', 'verification.md')}\n` +
          `Next step: the supervisor should SpawnAgent(subagent_type=verifierAgent, cwd=${moved.cwd}, ` +
          `prompt="Read ${taskDir('verifying-tasks', moved.id)}/docs/spec.md (acceptance criteria) and process.md (executor record), ` +
          `then append your conclusion to docs/verification.md under the current round header in the exact format: ` +
          `'结论: PASS|FAIL\\n原因: ...'. After the verifier subagent completes, read verification.md and decide: ` +
          `PASS → call SuperTasksMarkDone; FAIL with round < 3 → resume the task with feedback path; ` +
          `FAIL with round == 3 → pause the task for human decision.`,
      },
    }
  },
  // 同 SuperTasksCreate:runtime 序列化 tool_result 必需。
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
  userFacingName: () => 'SuperTasksVerify',
})