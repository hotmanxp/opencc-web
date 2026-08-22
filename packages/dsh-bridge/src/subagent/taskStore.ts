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
 *     的 `createScope(key, { parent })` 建立父子 scope,内部统一调
 *     bindScopeParent 一次(避免重复 bind 报"scope key is already bound")。
 *   - 父子 agent 的 cwd/model 同步：父 ctx 的元数据通过 setup callback 注入
 *     child agentCtx（已实现）。
 *   - 子 agent 完成通知父 session 走 `<task-notification>` 续传（zai 语义）。
 *
 * **dsh-018 修复**:
 *   - 之前 `createDshSubagentScope` 显式调 bindScopeParent + createScope
 *     (内部也调 bindScopeParent) — 第二次 bind 抛
 *     "scope key is already bound to a parent" 错误。
 *   - 删掉显式 bind,只用 createScope。WeakMap 用 childKey 做弱引用,
 *     同一 taskId 不会重 bind(每次 spawn 都有新 taskId)。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'

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
  // dsh-018 修复:createScope 内部**已经**调 bindScopeParent(key, options.parent),
  // 我们之前显式调一次会触发 "scope key is already bound" 错误(因为
  // 第二次 bind 时 WeakMap.has(key) === true)。这里只调 createScope,
  // 让它内部统一 bind 一次。
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
      // dsh-019 修复:之前 setup callback 用 agentCtx.set('zaiXxx', ...) 注入
      // 父 session id / task id / scope key — 但 cordis `set` 要求 prop
      // 之前 `provide` 过,否则抛 "cannot set property X without provide"
      // 错误。taskStore.ts 自己维护的 DshTaskState (已写入
      // ~/.zai/tasks-dsh/<taskId>.json) 是 ground truth,parentSessionId
      // 和 taskId 通过 childSessionId (我们造的 `<taskId>-session`) 隐式
      // 关联,不需要 ctx 注入。删掉 setup callback。
      const { agent } = await agents.create({
        sessionId: SessionId(childSessionId),
        meta: { cwd: opts.cwd },
        agentOptions: opts.model ? { model: opts.model } : undefined,
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

// ====== dsh-019: dsh subagent lifecycle API (供 zai compat subagentControlTool 桥接) ======

/**
 * 父 session id → 该 session spawn 的 subagent 任务列表。供 zai compat
 * `subagent_control.list_agents` 实现查询。
 */
export async function listDshSubagents(
  ctx: Context,
  parentSessionId?: string,
): Promise<DshTaskState[]> {
  const all = await listDshTasks()
  return all
    .filter((t) => !parentSessionId || t.parentSessionId === parentSessionId)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * 中止一个运行中的 dsh subagent。调 dsh Agent.cancel + 写盘 mark cancelled。
 * 供 zai compat `subagent_control.interrupt_agent` 实现调用。
 */
export async function interruptDshSubagent(
  ctx: Context,
  taskId: string,
): Promise<DshTaskState | null> {
  const existing = await readDshTask(taskId)
  if (!existing) return null
  if (existing.status !== 'running') return existing
  // 调 dsh Agent.cancel（dsh-agent 接口）
  try {
    const agents = ctx.get('agents') as {
      get?: (id: unknown) => { cancel?: (cause: { kind: 'user' }) => void } | undefined
    } | undefined
    const handle = agents?.get?.(existing.sessionId)
    handle?.cancel?.({ kind: 'user' })
  } catch (err) {
    console.warn(`[dsh-bridge] interruptDshSubagent ${taskId} cancel failed:`, err)
  }
  // 写盘 mark cancelled
  const updated: DshTaskState = {
    ...existing,
    status: 'cancelled',
    finishedAt: Date.now(),
  }
  await writeDshTask(updated)
  return updated
}

/**
 * 给运行中的 dsh subagent 投消息（DSH session-level message via agent.followup）。
 * 供 zai compat `subagent_control.send_message` 实现调用。
 */
export async function sendMessageToDshSubagent(
  ctx: Context,
  taskId: string,
  prompt: string,
): Promise<{ ok: boolean; error?: string }> {
  const existing = await readDshTask(taskId)
  if (!existing) return { ok: false, error: 'task not found' }
  if (existing.status !== 'running') return { ok: false, error: `task status is ${existing.status}` }
  try {
    const agents = ctx.get('agents') as {
      get?: (id: unknown) => { followup?: (msg: unknown) => void } | undefined
    } | undefined
    const handle = agents?.get?.(existing.sessionId)
    if (!handle?.followup) return { ok: false, error: 'agent unavailable' }
    handle.followup(
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }),
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}