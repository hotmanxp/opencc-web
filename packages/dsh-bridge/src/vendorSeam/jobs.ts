/**
 * dsh-bridge JobsControlSeam adapter —— 委托 vendor `ctx.jobs`
 * (`@deepseek-ai/dsh-jobs-local` 的 `LocalJobRegistry`)。
 *
 * vendor 真相(参见 deepseek-harness/packages/jobs/jobs/src/index.ts):
 *   - 抽象类 `JobRegistry` 定义 `start / list / get / read / kill / wait / onJobDone / onJobsChanged`
 *   - `LocalJobRegistry` 是进程内实现(Map 存储 + 自增 JobId)
 *   - bash 后台 → vendor `tool-bash` 的 `run_in_background` → `ctx.jobs.start({kind:'bash'})`
 *   - subagent 后台 → vendor `tool-subagent` 的 `run_in_background:true` →
 *     `ctx.jobs.start({kind:'subagent'})` (内部委派给 SubagentRuntime.start)
 *
 * Stage 0:`bash` / `subagent` 两个 kind 都代理到 `ctx.jobs.start({...})`,
 * adapter 负责把 zai 友好的 input 形态翻译成 vendor `JobStart` + `JobHooks`。
 *
 * 不变量(vendor 反直觉点):
 *   - bash 后台永远不 settle 成 `'failed'`(`ShellProcess` 没有 failed 字段)
 *     → Seam job summary status 在 bash kind 上只会 `'completed' | 'killed'`
 *     → 详见 tool-bash/src/background.ts:18-22
 *   - JobId 是 `<kind>-<N>` 自增(可预测,access fence by owner session id)
 *   - vendor `LocalJobRegistry` **不**磁盘持久化(进程结束即丢)
 *   - owner-scoped `maxConcurrentJobsPerOwner` 默认 5,超限抛清晰错误
 *
 * Stage 6+:`maxOutputBytes` / `maxSpillBytes` / `graceMs` 抽到 ctx.shell config;
 * Stage 7+:wakeup/quiet 双投递策略 + `maxConsecutiveWakes`。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobRegistry, JobStart, JobHooks, JobOutcome, JobRead } from '@deepseek-ai/dsh-jobs'

// 顶层 import taskStore(taskStore 内部不依赖 vendorSeam,无循环)。
// 测试时 vi.mock('../../src/subagent/taskStore.js') 可拦截 — 单测间接验证本 adapter
// 委托关系不依赖真实 disk / dsh ctx。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { spawnDshSubagent } from '../subagent/taskStore.js'

import type {
  JobsControlSeam,
  SeamJobStartInput,
  SeamJobStartResult,
  SeamJobSummary,
  SeamJobStatus,
  SeamJobKind,
  SeamJobRead,
  SeamBashJobInput,
  SeamSubagentDispatchInput,
  SeamJobChangeListener,
} from './types.js'

import {
  SeamInvalidArgumentError,
  SeamConcurrentJobsExceededError,
  SeamRuntimeError,
} from './types.js'

// 内部别名(原本 Impl 后缀本地 class 与 types 同名冲突,统一用 types.ts 真类)。
const SeamInvalidArgumentErrorImpl = SeamInvalidArgumentError
const SeamConcurrentJobsExceededErrorImpl = SeamConcurrentJobsExceededError
const SeamRuntimeErrorImpl = SeamRuntimeError

/**
 * bash 后台 producer hooks —— 委派 ctx.shell(由 dsh-bridge `LocalShellExecutor`
 * 注入)。流程:
 *   1. `ctx.shell.start(...)` 走 vendor `ShellProcess`(`packages/shell/shell/`)
 *   2. hooks.cancel → `proc.kill()`
 *   3. hooks.done → settle 时把 exit code / signal 折成 `JobOutcome`
 *
 * vendor `LocalBashExecutor.start` 返回 `ShellProcess`(status: 'running' |
 * 'killed' | 'completed')。fail 状态目前 vendor 没有(见 tool-bash/src/background.ts TODO)——
 * `processOutcome` 把 'killed' 统一映射成 `'killed'` outcome,模型侧不会看到 'failed'。
 *
 * **Stage 6+**:`maxOutputBytes: 64_000` 自动 spill to `<jobId>.spill`(本 stage 不做)。
 *
 * Stage 0:走的是简化版本,不抽到 vendor 全 seam(`ctx.shell.start` 即可)。
 */
function startBashJob(
  ctx: Context,
  input: SeamBashJobInput,
): JobHooks {
  // LocalBashExecutor / LocalShellExecutor 需要 process 上的 signal — AbortSignal
  // 同步转 spawn 选项。Stage 6+ 改 detached + process group kill。
  const abortController = new AbortController()

  const shellService = ctx.get('shell') as
    | {
        start: (spec: {
          command: string
          workdir?: string
          timeoutMs?: number
          env?: Record<string, string>
        }) => {
          status: 'running' | 'killed' | 'completed'
          exitCode: number | null
          signal: NodeJS.Signals | null
          done: Promise<void>
          readOutput?: () => string
          kill(): boolean
        }
      }
    | undefined
  if (!shellService || typeof shellService.start !== 'function') {
    throw new SeamRuntimeErrorImpl(
      'JobsControlSeam.start({kind:"bash"}): ctx.shell unavailable — LocalShellExecutor 装载前不能跑 bash 后台',
    )
  }

  const proc = shellService.start({
    command: input.command,
    workdir: input.cwd,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  })

  // 由于 hooks.done 不能 reject(注释见 jobs/jobs/src/types.ts:84),
  // 把 abort 失败包装成 'failed' outcome。
  const done = new Promise<JobOutcome>((resolve) => {
    proc.done.then(
      () => {
        if (proc.status === 'killed') {
          const signalDetail = proc.signal ? `signal: ${proc.signal}` : 'killed before exit'
          resolve({ status: 'killed', detail: signalDetail })
        } else {
          resolve({
            status: 'completed',
            detail: `exit code: ${proc.exitCode ?? 0}`,
            output: proc.readOutput?.() ?? '',
          })
        }
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        resolve({ status: 'failed', detail: message })
      },
    )
  })

  return {
    cancel(reason?: string): void {
      // SIGTERM first,grace 期间 vendor bash-local 才转 SIGKILL(Stage 6+)。
      abortController.abort(reason)
      proc.kill()
    },
    done: done as unknown as JobHooks['done'],
  } as JobHooks
}

/**
 * subagent 后台 producer hooks —— 委派现有 `spawnDshSubagent`。
 *
 * 内部走 vendor `tool-subagent` 的 `run_in_background:true` 同形路径
 * (`ctx.jobs.start({kind:'subagent', run: () => subagentHooks})`)。
 *
 * Stage 0:实装直接 import taskStore 模块,ESM 顶层 import 形式让 vi.mock
 * 可拦截 — 单测 mockState.taskStore.spawnDshSubagent 直接验证。
 * Stage 5+:capability 透传(outputSchema/toolFilter/persona/maxDepth/continuable)
 * 经由 dispatch → SubagentRuntime.start(...) 走 vendor。
 */
function startSubagentJob(
  ctx: Context,
  input: SeamSubagentDispatchInput,
  ownerHint: string | undefined,
): JobHooks {
  const abortController = new AbortController()

  const parentAgent = resolveParentAgent(ctx, input.parentSessionId)
  if (!parentAgent) {
    throw new SeamInvalidArgumentErrorImpl(
      `JobsControlSeam.start({kind:"subagent"}): parent agent not found for sessionId="${input.parentSessionId}"`,
    )
  }

  let spawnPromise: Promise<Awaited<ReturnType<typeof spawnDshSubagent>>> | null = null
  let disposed = false

  const ensureSpawn = (): Promise<Awaited<ReturnType<typeof spawnDshSubagent>>> => {
    if (!spawnPromise) {
      spawnPromise = spawnDshSubagent(ctx as never, {
        parentSessionId: input.parentSessionId,
        parentAgent: parentAgent as never,
        prompt: input.prompt,
        cwd: input.cwd,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      }).catch((err: unknown) => {
        // 重置 promise 允许 retry(spawnDshSubagent 只在 spawn 阶段失败 reject;
        // 用户调 cancel 后再调 start 应该重新 spawn,而不复用 rejected promise)
        spawnPromise = null
        throw err
      })
    }
    return spawnPromise
  }

  const done = (async (): Promise<JobOutcome> => {
    let handle: Awaited<ReturnType<typeof spawnDshSubagent>>
    try {
      handle = await ensureSpawn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'failed', detail: message }
    }
    try {
      const state = await handle.promise
      if (state.status === 'done') {
        return {
          status: 'completed',
          detail: `subagent session ${state.sessionId} completed`,
          output:
            typeof state.result === 'string'
              ? state.result
              : JSON.stringify(state.result ?? null),
        }
      }
      if (state.status === 'cancelled') {
        return {
          status: 'killed',
          detail: `subagent session ${state.sessionId} cancelled`,
        }
      }
      return {
        status: 'failed',
        detail: state.error ?? `subagent session ${state.sessionId} failed`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'failed', detail: message }
    }
    // 占位 — ownerHint 在 caller resolve;这里没用,留 hook 备查
    void ownerHint
    void disposed
  })()

  return {
    cancel(reason?: string): void {
      if (disposed) return
      disposed = true
      abortController.abort(reason)
      // 不 await — cancel 是 sync 接口;spawn 完成后走 handle.dispose
      if (spawnPromise) {
        void spawnPromise
          .then((h) => h.dispose())
          .catch(() => undefined)
      }
    },
    done,
  }
}

/**
 * 从 ctx.agents 拿 parent agent —— vendor `AgentRegistry.get(id)` 形态。
 * zai-side 通常通过 ctx.plugin 装载 Agent 服务;简化用 duck-typed access。
 */
function resolveParentAgent(ctx: Context, parentSessionId: string): unknown {
  const agents = ctx.get('agents') as
    | {
        get?: (id: unknown) => unknown
      }
    | undefined
  return agents?.get?.(parentSessionId)
}

/**
 * DshJobsAdapter 构造选项。
 */
export interface DshJobsAdapterOptions {
  /** cordis ctx —— 必须已经 createDshRuntime 装载 `LocalJobRegistry` + `LocalShellExecutor`。 */
  ctx: Context
}

/**
 * dsh-bridge JobsControlSeam adapter 实现。
 *
 * 设计要点:
 *   - `getJobsRegistry()` 抽出来:vendor 注册名可能改(`jobs` / `LocalJobRegistry` /
 *     future `JobRegistry`),便于适配
 *   - `onChange` 通过 `ctx.jobs.onJobsChanged` + `onJobDone` 触发
 *   - `list()` / `get()` / `read()` 直接委托 vendor —— 不缓存(每次拿 fresh)
 */
export class DshJobsControlAdapter implements JobsControlSeam {
  private readonly ctx: Context
  private readonly changeListeners: SeamJobChangeListener[] = []
  private readonly cordisDisposers: Array<() => void> = []

  constructor(opts: DshJobsAdapterOptions) {
    this.ctx = opts.ctx
    this.installCordisListeners()
  }

  private getJobsRegistry(): JobRegistry {
    const registry = this.ctx.get('jobs') as JobRegistry | undefined
    if (!registry) {
      throw new SeamRuntimeErrorImpl(
        'JobsControlSeam: ctx.jobs unavailable — LocalJobRegistry 装载前不能跑 jobs',
      )
    }
    return registry
  }

  /**
   * 订阅 vendor `onJobsChanged`(每次 owner 列表变化触发)+ `onJobDone`(单 job 终结
   * 时触发)—— 推 summaries 列表给 zai UI。
   */
  private installCordisListeners(): void {
    try {
      const registry = this.getJobsRegistry()
      const offChanged = registry.onJobsChanged(() => {
        this.fireChangeListeners()
      })
      const offDone = registry.onJobDone(() => {
        this.fireChangeListeners()
      })
      if (typeof offChanged === 'function') this.cordisDisposers.push(offChanged)
      if (typeof offDone === 'function') this.cordisDisposers.push(offDone)
    } catch (err) {
      console.warn(
        '[dsh-bridge] JobsControlSeam: ctx.jobs.onJobsChanged 不支持,降级到 active polling',
        err,
      )
    }
  }

  private fireChangeListeners(): void {
    void (async (): Promise<void> => {
      try {
        const summaries = await this.list()
        for (const cb of [...this.changeListeners]) cb(summaries)
      } catch (err) {
        console.warn('[dsh-bridge] JobsControlSeam fireChangeListeners failed:', err)
      }
    })()
  }

  async start(input: SeamJobStartInput): Promise<SeamJobStartResult> {
    // 校验 + producer hooks 构造
    let producerHooks: JobHooks
    let ownerHint: string | undefined

    if (input.kind === 'bash') {
      const bashInput = input.input as SeamBashJobInput
      if (!bashInput.command || typeof bashInput.command !== 'string') {
        throw new SeamInvalidArgumentErrorImpl(
          'JobsControlSeam.start({kind:"bash"}): command required',
        )
      }
      producerHooks = startBashJob(this.ctx, bashInput)
    } else if (input.kind === 'subagent') {
      const subInput = input.input as SeamSubagentDispatchInput
      if (!subInput.parentSessionId || typeof subInput.parentSessionId !== 'string') {
        throw new SeamInvalidArgumentErrorImpl(
          'JobsControlSeam.start({kind:"subagent"}): parentSessionId required',
        )
      }
      producerHooks = startSubagentJob(this.ctx, subInput, ownerHint)
    } else {
      // exhaustiveness guard — future Stage 4+ 加新 kind 时编译报错提醒
      const _exhaustive: never = input
      void _exhaustive
      throw new SeamInvalidArgumentErrorImpl(
        `JobsControlSeam.start: unsupported kind ${String(input)}`,
      )
    }

    // 委托 vendor `start()` —— 它做 preflight + 注册 + 触发 hooks.done 监听。
    let id: string
    try {
      const spec: JobStart = {
        kind: input.kind as never,
        label: input.label,
        ...(input.outputLimitBytes !== undefined
          ? { outputLimitBytes: input.outputLimitBytes }
          : {}),
        run(): JobHooks {
          return producerHooks
        },
      }
      id = this.getJobsRegistry().start(spec) as unknown as string
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // vendor `LocalJobRegistry.start` 抛 'background job limit reached ...' 时
      // 翻译为 SeamConcurrentJobsExceededError
      if (/limit reached/i.test(message)) {
        const m = message.match(/limit: (\d+)/)
        const limit = m && m[1] ? Number.parseInt(m[1], 10) : 5
        throw new SeamConcurrentJobsExceededErrorImpl(limit, ownerHint)
      }
      throw new SeamRuntimeErrorImpl(
        `JobsControlSeam.start: LocalJobRegistry.start failed: ${message}`,
      )
    }

    return { id }
  }

  async get(id: string): Promise<SeamJobSummary | null> {
    let snapshot: unknown
    try {
      snapshot = this.getJobsRegistry().get(id as never)
    } catch (err) {
      // vendor `get` 对未知 / 跨 owner 抛 'unknown job' / 'belongs to another session'
      if (
        err instanceof Error &&
        (/unknown job/i.test(err.message) ||
          /belongs to another session/i.test(err.message))
      ) {
        return null
      }
      throw err
    }
    return snapshot ? this.snapshotToSummary(snapshot as never) : null
  }

  async list(): Promise<SeamJobSummary[]> {
    let snapshots: unknown[]
    try {
      snapshots = this.getJobsRegistry().list() as unknown as unknown[]
    } catch (err) {
      console.warn('[dsh-bridge] JobsControlSeam.list failed:', err)
      return []
    }
    return snapshots.map((s) => this.snapshotToSummary(s as never))
  }

  async read(id: string): Promise<SeamJobRead & { summary: SeamJobSummary }> {
    let vRead: JobRead
    try {
      vRead = this.getJobsRegistry().read(id as never)
    } catch (err) {
      if (
        err instanceof Error &&
        (/unknown job/i.test(err.message) ||
          /belongs to another session/i.test(err.message))
      ) {
        throw new SeamInvalidArgumentErrorImpl(`JobsControlSeam.read: id ${id} not found`)
      }
      throw err
    }
    return {
      text: vRead.text,
      snapshot: vRead.snapshot,
      summary: this.snapshotToSummary(vRead.snapshot as never),
    }
  }

  async kill(id: string, reason?: string): Promise<{ ok: boolean }> {
    const result = this.getJobsRegistry().kill(
      id as never,
      undefined,
      reason,
    ) as 'requested' | 'already-finished'
    return { ok: result === 'requested' }
  }

  onChange(listener: SeamJobChangeListener): () => void {
    this.changeListeners.push(listener)
    return () => {
      const idx = this.changeListeners.indexOf(listener)
      if (idx >= 0) this.changeListeners.splice(idx, 1)
    }
  }

  destroy(): void {
    this.changeListeners.length = 0
    for (const off of this.cordisDisposers) {
      try {
        off()
      } catch {
        // ignore
      }
    }
    this.cordisDisposers.length = 0
  }

  // ── 私有 helper ────────────────────────────────────────────────

  private snapshotToSummary(snap: { id: unknown; kind: unknown; label?: unknown; status: SeamJobStatus; startedAt: unknown; finishedAt?: unknown; detail?: unknown }): SeamJobSummary {
    return {
      id: String(snap.id),
      kind: snap.kind as SeamJobKind,
      label: typeof snap.label === 'string' ? snap.label : '',
      status: snap.status,
      startedAt: typeof snap.startedAt === 'number' ? snap.startedAt : Date.now(),
      ...(snap.finishedAt !== undefined
        ? { finishedAt: typeof snap.finishedAt === 'number' ? snap.finishedAt : undefined }
        : {}),
      ...(typeof snap.detail === 'string' ? { detail: snap.detail } : {}),
    }
  }
}

/**
 * 公开工厂函数 — zai 端在 `createDshRuntime` 之后调一次。
 *
 * @example
 *   const jobsControl = createDshJobsControlBridge({ ctx: dshRuntime.ctx })
 */
export function createDshJobsControlBridge(opts: DshJobsAdapterOptions): JobsControlSeam {
  return new DshJobsControlAdapter(opts)
}
