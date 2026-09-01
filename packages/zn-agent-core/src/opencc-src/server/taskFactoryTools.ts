import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'
import {
  createPoolTask, getTaskSummary, moveTask, emitTaskFactoryEvent, taskFactoryRoot,
} from './taskFactoryFiles.js'

const CREATE_DESC = '创建任务工厂任务：在 ~/.zai/task-factory/queue-tasks/<id>/ 初始化 index.md、docs/spec.md、docs/plan.md、process.md。' +
  '需求与用户讨论清楚后调用；title 与 cwd 必填，agent 为执行子 Agent 用的 agent 名（默认 default），spec/plan 为已讨论出的内容（可选，落库后仍可用 Edit 补充）。'

const MARK_DESC = '验收任务完成：把 processing-tasks/<id> 移到 finished-tasks/<id> 并置 status: done。' +
  '仅在确认 process.md 末尾有 ## [DONE] 且成果核对无误后调用。'

export const superTasksCreateTool = buildTool({
  name: 'SuperTasksCreate',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async description() { return CREATE_DESC },
  async prompt() { return CREATE_DESC },
  get inputSchema() {
    return z.object({
      title: z.string().min(1).describe('任务标题（index.md 的 title）'),
      cwd: z.string().min(1).describe('任务所在工程目录的绝对路径（执行子 Agent 的工作目录；不同任务可落在不同代码工程）'),
      description: z.string().optional().describe('一句任务目标描述'),
      agent: z.string().optional().describe('执行子 Agent 的 agent 名，默认 default'),
      spec: z.string().optional().describe('已讨论的需求规格 markdown'),
      plan: z.string().optional().describe('已讨论的执行计划 markdown'),
    })
  },
  async call(input: { title: string; cwd: string; description?: string; agent?: string; spec?: string; plan?: string }) {
    const s = await createPoolTask(input)
    emitTaskFactoryEvent('created', { id: s.id })
    return { data: { output: `Task created: ${s.id}\n${s.title}\n工程目录: ${input.cwd}\n存放目录: ${join(taskFactoryRoot(), 'queue-tasks', s.id)}\n下一步：把 docs/spec.md、docs/plan.md 讨论结果落库；派发执行子 Agent 前先读 index.md 确认 agent 字段。` } }
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
    return z.object({ id: z.string().min(4).describe('任务 id，如 tf-a1b2c3d4') })
  },
  async call(input: { id: string }) {
    const inProcessing = await getTaskSummary(input.id, 'processing-tasks')
    if (!inProcessing) {
      // 明确只接受 processing 状态（测试第二段断言此错误）
      const anywhere = await getTaskSummary(input.id)
      throw new Error(anywhere
        ? `task ${input.id} 不在 processing-tasks（当前 ${anywhere.bucket}），拒绝验收`
        : `task ${input.id} not found`)
    }
    const done = await moveTask(input.id, 'processing-tasks', 'finished-tasks')
    emitTaskFactoryEvent('finished', { id: done.id })
    return { data: { output: `Task done: ${done.id}（${done.title}）已移至 finished-tasks` } }
  },
  renderToolUseMessage() { return null },
  renderToolResultMessage() { return null },
  toAutoClassifierInput() { return '' },
  checkPermissions(input) {
    return Promise.resolve({ behavior: 'allow' as const, updatedInput: input, decisionReason: { type: 'mode' as const, mode: 'bypassPermissions' as const } })
  },
  userFacingName: () => 'SuperTasksMarkDone',
})