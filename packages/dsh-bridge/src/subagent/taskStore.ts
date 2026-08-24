/**
 * dsh 子 agent / 后台任务桥 — Phase 4（dsh-subagent 上游 SubagentRuntime 收口）。
 *
 * 历史背景：
 *   - P1-5（真实化）：直接 `ctx.agents.create()` 起独立 child session + 显式
 *     dsh-scope 父子隔离。父 agent 通过 `parentAgent.followup(<task-notification>)`
 *     注入续传。
 *   - Phase 3.1：用 dsh-scope `createScope` 自实现父子 ScopedLayers 链。
 *   - **Phase 4（本次）**：改走 dsh 上游 `SubagentRuntime.start('spawn', req)`。
 *     上游托管 `subagent/start` / `subagent/end` 生命周期事件 + `run.result`
 *     Promise + `run.dispose()` 释放路径,不再绕过去实现父子 turn 解耦。
 *
 * 关键差异：
 *   - 上游 `SubagentRun.result` 是 `Promise<SubagentResult>` (永不 reject,
 *     失败 resolve 成 `stopReason: 'error'`)。 我们 `.then()` 映射成
 *     `DshTaskState` + 触发 zai-side `onTaskFinish` sink。
 *   - 上游 `run.dispose()` 替代我们手写的 `agent.cancel()` + 清理逻辑。
 *   - spawn provider (`@deepseek-ai/dsh-subagent-spawn-in-process`) 走
 *     `inheritsParentContext: false` — 子 agent 不继承父 prompt history。
 *     cwd / provider / model 通过 `agentOptions` 注入。
 *
 * 任务持久化仍走**独立 namespace**：`~/.zai/tasks-dsh/<taskId>.json`
 * （与 opencc `~/.zai/tasks/<taskId>.json` 隔离,主计划 §4.2 R4）。
 *
 * 工具调用历史（`toolCalls`）累积 — 通过订阅 child session 的
 * `tool/call` + `tool/result` 事件,500ms debounce 写盘。Phase 3 P0-A
 * 已实现,Phase 4 沿用同样机制。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SubagentRuntime, type SubagentRun, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * 子 agent 工具调用条目 — Phase 3 P0-A 沿用。
 *
 * spawnDshSubagent 在 `run` 拿到后通过 `ctx.on('session/event')` 订阅 child
 * session 的 tool/call + tool/result,累积到这里,500ms debounce 写盘。
 * SubagentDetailDrawer 渲染此字段给用户看。
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
     * spawnDshSubagent 在订阅 session/event 后累积到此字段。
     */
  toolCalls?: ToolCallEntry[]
}

const DSH_TASKS_DIR = join(homedir(), '.zai', 'tasks-dsh')

/**
 * 延迟获取 DSH tasks 目录路径 — 让单测能通过 mock `homedir()`
 * 在 beforeEach 里设新值后,所有 taskStore 操作仍走最新路径。
 *
 * 不能用模块顶层常量(import 时 frozen,后续 mock 改动不会反映)。
 * 也不缓存函数结果 — 每次调用都重读 `homedir()`,测试 setup 改 home 立即生效。
 */
function dshTasksDir(): string {
  return join(homedir(), '.zai', 'tasks-dsh')
}

export function dshTaskPath(taskId: string): string {
  return join(dshTasksDir(), `${taskId}.json`)
}

async function ensureDshTasksDir(): Promise<void> {
  await mkdir(dshTasksDir(), { recursive: true })
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
 * `ctx.subagents` 是 cordis 模块增强 + dsh-subagent 上游注册 — zai-side
 * 不再需要自实现父子 scope（之前 Phase 3.1 的 `createDshSubagentScope`
 * 已被上游托管）。
 *
 * Phase 4 兼容性：保留 export 名 `createDshSubagentScope`，但函数体改为
 * 直接 return `{ ctx, dispose: () => {} }` —— 旧调用方拿到 stub 就够
 * （已经走 `subagents.start()`，不再用 createScope 自己隔离）。
 */
export function createDshSubagentScope(
  _parentCtx: Context,
  _opts: { parentScopeKey: object; childScopeKey: object },
): { ctx: Context; dispose: () => void } {
  // Phase 4 stub — dsh-subagent 上游 `SubagentRuntime.start('spawn', req)`
  // 内部已用 dsh-scope 的 `bindScopeParent` 自动建立父子 scope 链。
  // dsh-bridge 不再需要显式 createScope。保留 export 名以兼容旧调用方。
  const stubCtx = _parentCtx
  return {
    ctx: stubCtx,
    dispose: () => {
      // no-op — 子 agent 由 SubagentRuntime 托管,scope 生命周期跟 `run` 绑定
    },
  }
}

/**
 * Phase 4:把 `SubagentResult.stopReason` 映射到 `DshTaskState.status`。
 *
 * 上游 `SubagentRun.result` 永不 reject,所以这里不处理 reject 分支
 * （reject 只在基础设施故障时发生,会直接冒泡到 spawn 调用方）。
 */
function mapStopReasonToStatus(
  stopReason: SubagentResult['stopReason'],
): DshTaskState['status'] {
  switch (stopReason) {
    case 'completed':
      return 'done'
    case 'aborted':
      return 'cancelled'
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return 'failed'
    default:
      // 上游 SubagentStopReasonMap 是 merge-extensible — 未知 variant 视为 failed
      return 'failed'
  }
}

/**
 * Phase 4:`SubagentResult.output` 是 `ContentBlock[]`,转成 LLM 友好的纯文本。
 * 给 `<task-notification>` 注入父 session 用。
 */
function formatOutputForLlm(output: ContentBlock[]): string {
  if (output.length === 0) return ''
  return output
    .map((block) => {
      if (block.type === 'text') {
        const t = (block as { text?: unknown }).text
        return typeof t === 'string' ? t : ''
      }
      return `[${String(block.type)} block]`
    })
    .filter((s) => s.length > 0)
    .join('\n')
}

/**
 * 订阅 child session 的 tool/call + tool/result 事件,累积到 toolCalls 缓冲。
 * debounced 写盘,避免单 turn 10+ 工具调用导致频繁 I/O。
 *
 * Phase 4 调整:上游 `SubagentRun.localAgent` 是 in-process 子 agent
 * (远端 provider 时为 undefined),用它的 session seq 过滤事件
 * (与 `run.ts:95-127` 同款模式)。
 */
function subscribeChildSessionToolCalls(
  ctx: Context,
  childAgent: Agent,
  taskId: string,
  toolCalls: ToolCallEntry[],
): () => void {
  // firstSeq 记在订阅后 (loader 装载阶段产生的早期事件不关心)
  const firstSeq = childAgent.session.seq
  let dirty = false
  let flushTimer: NodeJS.Timeout | null = null

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

  const off = ctx.on(
    'session/event',
    (evSession: { id?: unknown }, ev: { type?: unknown; seq?: unknown; data?: unknown }) => {
      // 过滤非子 session 事件 — 父 session 也广播,需精确匹配
      const sessId = evSession?.id
      if (sessId !== undefined && String(sessId) !== String(childAgent.session.id)) return
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

  return () => {
    try { off() } catch { /* ignore */ }
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void flushToolCalls()
  }
}

/**
 * 子 agent spawn — **Phase 4 改造**:走 dsh 上游 `SubagentRuntime.start('spawn', req)`。
 *
 * 关键不变量:
 *   - 上游托管 `subagent/start` / `subagent/end` 生命周期事件,
 *     父子 turn 解耦完整。
 *   - 子 agent 工具调用历史累积沿用 Phase 3 P0-A 模式(订阅 session/event)。
 *   - 子 agent 完成后通过 `parentAgent.followup(<task-notification>)` 注入
 *     父 session inbox,等下次 turn 被消费(run_in_background=true 时,
 *     父 turn 已 end,所以依赖用户后续提问触发新 turn)。
 *   - 同步模式(`run_in_background=false` 调用方 await `promise`)时父 turn
 *     立即拿到 `done` 结果,无需重启 turn。
 *
 * 返回 `agent: Agent | undefined`:上游远端 provider 时 localAgent 是 undefined
 * (rare case,目前 dsh-subagent-spawn-in-process 总是 in-process,
 * localAgent 有值)。
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
     * Provider name — dsh 模式下两种合法值:
     *   - 'spawn' (默认,Stage 0 起的唯一选项):子代理不继承父 prompt history
     *     (`inheritsParentContext: false`)。vendor 子代理 provider `SpawnInProcessProvider`。
     *   - 'fork'  (Stage 4 实装):子代理继承父完成 turn 前缀
     *     (`inheritsParentContext: true`,vendor `ForkInProcessProvider`)。
     *     通过 `ctx.subagents.start('fork', req)` 调,要 vendor 注册了
     *     ForkInProcessProvider(在 `createDshRuntime.start()` 经 applyForkProvider)。
     *     缺省 'spawn' 是给向后兼容的现有 caller。
     */
    providerName?: 'spawn' | 'fork'
    provider?: string
    taskId?: string
    /**
     * 完成时通知策略(Stage 7):
     *   - 'wakeup' (默认,向后兼容):完成后通过 `parentAgent.followup`
     *     注入 `<task-notification>` 到父 session inbox,idle 时等下次
     *     turn 被消费(用户继续提问触发);idle → 等同 'wakeup' 但
     *     上一轮还在执行,followup 入下一轮 turn inbox。
     *   - 'quiet':完成时跳过 followup,只走 onTaskFinish/zai SSE 通知。
     *     zai 端 UI 仍能看到 task 状态变化(TaskDock),但 LLM 不会因
     *     子代理完成被打扰。
     *
     * vendor 真相:dsh-tool-jobs `Config.completionDelivery` 默认 'wakeup',
     * `maxConsecutiveWakes` 默认 3(连续 N 次 wakeup 后自动转 quiet 防止自循环)。
     * dsh-bridge subagent 不暴露完整 listener 自循环检测,本 stage 实现
     * 二选一;counter 由 zai-side factory 维护。
     */
    completionDelivery?: 'wakeup' | 'quiet'
    /**
     * 子代理输出 JSON Schema(对齐 vendor `SubagentStartRequest.outputSchema`)。
     * 指定后,子代理 output 经结构化校验,`SubagentResult.structured` 字段填值。
     */
    outputSchema?: Record<string, unknown>
    /** 子代理允许的工具名白名单(对齐 vendor `toolFilter`)。不传 = 全开。 */
    toolFilter?: string[]
    /** 子代理 persona prompt — 注入到子 agent system prompt 前缀(对齐 vendor `persona`)。 */
    persona?: string
    /** 嵌套层数上限(对齐 vendor `maxDepth`)。缺省 vendor 默认(2)。 */
    maxDepth?: number
  },
): Promise<{
  taskId: string
  agent: Agent | undefined
  promise: Promise<DshTaskState>
  dispose: () => Promise<void>
}> {
  const taskId = opts.taskId ?? `dsh-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // 归一 providerName;不存在时 vendor start() 找不到 provider 会抛 'NO_PROVIDER'
  // 但 fallback 'spawn' 让 Stage 0 路径不变。
  const providerName = opts.providerName ?? 'spawn'
  // Stage 7:completionDelivery 默认 'wakeup',与未传 opts 的所有现有 caller
  // (Phase 4 起所有调用方)行为 100% 兼容。'quiet' 跳过下面的 followup。
  const completionDelivery = opts.completionDelivery ?? 'wakeup'

  // 1. 写盘 initial state (sessionId 暂时占位 'pending',start() 后回填)
  const initialState: DshTaskState = {
    taskId,
    sessionId: 'pending',
    parentSessionId: opts.parentSessionId,
    status: 'running',
    prompt: opts.prompt,
    startedAt: Date.now(),
  }
  await writeDshTask(initialState)

  // 2. 拿上游 SubagentRuntime + parent agent(后者必须存在)
  const subagentRuntime = ctx.subagents as SubagentRuntime | undefined
  if (!subagentRuntime) {
    const failed: DshTaskState = {
      ...initialState,
      status: 'failed',
      finishedAt: Date.now(),
      error: 'ctx.subagents unavailable — SubagentRuntime not loaded',
    }
    await writeDshTask(failed)
    throw new Error('[dsh-bridge] spawnDshSubagent: ctx.subagents unavailable — SubagentRuntime not loaded')
  }
  if (!opts.parentAgent) {
    const failed: DshTaskState = {
      ...initialState,
      status: 'failed',
      finishedAt: Date.now(),
      error: 'parentAgent required for dsh-subagent start()',
    }
    await writeDshTask(failed)
    throw new Error('[dsh-bridge] spawnDshSubagent: parentAgent required for dsh-subagent start()')
  }

  // 3. 调上游 SubagentRuntime.start(providerName, req)
  //    Stage 4:`providerName === 'fork'` 走 vendor ForkInProcessProvider
  //    (inheritsParentContext: true);其他(= 'spawn')走原 spawn 路径。
  //    上游 assertCapabilities 校验,fork provider caps ⊇ spawn provider caps
  //    (ForkInProcessProvider 同一组 capabilities),所以基本参数不会冲突。
  const abortController = new AbortController()
  let run: SubagentRun
  try {
    run = await subagentRuntime.start(providerName, {
      label: `dsh-subagent-${taskId}`,
      prompt: [{ type: 'text', text: opts.prompt }],
      parent: opts.parentAgent,
      signal: abortController.signal,
      agentOptions: {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      },
      ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema as unknown as ObjectJsonSchema } : {}),
      ...(opts.toolFilter !== undefined ? { toolFilter: opts.toolFilter as unknown as ToolRestriction } : {}),
      ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    })
  } catch (err) {
    // start() 阶段失败 — 上游会清理 partial resources,我们写盘 + 抛
    const message = err instanceof Error ? err.message : String(err)
    const failed: DshTaskState = {
      ...initialState,
      sessionId: 'start-failed',
      status: 'failed',
      finishedAt: Date.now(),
      error: message,
    }
    await writeDshTask(failed)
    throw err
  }

  // 4. 回填 sessionId + 订阅 child session 工具调用历史(仅 in-process provider)
  initialState.sessionId = String(run.id)
  await writeDshTask(initialState)

  let unsubTools: (() => void) | null = null
  if (run.localAgent) {
    const toolCalls: ToolCallEntry[] = []
    unsubTools = subscribeChildSessionToolCalls(ctx, run.localAgent, taskId, toolCalls)
    // 把累积缓冲挂到 initialState 上,promise 收尾时同步给最终 state
    ;(initialState as { toolCalls?: ToolCallEntry[] }).toolCalls = toolCalls
  }

  // 5. 包装 run.result → DshTaskState + 触发 onTaskFinish + followup parent
  const promise = (async (): Promise<DshTaskState> => {
    let result: SubagentResult
    try {
      result = await run.result
    } catch (err) {
      // 上游 run.result 只在基础设施故障时 reject(模型/网络错误 resolve 成 stopReason='error')
      const message = err instanceof Error ? err.message : String(err)
      const finalState: DshTaskState = {
        ...initialState,
        status: 'failed',
        finishedAt: Date.now(),
        error: message,
      }
      await writeDshTask(finalState)
      unsubTools?.()
      return finalState
    }

    // 收尾工具调用历史(确保最后一次 flush + unsub)
    unsubTools?.()
    unsubTools = null

    const status = mapStopReasonToStatus(result.stopReason)
    const finalState: DshTaskState = {
      ...initialState,
      status,
      finishedAt: Date.now(),
      result: formatOutputForLlm(result.output),
      ...(result.diagnostic ? { error: result.diagnostic } : {}),
    }
    await writeDshTask(finalState)

    // Phase 4 完成语义:
    //   - 同步模式(run_in_background=false 调用方 await promise):这里 resolve
    //     时调用方拿到终态,父 turn 自然 end。
    //   - 异步模式(run_in_background=true 调用方立即 return):父 turn 已 end,
    //     这里通过 followup 注入 `<task-notification>`,等下次 turn 被消费。
    //
    // Stage 7 调整:`completionDelivery === 'quiet'` 时跳过 followup,只走
    // onTaskFinish / zai SSE 通知。Vendor 场景:zai 端 factory 通过
    // `maxConsecutiveWakes` 计数防止反复 wakeup 把 LLM 自循环拖死。
    if (opts.parentAgent && completionDelivery !== 'quiet') {
      try {
        const text = `<task-notification>${JSON.stringify({
          taskId,
          status: status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed',
          ...(finalState.error ? { error: finalState.error } : {}),
        } satisfies SubagentNotification)}</task-notification>`
        opts.parentAgent.followup(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
        )
        // 同步模式:调用方已经在 await,followup 会进入下一轮 turn 的 inbox
        // (同步模式父 turn 还没 end,父 LLM 看到 task-notification 后收尾)
        // 异步模式:父 turn 已 end,followup 进入 idle parent inbox,等下次提问
      } catch (followupErr) {
        console.warn(
          `[dsh-bridge] spawnDshSubagent ${taskId} followup notification failed:`,
          followupErr,
        )
      }
    }

    return finalState
  })()

  return {
    taskId,
    agent: run.localAgent, // in-process provider 有值;远端 undefined
    promise,
    dispose: () => run.dispose(),
  }
}

// NOTE: notifyParentSession removed — deprecated (2026-08-22).

// ====== zai compat subagentControl 桥接 ======

/**
 * Phase 4.1 (2026-08-22 修复 dsh-024):放弃上游 `ctx.subagents.listChildren()`
 * fast path,改走纯磁盘 `listDshTasks()` + parentSessionId 过滤。
 *
 * **为什么改**:
 * 上游 `listChildren(parentSessionId)` 返回的 child 用 sessionId(上游
 * SubagentRun.id,UUID)标识;而 spawn 写盘用 taskId (`dsh-task-<timestamp>-...`)。
 * 两套 id 体系:
 *   - spawn taskId:`~/.zai/tasks-dsh/<taskId>.json` 文件名 + onTaskStart
 *     emit payload.taskId + 父 LLM 收到的 subagent_control task_id
 *   - 上游 sessionId:listChildren 返回 / subagents.interrupt 接受
 *
 * 旧实现把 sessionId 当 taskId 返回 → 跟 onTaskStart / interruptDshSubagent
 * / 磁盘文件名 全不匹配,导致前端 store 永远空(TaskDock 不显示),父 LLM
 * 拿 task_id 调 interrupt 也找不到磁盘文件。
 *
 * 改走磁盘后,list 返回的 taskId 跟 spawn 时一致(都是 spawn taskId),
 * onTaskStart / interrupt / sendMessage / readTask 全部 id 对齐。
 *
 * 性能:listDshTasks 是 readdir + JSON.parse,N=小(本机活跃 subagent
 * 数 < 100),Phase 4 性能优化(注释里说的 "fastest path")收益不抵 bug。
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
 * 中止一个运行中的 dsh subagent。Phase 4 改走上游 `ctx.subagents.interrupt()`。
 *
 * 上游 `interrupt(targetSessionId, authority)` 要求 authority 是
 * `{ kind: 'ancestor', agent: parentAgent }` —— 必须用 spawn 时的
 * parentAgent 做凭证,不能只给 sessionId。
 */
export async function interruptDshSubagent(
  ctx: Context,
  taskId: string,
): Promise<DshTaskState | null> {
  const existing = await readDshTask(taskId)
  if (!existing) return null
  if (existing.status !== 'running') return existing
  try {
    const subagentRuntime = ctx.subagents as SubagentRuntime | undefined
    if (subagentRuntime && existing.parentSessionId) {
      // 拿 parent agent 作 authority
      const agents = ctx.get('agents') as {
        get?: (id: unknown) => Agent | undefined
      } | undefined
      const parentAgent = agents?.get?.(existing.parentSessionId)
      if (parentAgent) {
        subagentRuntime.interrupt(SessionId(existing.sessionId), {
          kind: 'ancestor',
          agent: parentAgent,
        })
      } else {
        // 没 parent agent,降级用 agent.cancel
        const handle = agents?.get?.(existing.sessionId) as { cancel?: (cause: { kind: 'user' }) => void } | undefined
        handle?.cancel?.({ kind: 'user' })
      }
    } else {
      // 上游不可用时降级到直接 cancel
      const agents = ctx.get('agents') as {
        get?: (id: unknown) => { cancel?: (cause: { kind: 'user' }) => void } | undefined
      } | undefined
      const handle = agents?.get?.(existing.sessionId)
      handle?.cancel?.({ kind: 'user' })
    }
  } catch (err) {
    console.warn(`[dsh-bridge] interruptDshSubagent ${taskId} cancel failed:`, err)
  }
  const updated: DshTaskState = {
    ...existing,
    status: 'cancelled',
    finishedAt: Date.now(),
  }
  await writeDshTask(updated)
  return updated
}

/**
 * Phase 4:用上游 `ctx.subagents.followup(parent, childId, content)` 投消息。
 *
 * 要求 parent 是 live ancestor agent。spawn 时的 parent 仍 live 时可直接调
 * (会话期间)。会话已 close 时需要先 resume — 留给 zai-side compat 处理。
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
    const subagentRuntime = ctx.subagents as SubagentRuntime | undefined
    const parentSessionId = existing.parentSessionId
    if (subagentRuntime && parentSessionId) {
      const agents = ctx.get('agents') as {
        get?: (id: unknown) => Agent | undefined
      } | undefined
      const parentAgent = agents?.get?.(parentSessionId)
      if (parentAgent) {
        // SubagentFollowupOptions 需要 signal — 上游 API 入参要求 abort 句柄,
        // 此处建本地 controller(本调用方 sync 控制 — 调完即返回)。
        const abortController = new AbortController()
        await subagentRuntime.followup(
          parentAgent,
          SessionId(existing.sessionId),
          [{ type: 'text', text: prompt }],
          { source: { kind: 'user' }, signal: abortController.signal },
        )
        return { ok: true }
      }
    }
    // fallback:直接 agent.followup
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
 * Phase 3 P0-A:读子 agent 的工具调用历史。直接 readDshTask 拿 toolCalls 字段。
 */
export async function getDshSubagentToolCalls(
  _ctx: Context,
  taskId: string,
): Promise<ToolCallEntry[]> {
  const task = await readDshTask(taskId)
  return task?.toolCalls ?? []
}

// 替换原 mock 实现为 re-export continuation 真函数
export { startContinuable } from './continuation.js'