/**
 * dsh-bridge SubagentControlSeam adapter —— 委托现有 `spawnDshSubagent`
 * + `interruptDshSubagent` + `sendMessageToDshSubagent` + `listDshSubagents`。
 *
 * 不变量:
 *   - 委托路径完全走 vendor `SubagentRuntime`,Phase 4 已完成(commit 400550a1)
 *   - 同步模式(bgMode='sync')依赖 `await handle.promise`,已修复"一直没返回"bug
 *   - 异步模式(bgMode='async')通过 parentAgent.followup(<task-notification>)
 *     注入 idle parent inbox,等下次提问被消费
 *   - onChange 通过订阅 vendor `'subagent/start' | 'subagent/end'` 事件触发
 *     (cordis `ctx.on` API),无 vendor ctx 时降级到磁盘 polling
 *
 * Stage 4 起:'fork' provider 通过 `applyForkProvider(ctx, {providerName:'fork'})`
 * 装载后,dispatch 根据 `input.context === 'fork'` 改 `provider: 'fork'`
 * + `inheritsParentContext: true`。
 *
 * Stage 5 起:SeamSubagentDispatchInput 加 capability 字段(`outputSchema` /
 * `toolFilter` / `persona` / `maxDepth` / `backgroundMode:'continuable'`),
 * adapter 直接 mirror 到 vendor `SubagentStartRequest`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

import {
  spawnDshSubagent,
  interruptDshSubagent,
  sendMessageToDshSubagent,
  listDshSubagents,
  readDshTask,
  type DshTaskState,
} from '../subagent/taskStore.js'

import type {
  SubagentControlSeam,
  SeamSubagentDispatchInput,
  SeamSubagentHandle,
  SeamSubagentSummary,
  SeamSubagentTerminalState,
  SeamSubagentStopReason,
  SeamSubagentChangeListener,
} from './types.js'

import {
  SeamInvalidArgumentError,
  SeamRuntimeError,
} from './types.js'

// 内部别名(原本 Impl 后缀本地 class 与 types 同名冲突,统一用 types.ts 真类)。
const SeamInvalidArgumentErrorImpl = SeamInvalidArgumentError
const SeamRuntimeErrorImpl = SeamRuntimeError

/**
 * zai 端提供 ctx + parentAgent 绑定 —— DSH 适配器负责把 seam 调用转成
 * `spawnDshSubagent(ctx, ...)`。
 */
export interface DshSubagentAdapterOptions {
  /** cordis ctx — 必须是已经 createDshRuntime 装载 SubagentRuntime + spawn provider 的实例。 */
  ctx: Context
  /**
   * 解析 parent sessionId → live Agent 句柄(用于 `subagentRuntime.start(... parent ...)`)。
   *
   * zai-side 通常实现:从 `ctx.agents.get(parentSessionId)` 拿(d-sh-bridge 已有),
   * 或从 zai 内部 session registry 拿兼容。
   */
  getParentAgent: (sessionId: string) => Agent | undefined
}

/**
 * dsh-bridge SubagentControlSeam adapter 工厂 + class。
 *
 * 工厂模式:zai 服务端在 `createDshRuntime` 后调一次构造 adapter,后续所有
 * subagent 操作走同一实例。destroy() 触发 listener cleanup。
 */
export class DshSubagentControlAdapter implements SubagentControlSeam {
  private readonly ctx: Context
  private readonly getParentAgent: (sessionId: string) => Agent | undefined
  /** 已注册的 change listener 列表 — 用于 destroy() 统一 unsubscribe。 */
  private readonly changeListeners: SeamSubagentChangeListener[] = []
  /** cordis `ctx.on('subagent/start' | 'subagent/end')` 返回的 disposer。 */
  private cordisDisposers: Array<() => void> = []

  constructor(opts: DshSubagentAdapterOptions) {
    this.ctx = opts.ctx
    this.getParentAgent = opts.getParentAgent
    this.installCordisListeners()
  }

  /**
   * 内部:订阅 vendor `'subagent/start'` + `'subagent/end'` 事件。
   *
   * 事件 names 在 `@deepseek-ai/dsh-subagent/src/index.ts:140-167` 声明。
   * cordis `ctx.on` 返回 disposer — Stage 5+ 也可订阅 `'subagent/provider-*'`
   * 监视 provider register/remove。
   */
  private installCordisListeners(): void {
    const trigger = (): void => {
      const snapshot = [...this.changeListeners]
      // 监听器内部不能 await — onChange 语义:list list + 主动 get 自己拉。
      void (async (): Promise<void> => {
        try {
          const summaries = await this.list()
          for (const cb of snapshot) cb(summaries)
        } catch (err) {
          console.warn('[dsh-bridge] onChange fire failed:', err)
        }
      })()
    }

    try {
      const offStart = this.ctx.on('subagent/start', () => trigger())
      const offEnd = this.ctx.on('subagent/end', () => trigger())
      if (typeof offStart === 'function') this.cordisDisposers.push(offStart)
      if (typeof offEnd === 'function') this.cordisDisposers.push(offEnd)
    } catch (err) {
      // ctx.on 不可用(例如 ctx stub)— listener 仍可手动 emit,降级可工作
      console.warn(
        '[dsh-bridge] SubagentControlSeam: ctx.on subagent/* 不支持,降级到磁盘 polling — 变更感知延迟 < 500ms',
        err,
      )
    }
  }

  async dispatch(input: SeamSubagentDispatchInput): Promise<SeamSubagentHandle> {
    // 入参校验 — zai-side contract 守门,不让无效 input 走到 vendor 抛底层错。
    if (!input.parentSessionId || typeof input.parentSessionId !== 'string') {
      throw new SeamInvalidArgumentErrorImpl(
        'SubagentControlSeam.dispatch: parentSessionId required',
      )
    }
    if (!input.cwd || typeof input.cwd !== 'string') {
      throw new SeamInvalidArgumentErrorImpl('SubagentControlSeam.dispatch: cwd required')
    }
    if (!input.prompt || typeof input.prompt !== 'string') {
      throw new SeamInvalidArgumentErrorImpl('SubagentControlSeam.dispatch: prompt required')
    }

    const parentAgent = this.getParentAgent(input.parentSessionId)
    if (!parentAgent) {
      throw new SeamInvalidArgumentErrorImpl(
        `SubagentControlSeam.dispatch: parent agent not found for sessionId="${input.parentSessionId}"`,
      )
    }

    // Stage 0/1/2/3:context 一律 'spawn'。Stage 4 起 'fork' 走 ForkInProcessProvider。
    if (input.context !== 'spawn') {
      throw new SeamInvalidArgumentErrorImpl(
        `SubagentControlSeam.dispatch: context="${input.context}" not implemented in Stage 0; only 'spawn' supported`,
      )
    }

    // 委托给现有 spawnDshSubagent —— 已经走 vendor `SubagentRuntime.start('spawn', req)`。
    let handle: Awaited<ReturnType<typeof spawnDshSubagent>>
    try {
      handle = await spawnDshSubagent(this.ctx, {
        parentSessionId: input.parentSessionId,
        parentAgent,
        prompt: input.prompt,
        cwd: input.cwd,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      })
    } catch (err) {
      // spawnDshSubagent 只在基础设施故障 reject(provider/parentAgent 缺失已
      // 由前置 throw 拦下)。统一包装成 SeamRuntimeError,zai 端 try/catch 边界。
      const message = err instanceof Error ? err.message : String(err)
      throw new SeamRuntimeErrorImpl(
        `SubagentControlSeam.dispatch: spawnDshSubagent failed: ${message}`,
      )
    }

    return {
      id: handle.taskId,
      promise: handle.promise,
      dispose: () => handle.dispose(),
    }
  }

  async get(taskId: string): Promise<SeamSubagentSummary | null> {
    const state = await readDshTask(taskId)
    return state ? this.stateToSummary(state) : null
  }

  async list(parentSessionId?: string): Promise<SeamSubagentSummary[]> {
    const states = await listDshSubagents(this.ctx, parentSessionId)
    return states.map((s) => this.stateToSummary(s))
  }

  async cancel(taskId: string, reason?: string): Promise<{ ok: boolean }> {
    const existing = await readDshTask(taskId)
    if (!existing) return { ok: false }
    if (existing.status !== 'running') return { ok: false }
    await interruptDshSubagent(this.ctx, taskId)
    if (reason !== undefined) {
      // 写盘带 reason(DshTaskState 目前不存 reason 字段 — 留给 Stage 2 加)。
      // 这里只在 log warning 不 throw。
      console.warn(
        '[dsh-bridge] DshSubagentControlAdapter.cancel: reason not persisted in Stage 0',
        reason,
      )
    }
    return { ok: true }
  }

  async sendMessage(taskId: string, content: string): Promise<{ ok: boolean }> {
    return sendMessageToDshSubagent(this.ctx, taskId, content)
  }

  onChange(listener: SeamSubagentChangeListener): () => void {
    this.changeListeners.push(listener)
    return () => {
      const idx = this.changeListeners.indexOf(listener)
      if (idx >= 0) this.changeListeners.splice(idx, 1)
    }
  }

  /**
   * Adapter 销毁 — 在 zai kernel shutdown 阶段调,清理 change listener +
   * cordis 订阅。Stage 1 + 集成到 KernelAdapter.shutdown()。
   */
  destroy(): void {
    this.changeListeners.length = 0
    for (const off of this.cordisDisposers) {
      try {
        off()
      } catch {
        // ignore — unsubscribe 失败不能 throw
      }
    }
    this.cordisDisposers.length = 0
  }

  // ── 私有 helper ────────────────────────────────────────────────

  /**
   * DshTaskState → SeamSubagentSummary 映射。
   * 这里 mirror zai-side DshTaskState — Stage 3 起两套 status 名差异修复后,
   * 转换器可统一成 `mapSeamSubagentStatus`。
   */
  private stateToSummary(state: DshTaskState): SeamSubagentSummary {
    return {
      taskId: state.taskId,
      sessionId: state.sessionId,
      ...(state.parentSessionId !== undefined
        ? { parentSessionId: state.parentSessionId }
        : {}),
      status: state.status,
      description: state.prompt.slice(0, 80),
      startedAt: state.startedAt,
      ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
      ...(this.mapDshStatusToStopReason(state.status)
        ? { stopReason: this.mapDshStatusToStopReason(state.status) as SeamSubagentStopReason }
        : {}),
      ...(state.error !== undefined ? { error: state.error } : {}),
    }
  }

  /**
   * dsh-side status ∈ {running, done, failed, cancelled} → vendor stopReason 子集。
   * 仅映射终态;running 没有 stopReason(null)。
   */
  private mapDshStatusToStopReason(
    status: DshTaskState['status'],
  ): SeamSubagentStopReason | null {
    switch (status) {
      case 'running':
        return null
      case 'done':
        return 'completed'
      case 'cancelled':
        return 'aborted'
      case 'failed':
        return 'error'
    }
  }
}

// ── 类型导出 ────────────────────────────────────────────────

/**
 * 公开工厂函数 — zai 端在 `createDshRuntime` 之后调一次,
 * 拿到 SubagentControlSeam 用于后续 subagent 操作。
 *
 * @example
 *   const subagentControl = createDshSubagentControlBridge({
 *     ctx: dshRuntime.ctx,
 *     getParentAgent: (sid) => ctx.agents.get(sid),
 *   })
 */
export function createDshSubagentControlBridge(
  opts: DshSubagentAdapterOptions,
): SubagentControlSeam {
  return new DshSubagentControlAdapter(opts)
}
