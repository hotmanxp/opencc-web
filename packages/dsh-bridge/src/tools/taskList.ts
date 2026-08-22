/**
 * Task* 工具集 — dsh 风格 (dsh-017)。
 *
 * 4 个工具: TaskCreate / TaskGet / TaskList / TaskUpdate。
 * 替代 opencc vendor 的 TaskCreateTool/TaskGetTool/TaskListTool/TaskUpdateTool
 * + opencc compat `taskTools` 集合 (zai compat 层有,但 dsh 模式不挂入)。
 *
 * 行为对齐 opencc compat `tasks/schemas.ts`:
 *   - TaskCreate: subject (1-200) + description (optional, max 2000) + activeForm (optional, max 80)
 *   - TaskGet: id
 *   - TaskUpdate: id + status (pending/in_progress/completed) + subject/description/activeForm (partial)
 *   - TaskList: 无参数,返回全部非删除任务
 *
 * 持久化走 dsh 自有 store (`tasks.ts`),路径 `~/.zai/tasks-dsh/<sessionId>.json`。
 * sessionId 由 zai-side 通过 opts.sessionIdGetter 注入(对齐 opencc compat 的 ctx.sessionId)。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { getDshTaskListStore, type TaskItem } from './tasks.js'

export interface TaskListToolOptions {
  /** 当前 sessionId — 工具执行时从 zai 端取。 */
  getSessionId: () => string | undefined
  /**
   * 任务变化 sink — zai 端接 SSE 推到 UI(zai compat 走 stateChangeBus.emit
   * 'v2_task.changed')。dsh 模式可以转发到 eventBus 同样的 topic。
   */
  onTaskChange?: (info: { sessionId: string; task: TaskItem; action: 'create' | 'update' }) => void
}

const SUBJECT_MAX = 200
const DESCRIPTION_MAX = 2000
const ACTIVEFORM_MAX = 80

/**
 * TaskCreate 工具。
 */
export function createTaskCreateTool(opts: TaskListToolOptions) {
  return defineTool({
    name: 'TaskCreate',
    description:
      "Create a new task in the current session's task list. Tasks track multi-step " +
      'work — use them to break down complex requests into trackable units. Returns the ' +
      'created task with assigned id. Persists to `~/.zai/tasks-dsh/<sessionId>.json`.',
    parameters: {
      subject: {
        type: 'string',
        description: `Short title of the task (1-${SUBJECT_MAX} chars).`,
        required: true,
      },
      description: {
        type: 'string',
        description: `Optional longer description (max ${DESCRIPTION_MAX} chars).`,
      },
      activeForm: {
        type: 'string',
        description: `Optional present-tense label shown when status is in_progress (e.g. "Implementing feature", max ${ACTIVEFORM_MAX} chars).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { output: { type: 'string' } },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { output: string }
        return [{ type: 'text', text: v.output }]
      },
    },
    async execute(args) {
      const a = args as { subject: string; description?: string; activeForm?: string }
      const sessionId = opts.getSessionId()
      if (!sessionId) {
        return { output: '[error] TaskCreate requires an active session (sessionId unavailable)' }
      }
      // 校验长度
      if (!a.subject || a.subject.length === 0 || a.subject.length > SUBJECT_MAX) {
        return { output: `[error] subject must be 1-${SUBJECT_MAX} chars, got ${a.subject?.length ?? 0}` }
      }
      if (a.description !== undefined && a.description.length > DESCRIPTION_MAX) {
        return { output: `[error] description must be <= ${DESCRIPTION_MAX} chars, got ${a.description.length}` }
      }
      if (a.activeForm !== undefined && a.activeForm.length > ACTIVEFORM_MAX) {
        return { output: `[error] activeForm must be <= ${ACTIVEFORM_MAX} chars, got ${a.activeForm.length}` }
      }
      const task = await getDshTaskListStore().create(sessionId, {
        subject: a.subject,
        description: a.description,
        activeForm: a.activeForm,
      })
      opts.onTaskChange?.({ sessionId, task, action: 'create' })
      return { output: JSON.stringify(task, null, 2) }
    },
  })
}

/**
 * TaskGet 工具。
 */
export function createTaskGetTool(opts: TaskListToolOptions) {
  return defineTool({
    name: 'TaskGet',
    description:
      'Retrieve a single task by id. Returns a "not found" error string if the task ' +
      "doesn't exist or belongs to another session.",
    parameters: {
      id: { type: 'string', description: 'Task ID returned by TaskCreate or TaskList.', required: true },
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' } }, additionalProperties: false },
      render(_a, value) { return [{ type: 'text', text: (value as { output: string }).output }] },
    },
    async execute(args) {
      const a = args as { id: string }
      const sessionId = opts.getSessionId()
      if (!sessionId) return { output: '[error] TaskGet requires an active session' }
      const task = await getDshTaskListStore().get(sessionId, a.id)
      if (!task) return { output: `[error] task not found: ${a.id}` }
      return { output: JSON.stringify(task, null, 2) }
    },
  })
}

/**
 * TaskList 工具。
 */
export function createTaskListTool(opts: TaskListToolOptions) {
  return defineTool({
    name: 'TaskList',
    description:
      "List all non-deleted tasks in the current session's task list. Returns a JSON " +
      'array of task objects. Use to review progress before deciding which task to work on next.',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' } }, additionalProperties: false },
      render(_a, value) { return [{ type: 'text', text: (value as { output: string }).output }] },
    },
    async execute() {
      const sessionId = opts.getSessionId()
      if (!sessionId) return { output: '[error] TaskList requires an active session' }
      const tasks = await getDshTaskListStore().list(sessionId)
      return { output: JSON.stringify(tasks, null, 2) }
    },
  })
}

/**
 * TaskUpdate 工具。
 */
export function createTaskUpdateTool(opts: TaskListToolOptions) {
  return defineTool({
    name: 'TaskUpdate',
    description:
      'Update an existing task by id. Supports partial patches (status / subject / ' +
      'description / activeForm). Persists to disk; emits v2_task.changed-like event for UI updates.',
    parameters: {
      id: { type: 'string', description: 'Task ID to update.', required: true },
      status: {
        type: 'string',
        description: 'New status: pending | in_progress | completed | deleted.',
      },
      subject: { type: 'string', description: `Replace subject (1-${SUBJECT_MAX} chars).` },
      description: { type: 'string', description: `Replace description (max ${DESCRIPTION_MAX} chars).` },
      activeForm: { type: 'string', description: `Replace activeForm (max ${ACTIVEFORM_MAX} chars).` },
    },
    output: {
      schema: { type: 'object', properties: { output: { type: 'string' } }, additionalProperties: false },
      render(_a, value) { return [{ type: 'text', text: (value as { output: string }).output }] },
    },
    async execute(args) {
      const a = args as {
        id: string
        status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
        subject?: string
        description?: string
        activeForm?: string
      }
      const sessionId = opts.getSessionId()
      if (!sessionId) return { output: '[error] TaskUpdate requires an active session' }
      const patch: Parameters<ReturnType<typeof getDshTaskListStore>['update']>[2] = {}
      if (a.status !== undefined) patch.status = a.status
      if (a.subject !== undefined) {
        if (a.subject.length === 0 || a.subject.length > SUBJECT_MAX) {
          return { output: `[error] subject must be 1-${SUBJECT_MAX} chars, got ${a.subject.length}` }
        }
        patch.subject = a.subject
      }
      if (a.description !== undefined) {
        if (a.description.length > DESCRIPTION_MAX) {
          return { output: `[error] description must be <= ${DESCRIPTION_MAX} chars, got ${a.description.length}` }
        }
        patch.description = a.description
      }
      if (a.activeForm !== undefined) {
        if (a.activeForm.length > ACTIVEFORM_MAX) {
          return { output: `[error] activeForm must be <= ${ACTIVEFORM_MAX} chars, got ${a.activeForm.length}` }
        }
        patch.activeForm = a.activeForm
      }
      const updated = await getDshTaskListStore().update(sessionId, a.id, patch)
      if (!updated) return { output: `[error] task not found: ${a.id}` }
      opts.onTaskChange?.({ sessionId, task: updated, action: 'update' })
      return { output: JSON.stringify(updated, null, 2) }
    },
  })
}

/**
 * 注册 4 个 Task 工具到 dsh ctx.tools,返回统一 disposer。
 */
export function registerTaskListTools(
  ctx: Context,
  opts: TaskListToolOptions,
): () => void {
  const tools = ctx.get('tools') as {
    register: (tool: ReturnType<typeof defineTool>) => () => void
  }
  if (!tools) {
    throw new Error('[dsh-bridge] registerTaskListTools: ctx.tools unavailable')
  }
  const d1 = tools.register(createTaskCreateTool(opts)) as () => void
  const d2 = tools.register(createTaskGetTool(opts)) as () => void
  const d3 = tools.register(createTaskListTool(opts)) as () => void
  const d4 = tools.register(createTaskUpdateTool(opts)) as () => void
  return () => {
    try { d1() } catch (err) { console.warn('[dsh-bridge] TaskCreate dispose:', err) }
    try { d2() } catch (err) { console.warn('[dsh-bridge] TaskGet dispose:', err) }
    try { d3() } catch (err) { console.warn('[dsh-bridge] TaskList dispose:', err) }
    try { d4() } catch (err) { console.warn('[dsh-bridge] TaskUpdate dispose:', err) }
  }
}
