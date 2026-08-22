/**
 * 子 agent / 后台任务桥 — B5 T5.1, T5.2。
 *
 * 设计要点：
 * - zai BackgroundRuntime 语义（后台任务启动、进度、结果回传）映射到 dsh
 *   ScopedLayers + dsh-subagent。
 * - 任务持久化走独立 namespace: ~/.zai/tasks-dsh/<taskId>.json（禁止与 opencc
 *   共享 ~/.zai/tasks/<taskId>.json — 主计划 §4.2 R4）。
 * - <task-notification> 续传父 session 的语义用 dsh `agent/...` 事件对齐。
 *
 * B5 当前为接口契约；具体 dsh-subagent seam 接线在 B5 T5.1 真实实现。
 */

import { join } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'

export interface DshTaskState {
  taskId: string
  sessionId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  prompt: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
}

/**
 * dsh 任务 namespace 路径（B0 T0.6 常量）。
 */
const DSH_TASKS_DIR = join(
  process.env.ZAI_DATA_DIR || join(require('node:os').homedir(), '.zai'),
  'tasks-dsh',
)

export function dshTaskPath(taskId: string): string {
  return join(DSH_TASKS_DIR, `${taskId}.json`)
}

/**
 * 读取 dsh 任务状态（独立 namespace，不读 opencc 任务文件）。
 */
export async function readDshTask(taskId: string): Promise<DshTaskState | null> {
  try {
    const raw = await readFile(dshTaskPath(taskId), 'utf-8')
    return JSON.parse(raw) as DshTaskState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * 写 dsh 任务状态（原子写）。
 */
export async function writeDshTask(state: DshTaskState): Promise<void> {
  const path = dshTaskPath(state.taskId)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

/**
 * 子任务完成通知父 session — B5 T5.5。
 */
export interface SubagentNotification {
  taskId: string
  status: 'done' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
}

export async function notifyParentSession(
  _ctx: unknown,
  notification: SubagentNotification,
): Promise<void> {
  // 真实实现走 dsh agent.followup(<task-notification>)。
  // 当前 stub：把通知写入任务文件，由父 session 的下次轮询读取。
  const existing = await readDshTask(notification.taskId)
  if (existing) {
    existing.status = notification.status
    existing.finishedAt = Date.now()
    existing.result = notification.result
    existing.error = notification.error
    await writeDshTask(existing)
  }
}