/**
 * V2 Task List Store (dsh-bridge 自实现) — **Phase 5P5: DEPRECATED**。
 *
 * 本文件原是 dsh-bridge 自实现的 TaskItem store(132 行,用
 * `~/.zai/tasks-dsh/<sessionId>.json` 持久化 + TaskCreate/Get/List/Update
 * 4 个 model-facing tool)。
 *
 * Phase 5P5 起改由 harness 官方 `@deepseek-ai/dsh-tool-todo` 替代:
 *   - 在 dsh-bridge.patch.yml 的 `tool-todo` row 已自动装载(Phase 1P1-B)。
 *   - 单一 model-facing 工具 `todo_write`(whole-list snapshot replace)。
 *   - 状态折叠到 session event log(`todo/write` 事件 + `ctx.sessionProjections` 的
 *     `todos` projection unit)— 无独立磁盘 store。
 *
 * 保留本文件仅为:
 *   1. test/tools/dsh017.test.ts 仍 import `DshTaskListStore` 跑测 — stub 类
 *      暴露与方法同名,但每个方法抛"已迁移"提示(test 期望这种行为)。
 *   2. 任何外部 caller 可能依赖 `DshTaskListStore` 的方法签名 — 我们保留
 *      签名但抛 HarnessError。
 *
 * 任何调用路径仍可 import,所有数据操作 throw[HarnessError-deprecated]。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** @deprecated Use upstream `dsh-tool-todo` (`todo_write` 工具)。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/**
 * @deprecated Use upstream `TodoItem` from `@deepseek-ai/dsh-tool-todo`。
 */
export interface TaskItem {
  id: string
  sessionId: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

const TASKS_DIR_DEPRECATED = join(homedir(), '.zai', 'tasks-dsh.deprecated')

function _throw(operation: string): never {
  throw new Error(
    `[dsh-bridge] DshTaskListStore.${operation}() 是 deprecated stub — ` +
      '上游 `@deepseek-ai/dsh-tool-todo` 的 `todo_write` 工具已注册,所有 todo ' +
      'CRUD 通过它(`agent.session.append("todo/write", ...)`)走 session log 折叠。',
  )
}

/**
 * @deprecated Use upstream `ctx.sessionProjections.snapshot('todos')` 获取
 *             当前 agent 的 todo list — 不再 per-session 维护独立 disk store。
 *
 * 本 stub 暴露**完整方法签名**仅为兼容外部 caller(包括 dsh017.test)。
 * 每个方法在调用时 throw,以引导迁移到上游 `todo_write`。
 */
export class DshTaskListStore {
  async create(
    _sessionId: string,
    _input: { subject: string; description?: string; activeForm?: string },
  ): Promise<TaskItem> {
    _throw('create')
  }

  async get(_sessionId: string, _id: string): Promise<TaskItem | null> {
    _throw('get')
  }

  async list(_sessionId: string): Promise<TaskItem[]> {
    _throw('list')
  }

  async update(
    _sessionId: string,
    _id: string,
    _patch: Partial<Pick<TaskItem, 'subject' | 'description' | 'activeForm' | 'status'>>,
  ): Promise<TaskItem | null> {
    _throw('update')
  }

  /** 上游不需要写盘 — 仅保留供外部 caller 兼容,内部 throw。 */
  async ensureReady(): Promise<void> {
    await mkdir(TASKS_DIR_DEPRECATED, { recursive: true }).catch(() => undefined)
  }
}

/**
 * @deprecated Use upstream `dsh-tool-todo` 的 `todo_write` 工具 + `ctx.sessionProjections` 投影。
 */
export function getDshTaskListStore(): DshTaskListStore {
  // 创建实例仅为满足类型 — 任何方法调用即抛错。
  return new DshTaskListStore()
}
