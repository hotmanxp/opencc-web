/**
 * Task* 工具集 (`TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`)
 * — **Phase 5P5: DEPRECATED**。
 *
 * 本文件原是 dsh-bridge 自实现的 4 个独立 todo CRUD 工具(233 行)。
 *
 * Phase 5P5 起改由 harness 官方 `@deepseek-ai/dsh-tool-todo` 替代:
 *   - 单一 model-facing 工具 `todo_write`(whole-list snapshot)。
 *   - 写入路径:`agent.session.append('todo/write', { todos: TodoItem[] })`,
 *     state 折叠到 session event log。
 *   - 读取路径:`ctx.sessionProjections.snapshot('todos')` 读当前 agent 全局 list。
 *
 * 行为差异(zai UI 适配点):
 *   - 旧 API:每条 TaskCreate/TaskUpdate 独立事件,id 用 8-char base36 hex。
 *   - 上游 API:**无显式 id**(content 即 identity,set 去重)。Snapshot 用 SESSION 范围而非 per-task。
 *
 * zai-side TodoZone 通过 `stateBridge.emitV2TaskChanged(sid, task, action)` 与
 * 老 opcodes 兼容,源来自 `translateSessionEvent` 监听 `todo/write` session event
 * 翻译出 `state.v2_task.changed`(详见 `translate/sessionEvents.ts:179-189`,
 * 这个翻译已存在)。
 *
 * 保留本文件仅为:
 *   - test/tools/dsh017.test.ts 仍 import `createTaskXxxTool` 跑测 — stub 函数
 *     抛"HarnessError: 已迁移"提示。
 *   - zai-side 历史 caller(registry.ts 已不调,作为保留 export 不影响)。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskItem } from './tasks.js'

/** @deprecated Use upstream `todo_write` from `@deepseek-ai/dsh-tool-todo`。 */
export interface TaskListToolOptions {
  /** 当前 sessionId — 上游改用 `agent.session.append('todo/write', ...)` 自动捕获。 */
  getSessionId: () => string | undefined
  /** 暂保留字段 — 不再被调用(zai-side 通过 `v2_task.changed` 事件桥监听)。 */
  onTaskChange?: (info: { sessionId: string; task: TaskItem; action: 'create' | 'update' }) => void
}

function makeDeprecatedTool(name: string) {
  return defineTool({
    name,
    description:
      `[DEPRECATED stub] ${name} 已迁移到上游 @deepseek-ai/dsh-tool-todo 的 ` +
      '`todo_write` 工具(whole-list snapshot replace)。请改用 todo_write。',
    parameters: {
      _input: {
        type: 'object',
        description: 'ignored',
        additionalProperties: false,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { error: { type: 'string' } },
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value as { error: string }
        return [{ type: 'text', text: v.error }]
      },
    },
    async execute(_args) {
      throw new HarnessError(
        `[dsh-bridge] ${name} 已废弃。改用上游 todo_write 工具 ` +
          `(由 @deepseek-ai/dsh-tool-todo 在 dsh-bridge.patch.yml 自动装载)。`,
      )
    },
  })
}

/** Local harness error re-export — 仅作 stub 抛错使用。 */
class HarnessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}

/** @deprecated */
export function createTaskCreateTool(_opts: TaskListToolOptions) {
  return makeDeprecatedTool('TaskCreate')
}

/** @deprecated */
export function createTaskGetTool(_opts: TaskListToolOptions) {
  return makeDeprecatedTool('TaskGet')
}

/** @deprecated */
export function createTaskListTool(_opts: TaskListToolOptions) {
  return makeDeprecatedTool('TaskList')
}

/** @deprecated */
export function createTaskUpdateTool(_opts: TaskListToolOptions) {
  return makeDeprecatedTool('TaskUpdate')
}

/**
 * @deprecated Use upstream `dsh-tool-todo`(已在 dsh-bridge.patch.yml 装载)。
 *             本函数保留仅为不破坏 zai factory 的 `toolsDisposer = await registerZaiTools(...)`
 *             调用栈 — registry.ts 不再调用本函数。
 *             执行 no-op dispose,不做任何 todo 工具注册。
 */
export function registerTaskListTools(
  _ctx: Context,
  _opts: TaskListToolOptions,
): () => void {
  return () => undefined
}
