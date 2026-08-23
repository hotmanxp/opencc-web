/**
 * dsh 工具注册基建 — B2 T2.1。
 *
 * 把 zai 的 compat/tools (buildDefaultTools 产物) 通过 `ctx.tools.register()`
 * 暴露给 dsh 模型。注册按 dsh Tools API (defineTool) 包装。
 *
 * **Phase 5P3 / 5P6 收口（2026-08-22）**:`bash` / `subagent` 工具已由上游
 * `@deepseek-ai/dsh-tool-bash` / `@deepseek-ai/dsh-tool-subagent` 通过
 * `dsh-bridge.patch.yml` 自动装载,模型可见名字也变成小写 `bash` /
 * `subagent`(对齐 dsh 官方)。zai-side 的 PascalCase 自实现
 * (`./bash.ts` createBashTool + `./subagent.ts` createAgentTool) 改
 * 成 deprecated no-op stub,本 registry 不再调用它们 — 但保留 export
 * 给现有单测(skeleton.test.ts 等)继续验证 cwd 检测 / 平台分发逻辑。
 *
 * **Bash 后台任务转发**(替代旧的 onBackgroundStart / notifyBackground 回调):
 *   - 订阅 `ctx.jobs.onJobsChanged`(上游 JobRegistry seam),
 *   - diff `jobs.list()` 与本地缓存的 JobSnapshot,
 *   - 新出现的 `kind === 'bash'` 任务 → 调 `opts.onBackgroundStart`,
 *   - 状态切到 terminal (completed/killed/failed) 的 bash 任务 → 调
 *     `opts.notifyBackground`。
 *   标签(label)直接用上游 `JobSnapshot.label`(bash tool 填的是 args.command)。
 *
 * **Subagent 任务转发**(替代旧的 onTaskStart / onTaskFinish 回调):
 *   - 订阅 `subagent/start` / `subagent/end`(上游 SubagentRuntime seam),
 *   - start 事件 → `opts.onTaskStart`,description/prompt 暂时空字符串
 *     (上游 SubagentRunInfo 不携带输入 prompt;要 capture 需订阅
 *     `tools/pre-execute` + 通过 child session id 反查,Phase 5P6+ 跟进)。
 *   - end 事件 → `opts.onTaskFinish`,stopReason 映射成 done/failed/cancelled。
 *
 * 工具能力面（B2 §4,Phase 5P3+ 收口后）：
 * - bash — **上游 @deepseek-ai/dsh-tool-bash**(小写 `bash`,见 dsh-bridge.patch.yml tool-bash row)
 * - Read/Edit/Write — 上游 @deepseek-ai/dsh-tool-fs(`read`/`write`/`edit`,Phase 5P2 收口)
 * - grep/glob — 上游 @deepseek-ai/dsh-tool-fs-search(`grep`/`glob`,Phase 4 P1 收口)
 * - MCP 客户端工具 — 上游 @deepseek-ai/dsh-mcp-client(每个 server 一个 plugin instance,Phase 5P-MCP)
 * - Skill — 上游 @deepseek-ai/dsh-tool-skill + dsh-skill-filesystem loader(本仓库尚未迁,Phase 5P4)
 * - subagent — **上游 @deepseek-ai/dsh-tool-subagent**(小写 `subagent`,Phase 5P6 收口)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobRegistry, JobStatus } from '@zn-ai/dsh-bridge/dsh-core'
// `registerBashTool` / `registerAgentTool` 改成 @deprecated no-op;此处不再 import。
// 保留 ./bash.js 的 LocalShellExecutor export 供 createDshRuntime 用(虽然 dsh 0.1.0-rc.8
// 还未做 stateful shell,LocalShellExecutor 暂未挂到 ctx.shell — 见 Phase 5P3 注释)。
import { registerRipgrepTool } from './ripgrep.js'
import { registerMcpTools } from './mcp.js'
import { registerSkillTools } from './skill.js'
import type { AgentToolParentAgent } from './subagent.js'
import { registerDisplayFilesTool } from './displayFiles.js'
import { registerTaskListTools } from './taskList.js' // @deprecated stub — no-op dispose
import { registerCronTools, type CronParentAgent } from './cron.js'

/**
 * Subagent 生命周期事件 payload 形态(对应上游 dsh-subagent/src/types.ts)。
 * dsh-bridge 不直接 import 上游类型,这里 local copy 避免 zai 端依赖收紧。
 */
interface SubagentRunInfoLike {
  readonly runId: { toString(): string }
  readonly provider: string
  readonly id: { toString(): string }
  readonly local: boolean
}
interface SubagentRunEndInfoLike extends SubagentRunInfoLike {
  readonly stopReason: 'completed' | 'cancelled' | 'error' | string
  readonly lastAssistantMessage?: unknown
}

export interface ZaiTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: unknown, ctx: unknown) => Promise<unknown>
}

export interface RegisterZaiToolsOptions {
  cwd: string
  /** 工具数据目录（用于 skill 解析、ripgrep 跳过等）。 */
  dataDir?: string
  /**
   * dsh-015 修复：后台 bash task 启动 sink — 转发到 zai `bashBackgroundTracker`,
   * 让 UI TaskDock 看到 dsh 后台任务。不传则不注册,UI 显示"暂无后台任务"。
   */
  onBackgroundStart?: (info: { taskId: string; command: string; cwd: string }) => void
  /**
   * dsh-016 修复：后台 bash task 完成/失败 sink — 转发到 zai `bashBackgroundTracker.markFinished`。
   * 状态用 `string` 与 BashNotifier 对齐（dsh-bridge 内部: `'done' | 'killed' | 'failed'`）。
   */
  notifyBackground?: (info: { taskId: string; status: string; cwd?: string }) => void
  /**
   * dsh-017 新增：当前 sessionId getter — 用于 Task* / Cron* / Agent 工具
   * 关联到正确的 session（持久化按 sessionId 拆桶,主计划 R4 隔离）。
   */
  getSessionId?: () => string | undefined
  /**
   * dsh-017 新增：拿父 agent 回调 — Cron 触发 + Agent subagent 通知。
   * 接受 `AgentToolParentAgent | CronParentAgent` 子集类型(只要有 followup)。
   * zai 端不用 import 完整 dsh Agent 类型。
   */
  getParentAgent?: (sessionId: string) => (AgentToolParentAgent & CronParentAgent) | undefined
  /**
   * dsh-017 新增：dsh agents service getter — Agent 工具 spawn 子 agent 需要。
   * 接受 dsh Agent 类型的最小子集(只要有 `create` 方法)。
   * zai 端把 `handle.ctx.get('agents')` 预解析后通过这个回调注入。
   */
  getAgentsService?: () => unknown
  /**
   * dsh-019 新增：传真实 cordis ctx — spawnDshSubagent 内部 createScope
   * 需要 ctx.plugin(scope)。不传则 fallback 到 stub(会报 ctx.plugin)。
   */
  getDshCtx?: () => Context | undefined
  /**
   * Phase 3 P0-A+ B1: provider profile name getter — Agent 工具 spawn
   * 子 agent 时需继承父 agent 的 provider,否则 dsh 抛 "has no provider/model"
   * (dsh-014 修复同样问题)。不传则 Agent 工具降级到 undefined,可能
   * 因 provider 缺失导致子 agent 立即 fail。
   */
  getProvider?: () => string | undefined
  /**
   * Phase 3 P0-A+ B1: 默认 model name getter — LLM 不传 model 时子 agent
   * 用 zai 配置的 defaultModel,避免 dsh 抛 "has no provider/model"。
   */
  getDefaultModel?: () => string | undefined
  /**
   * dsh-017 新增：subagent 任务启动 sink — 转发到 zai `subagentTracker` (类比
   * bashBackgroundTracker),让 UI TaskDock 看到 dsh subagent 任务。
   */
  onTaskStart?: (info: { taskId: string; description: string; prompt: string }) => void
  /**
   * dsh-017 新增：subagent 任务完成 sink — 转发到 zai `subagentTracker.markFinished`。
   */
  onTaskFinish?: (info: { taskId: string; status: 'done' | 'failed' | 'cancelled'; error?: string }) => void
  /**
   * dsh-017 新增：Task 变化 sink — 转发到 zai-side stateChangeBus.emit
   * 'v2_task.changed',让 UI TodoZone 实时刷新。
   */
  onTaskChange?: (info: { sessionId: string; task: { id: string; subject: string; status: string }; action: 'create' | 'update' }) => void
  /**
   * dsh-017 新增：Cron 变化 sink — 转发到 zai-side stateChangeBus.emit
   * 'cron.changed',让 UI 看到 cron 任务列表变化。
   */
  onCronChange?: (info: { action: 'create' | 'delete' | 'list' | 'fire'; task?: { id: string; cron: string; prompt: string; nextFireAt: number }; sessionId: string }) => void
}

/**
 * 注册 zai 工具到 dsh ctx.tools。
 *
 * 串行装配：bash 事件转发 → fs-search → MCP → Skill → DisplayFiles →
 * subagent 事件转发 → Task*(stub) → Cron，并把各工具的 disposer
 * 聚合为一个统一 disposer 返回（用于 zai-side 卸载场景）。
 *
 * **Phase 5P3 + 5P6 收口**：bash / subagent 不再由本函数注册
 * defineTool — 改由 dsh-bridge.patch.yml 自动装载上游
 * `@deepseek-ai/dsh-tool-bash` / `@deepseek-ai/dsh-tool-subagent`。
 * 本函数只订阅上游 JobRegistry + SubagentRuntime 事件,转发到 zai-side
 * bashTracker / stateChangeBus(`opts.onBackgroundStart` /
 * `notifyBackground` / `onTaskStart` / `onTaskFinish`)。
 */
export async function registerZaiTools(
  ctx: Context,
  opts: RegisterZaiToolsOptions,
): Promise<() => void> {
  const disposers: Array<() => void> = []

  // 1. Bash 后台任务事件转发 — Phase 5P3 收口后,改订阅上游 `ctx.jobs`
  //    替代旧的自实现 `registerBashTool`。see 文件顶部 docblock。
  disposers.push(subscribeBashTaskEvents(ctx, opts))

  // 2. fs 工具 — Phase 5P2: 改由 harness `@deepseek-ai/dsh-tool-fs` 提供,
  //    该插件已在 dsh-bridge.patch.yml 的 `tool-fs` row 装载,自动注册
  //    `read` / `write` / `edit` / (若 ctx.attachments 在场) `read_image`。
  //    zai-side UI renderer 在 toolRenderers/registry.ts 已同步加
  //    `read/write/edit` 映射 (Phase 3A)。FileStat 工具不再暴露 — 上游
  //    dsh-tool-fs 不带 stat;模型 stat 需求用 `read` + 一段 metadata 替代。
  //    旧的 `registerFsTools` 仍 export(标 @deprecated)但不再被本 registry 调用。

  // 3. fs-search 工具（`grep` + `glob`）— Phase 4 P1 起由 harness
  //    `@deepseek-ai/dsh-tool-fs-search` 提供（已通过 createDshRuntime
  //    的 ctx.loader.create 装载）。registerRipgrepTool 现在是兼容 shim
  //    返回 no-op dispose，仅保留 zai-side 历史 import 通路。
  disposers.push(registerRipgrepTool(ctx, { cwd: opts.cwd }))

  // 4. Phase 5P-MCP: MCP 工具已由上游 `@deepseek-ai/dsh-mcp-client` 在
  //    `createDshRuntime({mcpServers})` 装载阶段注册(`opts.mcpServers`
  //    由 zai factory 经 `loadMcpServers(cwd)` 提供)。本行 no-op dispose,
  //    保留 forward-compat dispose 链路。
  await registerMcpTools(ctx, { cwd: opts.cwd })

  // 5. Skill 工具（异步，扫描 skills 目录）
  disposers.push(...(await registerSkillTools(ctx, { cwd: opts.cwd })))

  // 6. dsh-017 新增：DisplayFiles 工具（目录列表）
  disposers.push(registerDisplayFilesTool(ctx, { cwd: opts.cwd }))

  // 7. Subagent 生命周期事件转发 — Phase 5P6 收口后,改订阅上游
  //    `subagent/start` / `subagent/end` 替代旧的自实现 `registerAgentTool`。
  disposers.push(subscribeSubagentEvents(ctx, opts))

  // 8. Phase 5P5: Task* 工具集已由上游 `dsh-tool-todo`(在 dsh-bridge.patch.yml 的
  //    `tool-todo` row 自动装载,Phase 1P1-B)接管。注册 model-facing 单工具
  //    `todo_write`(whole-list snapshot replace)。`opts.onTaskChange` 不再被
  //    消费 — 替换后 todo 状态变更通过 `ctx.sessionProjections.onChanged`
  //    filter key='todos' → translate/sessionEvents.ts 翻译成
  //    `state.v2_task.changed` 事件给 zai-side TodoZone 渲染。
  //    `registerTaskListTools` 仍是 no-op compat stub,不实际注册工具。

  // 9. dsh-017 新增：Cron 工具集（CronCreate/Delete/List — 3 个）
  if (opts.getSessionId && opts.getParentAgent) {
    disposers.push(registerCronTools(ctx, {
      getSessionId: opts.getSessionId,
      getParentAgent: opts.getParentAgent,
      onCronChange: opts.onCronChange,
    }))
  }

  // 整体返回 disposer
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (err) {
        console.warn('[dsh-bridge] registerZaiTools dispose error:', err)
      }
    }
  }
}

/**
 * 订阅上游 JobRegistry 事件,把 bash 任务的 lifecycle 翻译成
 * zai-side bashTracker 回调（onBackgroundStart / notifyBackground）。
 *
 * **替代旧 `registerBashTool` 的 cwdTracker / 后台任务逻辑**：
 * - cwd 跟踪能力丧失 — 上游 dsh-bash-local 暂未做 stateful shell
 *   （见 `packages/deepseek-harness/packages/shell/bash-local/src/index.ts:174`
 *   的 `XXX(stateful-shell)` TODO）。模型可通过 `workdir` 参数显式
 *   切换 cwd（zai-side 在工具调用里透传），但自动跟随 `cd <path>` 不再
 *   工作。Phase 5P3+ 跟进上游 stateful shell。
 * - 后台任务转发用上游 JobRegistry 的 onJobsChanged seam:
 *   - 维护本地 `Map<JobId, JobStatus>` 缓存已知的 bash 任务,
 *   - 每次 onJobsChanged 触发后调 `jobs.list()` 拿当前快照,
 *   - diff: 新出现 → 调 `opts.onBackgroundStart`,
 *     状态切到 terminal(completed/killed/failed)→ 调 `opts.notifyBackground`。
 * - JobSnapshot.label 在 bash tool 里是 `args.command`(`tool-bash/src/index.ts:367`),
 *   直接当作 command 传给 zai-side bashTracker。
 */
function subscribeBashTaskEvents(
  ctx: Context,
  opts: RegisterZaiToolsOptions,
): () => void {
  if (!opts.onBackgroundStart && !opts.notifyBackground) return () => {}
  const jobs = ctx.get('jobs') as JobRegistry | undefined
  if (!jobs) {
    console.warn(
      '[dsh-bridge] subscribeBashTaskEvents: ctx.jobs missing — bash 后台任务不转发到 zai-side bashTracker',
    )
    return () => {}
  }

  /** 本地缓存:已知的 bash 任务快照(只存 status 用于检测 status 变迁)。 */
  const bashJobs = new Map<JobId, JobStatus>()

  /**
   * 把上游 JobStatus 翻译成 zai-side bashTracker 期望的状态字符串。
   * 上游: 'completed' / 'killed' / 'failed'(见 dsh-jobs/src/types.ts:17)。
   * zai-side (stateChangeBus + bashTracker): 'done' / 'killed' / 'failed'。
   */
  function statusToNotify(status: JobStatus): 'done' | 'killed' | 'failed' {
    if (status === 'completed') return 'done'
    if (status === 'killed') return 'killed'
    return 'failed'
  }

  function isTerminal(status: JobStatus): boolean {
    return status === 'completed' || status === 'killed' || status === 'failed'
  }

  function diffAndNotify(): void {
    const current = jobs!.list().filter((s) => s.kind === 'bash')
    const currentIds = new Set<JobId>(current.map((s) => s.id))

    for (const snap of current) {
      const prev = bashJobs.get(snap.id)
      bashJobs.set(snap.id, snap.status)

      // 1) 新出现的 bash 任务 — 触发 onBackgroundStart(若已不在 tracker 中)
      if (prev === undefined) {
        opts.onBackgroundStart?.({
          taskId: snap.id,
          command: snap.label,
          cwd: '', // 上游 JobSnapshot 没 workdir(zai 端 _cwd 本来就 unused,见 zai dsh.ts:235)
        })
        continue
      }

      // 2) 状态切到 terminal 且上次还不是 terminal — 触发 notifyBackground
      if (prev !== snap.status && isTerminal(snap.status) && !isTerminal(prev)) {
        opts.notifyBackground?.({
          taskId: snap.id,
          status: statusToNotify(snap.status),
          cwd: '',
        })
      }
    }

    // 3) 清理已不在列表里的任务(job disposal 后 list() 看不到)
    for (const id of bashJobs.keys()) {
      if (!currentIds.has(id)) bashJobs.delete(id)
    }
  }

  // onJobsChanged 触发后做一次 diff(不依赖 push 模型,直接 pull 拿当前 list)。
  // 上游语义保证每次可见集合变化都会触发一次(注册、stopping、settlement、
  // owner-disposal 移除、service disposal 空化)。
  const disposeOnChange = jobs.onJobsChanged(() => {
    try {
      diffAndNotify()
    } catch (err) {
      console.warn('[dsh-bridge] bash tasks diff error:', err)
    }
  })

  // 冷启动补偿 — 若创建订阅时已有 bash 任务(罕见,如 race condition),
  // 首次扫描就把它们注册到 zai bashTracker(初始 status 一般是 'running')。
  try {
    diffAndNotify()
  } catch {
    /* 冷启动失败不影响 dispose;后续 onJobsChanged 会再尝试 */
  }

  return () => {
    try { disposeOnChange() } catch { /* ignore */ }
    bashJobs.clear()
  }
}

/**
 * 订阅上游 SubagentRuntime 事件,把 subagent 任务的 lifecycle 翻译成
 * zai-side bashTracker + stateChangeBus 回调（onTaskStart / onTaskFinish）。
 *
 * **替代旧 `registerAgentTool` 的 subagentTracker / stateChangeBus 转发**:
 * - 上游 `@deepseek-ai/dsh-subagent` 在每次 run / continuable epoch
 *   同步发 `subagent/start` + `subagent/end` 一对事件(见 dsh-subagent/README.md:92)。
 * - description / prompt 暂不携带:SubagentRunInfo 只有 runId / provider /
 *   id / local 四个字段(dsh-subagent/src/types.ts:36-50)。
 *   capture 需订阅 `tools/pre-execute` + 通过 child session id 反查;
 *   Phase 5P6+ 跟进。本次先发空 description / prompt — zai UI 显示 taskId。
 * - stopReason → status 映射:
 *   - 'completed'  → 'done'
 *   - 'cancelled'  → 'cancelled'
 *   - 其他 (含 'error') → 'failed',error 取 diagnostic(若 upstream 提供)。
 */
function subscribeSubagentEvents(
  ctx: Context,
  opts: RegisterZaiToolsOptions,
): () => void {
  if (!opts.onTaskStart && !opts.onTaskFinish) return () => {}

  function stopReasonToStatus(reason: string): 'done' | 'failed' | 'cancelled' {
    if (reason === 'completed') return 'done'
    if (reason === 'cancelled') return 'cancelled'
    return 'failed'
  }

  const offStart = opts.onTaskStart
    ? ctx.on('subagent/start', (info: SubagentRunInfoLike) => {
        try {
          opts.onTaskStart?.({
            taskId: info.runId.toString(),
            description: '', // 暂留空(见文件注释)
            prompt: '',
          })
        } catch (err) {
          console.warn('[dsh-bridge] subagent/start forward error:', err)
        }
      })
    : () => {}
  const offEnd = opts.onTaskFinish
    ? ctx.on('subagent/end', (info: SubagentRunEndInfoLike) => {
        try {
          const status = stopReasonToStatus(info.stopReason)
          opts.onTaskFinish?.({
            taskId: info.runId.toString(),
            status,
            // 提取 diagnostic 若 upstream 有附带;本次接口不暴露,留 undefined。
            ...status === 'failed' ? { error: undefined } : {},
          })
        } catch (err) {
          console.warn('[dsh-bridge] subagent/end forward error:', err)
        }
      })
    : () => {}

  return () => {
    try { offStart() } catch { /* ignore */ }
    try { offEnd() } catch { /* ignore */ }
  }
}

/**
 * 工具事件 → ServerEvent 翻译（B2 T2.5）。
 *
 * dsh 侧 tool/call + tool/result 已由 B1a T1.3 翻译；本模块负责把 zai 侧的
 * 工具输入/输出字段对齐（toolName/input/output/耗时），保证双轨前端展示一致。
 */
export function normalizeToolEvent(parts: {
  toolName: string
  input: unknown
  output: unknown
  durationMs?: number
}): {
  toolName: string
  input: unknown
  output: unknown
  durationMs: number
} {
  return {
    toolName: parts.toolName,
    input: parts.input,
    output: parts.output,
    durationMs: parts.durationMs ?? 0,
  }
}