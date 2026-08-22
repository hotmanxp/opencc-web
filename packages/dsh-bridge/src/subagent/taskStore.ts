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

/**
 * 子 agent 工具调用条目 — Phase 3 P0-A。
 *
 * 记录 subagent 自己的 session 中每个 tool/call + tool/result 事件对。
 * 写入 ~/.zai/tasks-dsh/<taskId>.json 的 `toolCalls` 字段,SubagentDetailDrawer
 * 渲染此字段给用户看(subagent 内部跑了哪些工具、各自的输入/输出)。
 *
 * 设计原则:
 *   - 用 `callId` 作为关联 key,tool/call 与 tool/result 一一对应。
 *   - tool/call 来了立即 push(running);tool/result 来了 update。
 *   - error 字段:从 SessionEvent 'tool/result' 的 `error: { name, code }` 取,
 *     透传给前端展示(错误工具 → 红色 badge)。
 *   - input/output 保留 raw 形态(模型给的 JSON 字符串 / dsh-side 工具的
 *     ToolResultMessage);前端按需 formatToolInput 渲染。
 */
export interface ToolCallEntry {
  callId: string
  toolName: string
  input: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
  ts: number
  durationMs?: number
  error?: { name: string; code: string }
}

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
  /**
   * Phase 3 P0-A: 子 agent 自己的工具调用历史。
   * spawnDshSubagent 在 followup 后订阅 session/event,把每个
   * tool/call + tool/result 写到这里。writeDshTask 按 500ms debounce
   * 落盘,避免频繁 I/O(单 turn 可能 10+ 次工具调用)。
   */
  toolCalls?: ToolCallEntry[]
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
    /**
     * Phase 3 P0-A+ B1: provider profile name — 子 agent 必须有 provider 才能
     * 调 LLM (dsh-014 修复同样问题)。父 agent 用的 provider 应传给子
     * agent(默认 'anthropic' — zai dsh factory 当前配置)。
     */
    provider?: string
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
    // Phase 3 P0-A: 工具调用历史累积缓冲 + debounced 写盘。
    // 单 turn 可能 10+ 工具调用,每次都写盘太频繁。每 500ms flush 一次。
    const toolCalls: ToolCallEntry[] = []
    let dirty = false
    let flushTimer: NodeJS.Timeout | null = null
    let unsubSession: (() => void) | null = null

    const flushToolCalls = async (): Promise<void> => {
      if (!dirty) return
      dirty = false
      const current = await readDshTask(taskId).catch(() => null)
      if (!current) return
      current.toolCalls = toolCalls.slice()
      await writeDshTask(current).catch((err) => {
        console.warn(`[dsh-bridge] spawnDshSubagent ${taskId} flush toolCalls failed:`, err)
      })
    }
    const scheduleFlush = (): void => {
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flushToolCalls()
      }, 500)
    }

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
        // dsh-014 修复:必须显式传 provider + model,否则 dsh 在 agent/request
        // waterfall 找不到 provider/model,抛 "has no provider/model" 错误。
        // model 用 opts.model (LLM 传的覆盖) 或 opts.model (默认)。
        agentOptions: { provider: opts.provider, model: opts.model },
      })

      await agent.whenIdle()

      // Phase 3 P0-A: 订阅 child session 的 tool/call + tool/result 事件,
      // 累积到 toolCalls 缓冲,debounced 写盘。
      //
      // cordis `session/event` 是**全局**事件,每个 session 都会 broadcast。
      // 用 session 身份比对过滤:仅处理来自子 agent session 的事件。
      // firstSeq 记在 whenIdle 后(同 run.ts:95 模式)— 保证不捕到
      // loader 装载阶段产生的早期事件。
      const firstSeq = agent.session.seq
      unsubSession = ctx.on(
        'session/event',
        (evSession: { id?: unknown }, ev: { type?: unknown; seq?: unknown; data?: unknown }) => {
          // 过滤非子 session 事件 — 父 session 也广播,需精确匹配
          const sessId = evSession?.id
          if (sessId !== undefined && String(sessId) !== String(agent.session.id)) return
          if (typeof ev.seq !== 'number' || ev.seq < firstSeq) return
          const data = (ev.data ?? {}) as Record<string, unknown>
          if (ev.type === 'tool/call') {
            const callId = String(data.callId ?? '')
            if (!callId) return
            toolCalls.push({
              callId,
              toolName: String(data.name ?? 'tool'),
              input: data.arguments, // 模型给的 raw JSON 字符串
              status: 'running',
              ts: Date.now(),
            })
            dirty = true
            scheduleFlush()
          } else if (ev.type === 'tool/result') {
            // tool/result 的 callId 来源 — SessionEvent 'tool/result' 的
            // data.message 是 ToolResultMessage:{ source: { kind:'tool',
            // callId }, content: [ToolResultBlock{ toolCallId, ... }] }。
            // 三处都能拿 callId,优先 source.callId(更明确)。
            const message = data.message as
              | {
                  source?: { kind?: unknown; callId?: unknown }
                  content?: Array<{ toolCallId?: unknown; content?: unknown; isError?: unknown }>
                }
              | undefined
            const callId = String(
              message?.source?.callId
              ?? message?.content?.[0]?.toolCallId
              ?? '',
            )
            if (!callId) return
            const idx = toolCalls.findIndex((t) => t.callId === callId)
            if (idx >= 0) {
              const entry = toolCalls[idx]!
              const resultBlock = message?.content?.[0]
              entry.output = resultBlock?.content
              entry.status = data.error ? 'error' : resultBlock?.isError ? 'error' : 'done'
              entry.durationMs = Date.now() - entry.ts
              if (data.error) {
                entry.error = data.error as { name: string; code: string }
              }
            }
            dirty = true
            scheduleFlush()
          }
        },
      ) as unknown as () => void

      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: opts.prompt }],
          source: { kind: 'user' },
        }),
      )
      await agent.whenIdle()

      // Phase 3 P0-A: 收尾前确保 buffer flush + unsub
      unsubSession?.()
      unsubSession = null
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await flushToolCalls()

      const finalState: DshTaskState = {
        ...initialState,
        status: 'done',
        finishedAt: Date.now(),
        toolCalls: toolCalls.slice(),
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
      // Phase 3 P0-A: 失败时也要保留已收集的 toolCalls(用户能看到
      // "走到第 N 步才挂")
      unsubSession?.()
      unsubSession = null
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const finalState: DshTaskState = {
        ...initialState,
        status: 'failed',
        finishedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        toolCalls: toolCalls.slice(),
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

/**
 * Phase 3 P0-A: 读子 agent 的工具调用历史。直接 readDshTask 拿 toolCalls 字段
 * (Phase 3 在 spawnDshSubagent 期间已写到 ~/.zai/tasks-dsh/<taskId>.json)。
 *
 * zai-side `__zaiDshSubagentDetail.readTask` 内部用,Detail Drawer 渲染。
 */
export async function getDshSubagentToolCalls(
  _ctx: Context,
  taskId: string,
): Promise<ToolCallEntry[]> {
  const task = await readDshTask(taskId)
  return task?.toolCalls ?? []
}