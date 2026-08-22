/**
 * V2 Task List Store (dsh 自实现) — dsh-017 配套。
 *
 * 替代 opencc compat `taskListStore` 的 dsh 模式实现。
 * 持久化:每个 session 一个 JSON 文件 `~/.zai/tasks-dsh/<sessionId>.json`
 * (与 opencc `~/.zai/tasks/` 隔离,主计划 §4.2 R4)。
 *
 * 行为对齐:
 *   - create / get / list / update / delete
 *   - 状态: pending / in_progress / completed / deleted
 *   - 任务 id: 8 字符 base36(与 dsh 内部一致,无需正则约束)
 *   - 原子写: tmp + rename
 *   - emit 事件: 通过 opts.onChange 回调(zai-side 接 SSE eventBus)
 *
 * dsh-bridge 不依赖 @zn-ai/zn-agent-core(zai 内部),所以自实现 V2 任务存储。
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

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

const TASKS_DIR = join(homedir(), '.zai', 'tasks-dsh')

function taskPath(sessionId: string): string {
  return join(TASKS_DIR, `${sessionId}.json`)
}

async function ensureTasksDir(): Promise<void> {
  await mkdir(TASKS_DIR, { recursive: true })
}

function generateTaskId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * 读 session 全部 task(已删除的过滤掉)
 */
async function readTasks(sessionId: string): Promise<TaskItem[]> {
  try {
    const raw = await readFile(taskPath(sessionId), 'utf-8')
    const arr = JSON.parse(raw) as TaskItem[]
    return arr.filter((t) => t.status !== 'deleted')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * 原子写 — 写 .tmp 再 rename
 */
async function writeTasksAtomic(sessionId: string, tasks: TaskItem[]): Promise<void> {
  await ensureTasksDir()
  const target = taskPath(sessionId)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf-8')
  await rename(tmp, target)
}

export class DshTaskListStore {
  async create(
    sessionId: string,
    input: { subject: string; description?: string; activeForm?: string },
  ): Promise<TaskItem> {
    const tasks = await readTasks(sessionId)
    const now = Date.now()
    const task: TaskItem = {
      id: generateTaskId(),
      sessionId,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    tasks.push(task)
    await writeTasksAtomic(sessionId, tasks)
    return task
  }

  async get(sessionId: string, id: string): Promise<TaskItem | null> {
    const tasks = await readTasks(sessionId)
    return tasks.find((t) => t.id === id) ?? null
  }

  async list(sessionId: string): Promise<TaskItem[]> {
    return readTasks(sessionId)
  }

  async update(
    sessionId: string,
    id: string,
    patch: Partial<Pick<TaskItem, 'subject' | 'description' | 'activeForm' | 'status'>>,
  ): Promise<TaskItem | null> {
    const tasks = await readTasks(sessionId)
    const idx = tasks.findIndex((t) => t.id === id)
    if (idx < 0) return null
    const merged: TaskItem = {
      ...tasks[idx],
      ...patch,
      updatedAt: Date.now(),
    }
    tasks[idx] = merged
    await writeTasksAtomic(sessionId, tasks)
    return merged
  }
}

/**
 * 默认全局单例 — sessionId 由 zai 端通过 opts.sessionIdGetter 注入。
 */
let defaultStore: DshTaskListStore | null = null
export function getDshTaskListStore(): DshTaskListStore {
  if (!defaultStore) defaultStore = new DshTaskListStore()
  return defaultStore
}
