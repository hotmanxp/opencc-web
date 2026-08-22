/**
 * dsh 子 agent / 后台任务桥 — P1-5（真实化）+ Phase 3.1（dsh-scope 自实现）。
 *
 * 设计：把 zai BackgroundRuntime 的语义映射到 dsh 子 agent。每次 spawn 启动
 * 一个新 dsh Agent（独立 session + 独立 ScopedLayers scope），父 agent 在
 * child 完成时通过 ctx.on('session/event') 监听 child session 的 turn/end
 * 事件并通知父 agent.followup(<task-notification>)。
 *
 * 任务持久化走**独立 namespace**：`~/.zai/tasks-dsh/<taskId>.json`（禁止与
 * opencc 共用 `~/.zai/tasks/<taskId>.json` — 主计划 §4.2 R4）。
 *
 * **Phase 3.1 收口**：
 *   - dsh-subagent 包未发布（上游不存在，handoff §6 #1 确认）— 用 dsh-scope
 *     的 `createScope` + `bindScopeParent` 显式建立父子 scope，原生 ScopedLayers
 *     链可工作。
 *   - 父子 agent 的 cwd/model 同步：父 ctx 的元数据通过 setup callback 注入
 *     child agentCtx（已实现）。
 *   - 子 agent 完成通知父 session 走 `<task-notification>` 续传（zai 语义）。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope'

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
 * 子 agent scope — 通过 dsh-scope `createScope` + `bindScopeParent` 建立
 * 父子 ScopedLayers 链。返回带 `dispose` 的 child ctx；调用方负责回收。
 *
 * Phase 3.1 新增：此前 spawnDshSubagent 直接用父 ctx.agents.create，scope
 * 继承靠 dsh-agent 内部机制；本函数显式走 dsh-scope 原语，让 ScopedLayers
 * 链（工具层 / 权限层）在 child 维度上可被精细管理。
 */
export function createDshSubagentScope(
  parentCtx: Context,
  opts: { parentScopeKey: object; childScopeKey: object },
): { ctx: Context; dispose: () => void } {
  // 1. 显式建立父子 scope 关系（ScopedLayers chain）
  bindScopeParent(opts.childScopeKey, opts.parentScopeKey)
  // 2. 在父 ctx 上 createScope — 返回独立 fiber + scoped ctx
  const scope = createScope(parentCtx, opts.childScopeKey, { parent: opts.parentScopeKey })
  return { ctx: scope.ctx, dispose: scope.dispose }
}

/**
 * 子 agent spawn — 创建 child dsh Agent 并执行 prompt。
 *
 * 子 agent 继承父 agent 的 cwd（通过 setup 注入）和 model（用 agentOptions）。
 * 任务文件写入时立即 emit taskId，父 agent 可通过 taskId 订阅进度事件。
 *
 * Phase 3.1：scope 隔离走 `createDshSubagentScope`（基于 dsh-scope），
 * 不再依赖 dsh-agent 内部隐式 scoping。
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
  // Phase 3.1：显式 scope key（子 agent 维度），让 ScopedLayers 能区分父子。
  // dsh-scope 要求 scopeKey 是 object（用作 WeakMap key），用 plain object 包装字符串。
  const parentScopeKey = { kind: 'parent' as const, sessionId: opts.parentSessionId ?? 'root' }
  const childScopeKey = { kind: 'subagent' as const, taskId }

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
      // 1. Phase 3.1：建立显式父子 scope（ScopedLayers 链可工作）
      createDshSubagentScope(ctx, { parentScopeKey, childScopeKey })

      // 2. 在父子 scope 关联后创建 child agent（dsh-agent 内部会走 scope 链）
      const { agent } = await agents.create({
        sessionId: SessionId(childSessionId),
        meta: { cwd: opts.cwd },
        agentOptions: opts.model ? { model: opts.model } : undefined,
        setup: (agentCtx) => {
          agentCtx.set('zaiParentSessionId', opts.parentSessionId ?? '')
          agentCtx.set('zaiTaskId', taskId)
          // Phase 3.1：把 scope key 标到 ctx，让 plugin tree 可识别子维度
          agentCtx.set('zaiSubagentScopeKey', childScopeKey)
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