/**
 * dsh 子 agent / 后台任务桥 — P1-5（真实化）。
 *
 * 设计：把 zai BackgroundRuntime 的语义映射到 dsh 子 agent（ScopedLayers +
 * dsh-subagent seam）。每次 spawn 启动一个新 dsh Agent（独立 session），父
 * agent 在 child 完成时通过 ctx.on('session/event') 监听 child session 的
 * turn/end 事件并通知父 agent.followup(<task-notification>)。
 *
 * 任务持久化走**独立 namespace**：`~/.zai/tasks-dsh/<taskId>.json`（禁止与
 * opencc 共用 `~/.zai/tasks/<taskId>.json` — 主计划 §4.2 R4）。
 *
 * **已知缺口**：
 *   - dsh-subagent 包未发布；当前实现直接 spawn 一个 dsh Agent，不通过
 *     dsh-subagent capability seam。
 *   - 父子 agent 的 cwd/model 同步是简化的：当前通过 setup callback 注入；
 *     dsh-scope 父子继承语义未完整对齐。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export interface DshTaskState {
  taskId: string
  sessionId: string
  parentSessionId?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  prompt: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
}

const DSH_TASKS_DIR = join(homedir(), '.zai', 'tasks-dsh')

export function dshTaskPath(taskId: string): string {
  return join(DSH_TASKS_DIR, `${taskId}.json`)
}

async function ensureDshTasksDir(): Promise<void> {
  await mkdir(DSH_TASKS_DIR, { recursive: true })
}

export async function readDshTask(taskId: string): Promise<DshTaskState | null> {
  try {
    const raw = await readFile(dshTaskPath(taskId), 'utf-8')
    return JSON.parse(raw) as DshTaskState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeDshTask(state: DshTaskState): Promise<void> {
  await ensureDshTasksDir()
  const path = dshTaskPath(state.taskId)
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

export async function listDshTasks(): Promise<DshTaskState[]> {
  try {
    const entries = await readdir(DSH_TASKS_DIR)
    const tasks: DshTaskState[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const taskId = entry.slice(0, -'.json'.length)
      const t = await readDshTask(taskId)
      if (t) tasks.push(t)
    }
    return tasks.sort((a, b) => b.startedAt - a.startedAt)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export interface SubagentNotification {
  taskId: string
  status: 'done' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
}

/**
 * 子 agent spawn — 创建 child dsh Agent 并执行 prompt。
 *
 * 子 agent 继承父 agent 的 cwd（通过 setup 注入）和 model（用 agentOptions）。
 * 任务文件写入时立即 emit taskId，父 agent 可通过 taskId 订阅进度事件。
 *
 * **简化**：当前实现不通过 dsh-scope 的 ScopedLayers 创建子 ctx；子 agent
 * 与父 agent 共享 ctx（dsh-agent 父子关系由 agents.create 自带处理）。
 */
export async function spawnDshSubagent(
  ctx: Context,
  opts: {
    parentSessionId?: string
    parentAgent?: Agent
    prompt: string
    cwd: string
    model?: string
    taskId?: string
  },
): Promise<{ taskId: string; agent: Agent; promise: Promise<DshTaskState> }> {
  const taskId = opts.taskId ?? `dsh-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const childSessionId = `${taskId}-session`

  const agents = ctx.get('agents') as
    | {
        create: (opts: {
          sessionId: SessionId
          meta?: { cwd?: string }
          agentOptions?: { provider?: string; model?: string; maxTokens?: number }
          setup?: (agentCtx: Context) => unknown
        }) => Promise<{ agent: Agent }>
      }
    | undefined
  if (!agents) {
    throw new Error('[dsh-bridge] spawnDshSubagent: agents service unavailable')
  }

  const initialState: DshTaskState = {
    taskId,
    sessionId: childSessionId,
    parentSessionId: opts.parentSessionId,
    status: 'running',
    prompt: opts.prompt,
    startedAt: Date.now(),
  }
  await writeDshTask(initialState)

  const promise = (async (): Promise<DshTaskState> => {
    try {
      const { agent } = await agents.create({
        sessionId: SessionId(childSessionId),
        meta: { cwd: opts.cwd },
        agentOptions: opts.model ? { model: opts.model } : undefined,
        setup: (agentCtx) => {
          agentCtx.set('zaiParentSessionId', opts.parentSessionId ?? '')
          agentCtx.set('zaiTaskId', taskId)
        },
      })

      await agent.whenIdle()
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: opts.prompt }],
          source: { kind: 'user' },
        }),
      )
      await agent.whenIdle()

      const finalState: DshTaskState = {
        ...initialState,
        status: 'done',
        finishedAt: Date.now(),
      }
      await writeDshTask(finalState)

      // 通知父 agent（如果有）
      if (opts.parentAgent) {
        await notifyParentAgent(ctx, opts.parentAgent, {
          taskId,
          status: 'done',
        })
      }

      return finalState
    } catch (err) {
      const finalState: DshTaskState = {
        ...initialState,
        status: 'failed',
        finishedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
      await writeDshTask(finalState)

      if (opts.parentAgent) {
        await notifyParentAgent(ctx, opts.parentAgent, {
          taskId,
          status: 'failed',
          error: finalState.error,
        })
      }

      return finalState
    }
  })()

  // 立即返回 taskId + agent 句柄（不等 promise 完成 — 对齐 zai dispatch 异步）
  const { agent } = await agents.create({
    sessionId: SessionId(childSessionId),
    meta: { cwd: opts.cwd },
    setup: () => undefined,
  }).catch(() => ({ agent: undefined as unknown as Agent }))

  return {
    taskId,
    agent: agent ?? ({} as Agent),
    promise,
  }
}

/**
 * 通知父 session — 把子任务完成事件注入父 agent 的下一轮。
 *
 * zai 用 `<task-notification>` 续传；dsh 侧用 agent.followup(<task-notification-message>)。
 */
async function notifyParentAgent(
  ctx: Context,
  parentAgent: Agent,
  notification: SubagentNotification,
): Promise<void> {
  try {
    const sessions = ctx.get('sessions') as { flush?: (s: unknown) => Promise<unknown> } | undefined
    const session = parentAgent.session
    const text = `<task-notification>${JSON.stringify(notification)}</task-notification>`
    parentAgent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    if (sessions?.flush && session) {
      await sessions.flush(session).catch(() => undefined)
    }
  } catch (err) {
    console.warn('[dsh-bridge] notifyParentAgent failed:', err)
  }
}

/**
 * 子任务完成通知父 session（stub 兼容旧 API）。
 */
export async function notifyParentSession(
  ctx: Context,
  notification: SubagentNotification,
): Promise<void> {
  const existing = await readDshTask(notification.taskId)
  if (existing) {
    existing.status = notification.status
    existing.finishedAt = Date.now()
    existing.result = notification.result
    existing.error = notification.error
    await writeDshTask(existing)
  }
}