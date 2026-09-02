import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import {
  createPoolTask, getTaskSummary, moveTask, emitTaskFactoryEvent, taskFactoryRoot,
} from './taskFactoryFiles.js'

const CREATE_DESC = 'Create a Task Factory task: initializes index.md, docs/spec.md, docs/plan.md, process.md under ~/.zai/task-factory/queue-tasks/<id>/. ' +
  'Call only after the requirements have been discussed with the user; title and cwd are required, agent is the executor subagent name (default "default"), spec/plan are the discussed content (optional; can still be filled in later via Edit).'

const MARK_DESC = 'Accept a completed task: moves processing-tasks/<id> to finished-tasks/<id> and sets status: done. ' +
  'Call only after confirming process.md ends with ## [DONE] and the deliverables check out.'

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
      spec: z.string().optional().describe('The discussed requirement spec (markdown)'),
      plan: z.string().optional().describe('The discussed execution plan (markdown)'),
    })
  },
  async call(input: { title: string; cwd: string; description?: string; agent?: string; spec?: string; plan?: string }) {
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
    const inProcessing = await getTaskSummary(input.id, 'processing-tasks')
    if (!inProcessing) {
      // 明确只接受 processing 状态（测试第二段断言此错误）
      const anywhere = await getTaskSummary(input.id)
      throw new Error(anywhere
        ? `task ${input.id} is not in processing-tasks (current bucket: ${anywhere.bucket}), acceptance rejected`
        : `task ${input.id} not found`)
    }
    const done = await moveTask(input.id, 'processing-tasks', 'finished-tasks')
    emitTaskFactoryEvent('finished', { id: done.id })
    return { data: { output: `Task done: ${done.id} (${done.title}) moved to finished-tasks` } }
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