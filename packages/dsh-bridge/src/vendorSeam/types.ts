/**
 * dsh-bridge vendorSeam 类型层。
 *
 * 目的:zai 服务端(以及未来 Stage 4+ 的其他消费者)在 dsh 轨道上**不**直接
 * import `@deepseek-ai/dsh-*` 符号 — 通过 `@zn-ai/dsh-bridge` 间接消费,
 * 避免 zai 端引入 dsh-* 依赖面。本文件作为 zai-friendly re-export 入口,
 * 暴露 vendor 类型的可消费子集 + seam 接口契约。
 *
 * **source of truth = vendor types**:`@deepseek-ai/dsh-subagent` / `@deepseek-ai/dsh-jobs` /
 * `@deepseek-ai/dsh-session` 的命名类型**直接 re-export**（不重写、不 mirror）,
 * 让 vendor 接口形状真正是 source of truth — Stage 4+ 加 capability 时无需
 * 同步 ts 类型。
 *
 * seam 不变量(只对外承诺,不外借实现细节):
 *   - 一个进程 / one dsh runtime:一个 `<kind>-<N>` JobId 自增计数
 *     (`JobKindMap` 模块声明扩展由插件自做)
 *   - JobStatus `running` 可被「`stopping` 中间态」短暂占据(zzai 不暴露)
 *   - SubagentStopReason 五值与 vendor 一致
 *   - `run.result` never rejects(子代理失败 resolve 成 stopReason)
 *
 * 用户报核心 bug 的根因(必须记住):
 *   异步模式 (`backgroundMode: 'async'`) 子代理完成后,父 turn 已经 end —
 *   完成事件只能通过 `parentAgent.followup(<task-notification>)` 注入 idle
 *   parent inbox,**等下次提问触发新 turn 才被消费**。同步模式
 *   (`backgroundMode: 'sync'`) 才用 `await handle.promise`,父 turn 阻塞
 *   等子代理结束 → 子代理结果拿到后立即继续(SUBAGENT-001 修复见
 *   spawnDshSubagent 注释 + Phase 4 commit `400550a1`)。
 */

import type {
  SubagentStopReason,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  JobStatus,
  JobSnapshot,
  JobRead,
  JobKindMap,
} from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'

// ─────────────────────────────────────────────────────────────────────
// 公共别名层 — 暴露 vendor 类型的 zai-friendly 面
// ─────────────────────────────────────────────────────────────────────

/** vendor `SubagentStopReason`(五值枚举)— zai 端用 alias 形式消费。 */
export type SeamSubagentStopReason = SubagentStopReason

/** vendor `JobStatus` — zai 端用 alias 形式消费。 */
export type SeamJobStatus = JobStatus

/** vendor `JobKindMap` 默认子集 + 厂商中立扩展点(通过 module declaration merging)。 */
export type SeamJobKindMap = JobKindMap

/** vendor `SessionId` — 子代理 session id 品牌类型(直接透传)。 */
export type SeamSessionId = SessionId

/** vendor `JobSnapshot` — jobs UI 用 alias 形式消费。 */
export type SeamJobSnapshot = JobSnapshot

/** vendor `JobRead` — read() 返回 type。 */
export type SeamJobRead = JobRead

/** vendor `SubagentResult.output` 类型 — ContentBlock[]。 */
export type SeamContentBlock = ContentBlock

/** vendor `SubagentRun` — 只读投影(避免 zai 端 import 完整 type 触发 vendor 内部类型)。 */
export type SeamSubagentRun = Pick<
  SubagentRun,
  'id' | 'localAgent' | 'result' | 'dispose'
>

/** vendor `SubagentResult` — 同样只读投影。 */
export type SeamSubagentResult = Pick<SubagentResult, 'output' | 'stopReason' | 'diagnostic'>

// ─────────────────────────────────────────────────────────────────────
// 适配层(zai 关心的字段集)— zai 不直接 import vendor 内部类型
// ─────────────────────────────────────────────────────────────────────

/** `dispatch()` 输入。`parentSessionId` 必填,模型知道的"父 session"对应 zai 端 SSE 路由的 sessionId。 */
export interface SeamSubagentDispatchInput {
  /** 3-5 词描述,给 zai UI TaskDock 显示 + LLM tracking。 */
  description: string
  /** 子代理提示原文(vendor `prompt` 是 ContentBlock[],zai 端传纯文本,adapter 自动包成 `{type:'text'}`)。 */
  prompt: string
  /** 父 zai session id — 完成事件回流到该 session(`<task-notification>`)。 */
  parentSessionId: string
  /** 当前 zai cwd — 子代理继承。 */
  cwd: string
  /** 可选 model override — 缺省走 zai 配置的 defaultModel。 */
  model?: string
  /** 可选 LLM provider name — 缺省走 dsh-agent-default-model 的 default。 */
  provider?: string
  /**
   * 完成模式:
   *   - `'sync'`  = await handle.promise,父 turn 阻塞(已修,Phase 4 commit 400550a1)
   *   - `'async'` = 立刻返回 subagentId,完成时 <task-notification> 入父 inbox
   *                 (用户报"sess-1787409759412-aoh5xpnw 一直没返回"的根因分支)
   */
  backgroundMode: 'sync' | 'async'
  /**
   * 子代理模式(Stage 4 才会真正生效):
   *   - `'spawn'` = 子代理不继承父 prompt history(`inheritsParentContext: false`)
   *   - `'fork'`  = 子代理继承父 prompt history(`inheritsParentContext: true`,
   *                 走 vendor `ForkInProcessProvider`)
   *
   * **Stage 0/1/2/3 阶段一律视作 `'spawn'`** — `inheritsParentContext: false`。
   * Stage 4 加载 'fork' provider + UI 暴露 context 选项后再实装 fork 分支。
   */
  context: 'spawn' | 'fork'
  /** 输出 JSON Schema — 透传到 vendor SubagentStartRequest.outputSchema。 */
  outputSchema?: Record<string, unknown>
  /** 工具过滤白名单 — 透传到 vendor SubagentStartRequest.toolFilter。 */
  toolFilter?: string[]
  /** Persona 名称 — 透传到 vendor SubagentStartRequest.persona。 */
  persona?: string
  /** 最大调用深度 — 透传到 vendor SubagentStartRequest.maxDepth。 */
  maxDepth?: number
}

/**
 * `dispatch()` 返回 handle:
 *   - `id`       = zai-side taskId(`dsh-task-<timestamp>-<random>`),
 *                  磁盘 `~/.zai/tasks-dsh/<taskId>.json` 文件名
 *                  = `parentAgent.followup` 注入的 `<task-notification>` taskId
 *                  = `interruptDshSubagent` 输入
 *   - `promise`  = await 即得终态(DshTaskState)— sync 模式父 turn 阻塞
 *   - `dispose()`= vendor `SubagentRun.dispose()` 代理
 *
 * 不变量:`promise` never rejects — 子代理失败 resolve 成 `status: 'failed'`,
 *         只有 spawn 阶段基础设施故障 reject spawnDshSubagent 自身。
 */
export interface SeamSubagentHandle {
  readonly id: string
  readonly promise: Promise<SeamSubagentTerminalState>
  dispose(): Promise<void>
}

/** subagent 终态 shape —— zai-side 兼容现有 `DshTaskState`(subagent/taskStore.ts)。 */
export interface SeamSubagentTerminalState {
  taskId: string
  sessionId: string
  parentSessionId?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  prompt: string
  result?: unknown
  error?: string
}

/** 子代理变更监听器签名 — 推整个列表(summaries)。 */
export type SeamSubagentChangeListener = (summaries: SeamSubagentSummary[]) => void

/** 子代理摘要 — `list()` / `get()` 返回。 */
export interface SeamSubagentSummary {
  taskId: string
  sessionId: string
  parentSessionId?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  description: string
  startedAt: number
  finishedAt?: number
  /** vendor `SubagentStopReason` — sync/async 都暴露。 */
  stopReason?: SeamSubagentStopReason
  error?: string
}

/**
 * 2026-08-24 Blocker E: 子代理详情 — 在 `SeamSubagentSummary` 之上额外带
 * `blocks` (ContentBlock[]) 与 `toolCalls` (ToolCallEntry[]),供 zai UI
 * `SubagentDetailBody` 的 ContentBlockRenderer 渲染。文件缺失 / 解析失败
 * 返回空数组(不阻塞其他字段)。
 */
export interface SeamSubagentDetail extends SeamSubagentSummary {
  blocks?: import('../subagent/contentBlock.js').SubagentContentBlock[]
  toolCalls?: import('../subagent/taskStore.js').ToolCallEntry[]
}

// ─────────────────────────────────────────────────────────────────────
// Jobs 输入/输出 — mirror vendor JobStart/JobRead,加 zai 关心的子集
// ─────────────────────────────────────────────────────────────────────

/** job 类型 — vendor `JobKindMap` 子集(Stage 4 起可 plugins 扩展)。 */
export type SeamJobKind = keyof SeamJobKindMap

/**
 * `start()` 入参。要求 kind-specific input(union)由调用方保证 — adapter
 * 在拒绝路径抛清晰错误(SeamInvalidArgumentError)。Stage 0 仅契约冻结,
 * 第一个具体 kind `'bash'` 由 DshJobsControlAdapter.start() 实装;
 * `'subagent'` 在 Stage 5+ 实装(经由 SubagentControlSeam 二次委派)。
 */
export type SeamJobStartInput =
  | {
      kind: 'bash'
      label: string
      outputLimitBytes?: number
      input: SeamBashJobInput
    }
  | {
      kind: 'subagent'
      label: string
      outputLimitBytes?: number
      input: SeamSubagentDispatchInput
    }

/** 'bash' kind input shape。Stage 0 已有,Stage 6 起加 spill/graceMs/maxOutputBytes。 */
export interface SeamBashJobInput {
  command: string
  cwd: string
  /** 缺省 vendor 默认 120_000ms;Stage 6 起封顶 600_000ms。 */
  timeoutMs?: number
  /** 子代理 env override(可选)。Stage 0 仅传 vendor 透传。 */
  env?: Record<string, string>
  /** sandbox 模式 — Stage 0 透传 env(process.env.ZAI_SANDBOX);Stage 6+ 抽 config。 */
  sandbox?: 'off' | 'on'
}

/** `start()` 返回 — vendor `LocalJobRegistry.start` 同步返回 id。 */
export interface SeamJobStartResult {
  id: string
}

/** job 摘要 — `list()` 返回(简化 vendor JobSnapshot,只暴露 zai 关心的字段)。 */
export interface SeamJobSummary {
  id: string
  kind: SeamJobKind
  label: string
  status: SeamJobStatus
  startedAt: number
  finishedAt?: number
  detail?: string
}

/** job 变更监听器签名 — 等价 vendor JobsChangedListener(summaries 形式)。 */
export type SeamJobChangeListener = (summaries: SeamJobSummary[]) => void

// ─────────────────────────────────────────────────────────────────────
// 错误类型
// ─────────────────────────────────────────────────────────────────────

/** vendor `SubagentError('NO_PROVIDER' | 'UNSUPPORTED_CAPABILITY' | 'INVALID_ARGUMENT')` 投影。 */
export class SeamInvalidArgumentError extends Error {
  override readonly name = 'SeamInvalidArgumentError'
  constructor(message: string) {
    super(message)
  }
}

/** vendor `LocalJobRegistry` `maxConcurrentJobsPerOwner` 超限(默认 5)。 */
export class SeamConcurrentJobsExceededError extends Error {
  override readonly name = 'SeamConcurrentJobsExceededError'
  constructor(public readonly limit: number, public readonly ownerHint?: string) {
    super(
      `background job limit reached for this owner (limit: ${limit})${
        ownerHint ? ` — owner: ${ownerHint}` : ''
      }`,
    )
  }
}

/** 基础设施故障(provider 自身 / vendor 内部 throw)。 */
export class SeamRuntimeError extends Error {
  override readonly name = 'SeamRuntimeError'
  constructor(message: string) {
    super(message)
  }
}

// ─────────────────────────────────────────────────────────────────────
// Seam 接口契约(Stage 0 冻结;Stage 4+ 只加 capability,不破坏 surface)
// ─────────────────────────────────────────────────────────────────────

/**
 * 子代理控制 seam — zai 服务端唯一访问子代理的厂商中立面板。
 *
 * DSH 实现(`DshSubagentControlAdapter` in `subagent.ts`):委托给现有
 * `spawnDshSubagent` / `interruptDshSubagent` / `sendMessageToDshSubagent` /
 * `listDshSubagents`,内部走 vendor `SubagentRuntime`。
 *
 * **未来扩展(不破坏 surface)**:
 *   - Stage 4:`context: 'fork'`(挂 vendor ForkInProcessProvider)
 *   - Stage 5:caps 子集(`outputSchema` / `toolFilter` / `persona` /
 *     `maxDepth` / `backgroundMode === 'continuable'` 对接
 *     `SubagentRuntime.startContinuable`)
 */
export interface SubagentControlSeam {
  /**
   * 分发子代理。`async` 模式立刻返回 handle;`sync` 模式仍立刻返回,父 turn
   * 经 `await handle.promise` 等子代理结束。
   *
   * @throws {SeamInvalidArgumentError} 无效 input(parentSessionId/cwd 缺)
   * @throws {SeamRuntimeError} spawnDshSubagent 启动阶段基础设施故障
   */
  dispatch(input: SeamSubagentDispatchInput): Promise<SeamSubagentHandle>

  /** 读单个子代理最新状态(磁盘 lookup)— `null` 表示不存在。 */
  get(taskId: string): Promise<SeamSubagentSummary | null>

  /**
   * 读单个子代理详情 — 在 `get()` 之上额外拼 `blocks` (ContentBlock[]) 与
   * `toolCalls` (ToolCallEntry[])。`null` 表示不存在。blocks / toolCalls
   * 任一读失败降级到空数组,其它字段不受影响(2026-08-24 Blocker E)。
   */
  getDetail(taskId: string): Promise<SeamSubagentDetail | null>

  /** 列父会话派生的子代理 — 缺省不过滤(返回所有,ztai 端可二次过滤)。 */
  list(parentSessionId?: string): Promise<SeamSubagentSummary[]>

  /**
   * 中止子代理 — 已结束返回 `{ ok: false }`。
   * Stage 2 起改本接口,确保 SIGTERM 阶段自动走到 owner dispose;
   * Stage 0 仅手动 cancel。
   */
  cancel(taskId: string, reason?: string): Promise<{ ok: boolean }>

  /**
   * subagent_control.send_message — 把父 agent 指令入队,子代理下一轮 turn
   * 消费(vendor `subagentRuntime.followup(parent, childId, content)`)。
   */
  sendMessage(taskId: string, content: string): Promise<{ ok: boolean }>

  /**
   * 监听子代理列表变化 — 通过 ctx.subagents 的 `'subagent/start'` / `'subagent/end'`
   * 事件 + 磁盘读兜底(vendor ctx 不可用时仍工作)。
   * 返回 unsubscribe 函数。
   */
  onChange(listener: SeamSubagentChangeListener): () => void
}

/**
 * 后台任务控制 seam — zai 服务端唯一访问 bash 后台 / 子代理-化-job 的
 * 厂商中立面板。
 *
 * DSH 实现(`DshJobsControlAdapter` in `jobs.ts`):委托给 vendor
 * `ctx.jobs` (`@deepseek-ai/dsh-jobs-local` 的 `LocalJobRegistry`)。bash
 * 后台走 vendor `tool-bash` 的 `run_in_background` → `ctx.jobs.start({kind:'bash'})`;
 * subagent 化走 `tool-subagent` 的 `run_in_background: true` → `ctx.jobs.start({kind:'subagent'})`
 * → 内部走 `SubagentRuntime.start(...)`。
 *
 * **重要不变量(vendor 反直觉点)**:
 *   - bash 后台永远不 settle 成 `'failed'`(`ShellProcess` 没有 failed 字段)
 *     → zai-side 必须接受 `bash` jobs 终态只可能是 `'completed'` / `'killed'`
 *     → 文档见 deepseek-harness tool-bash/src/background.ts:18-22 `TODO(background-infrastructure-outcome)`
 *   - JobId 是 `<kind>-<N>` 自增,重启清零(进程内 Map)
 *   - vendor `LocalJobRegistry` **不**磁盘持久化(进程结束即丢)
 *   - owner-scoped `maxConcurrentJobsPerOwner` 默认 5,超限抛 `'background job limit reached'`
 *
 * **未来扩展**:
 *   - Stage 6:加 spill file 64KB / maxSpillBytes 64MB / graceMs 3000
 *   - Stage 7:wakeup/quiet 双投递策略 + 清理
 */
export interface JobsControlSeam {
  /** 启动 job — vendor 同步返回 id,不阻塞。 */
  start(input: SeamJobStartInput): Promise<SeamJobStartResult>

  /** 读单个 job 最新状态 — `null` 表示不存在。 */
  get(id: string): Promise<SeamJobSummary | null>

  /** 读所有 jobs — vendor `list()` 调用方隐含 owner fence(zai patch 简化:不分 owner)。 */
  list(): Promise<SeamJobSummary[]>

  /**
   * 读 + 消费 cursor — 流式返回自上次 read 的 delta,终态返回 idempotent 输出。
   * 等价 vendor `JobRegistry.read(id, caller)`。
   */
  read(id: string): Promise<SeamJobRead & { summary: SeamJobSummary }>

  /**
   * 取消 job — 等价 vendor `kill()`:
   *   - 终态 → `{ ok: false }`
   *   - live → `{ ok: true }`,status 进入 `'stopping'`,settle 后变成 `'killed'`/`'failed'`
   */
  kill(id: string, reason?: string): Promise<{ ok: boolean }>

  /** 监听 jobs 列表变化 — vendor `ctx.jobs.onJobsChanged` + `onJobDone`。 */
  onChange(listener: SeamJobChangeListener): () => void
}
