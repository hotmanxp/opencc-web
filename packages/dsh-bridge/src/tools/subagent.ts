/**
 * Agent 工具 — dsh 风格 (dsh-017)。
 *
 * 把 `spawnDshSubagent` (subagent/taskStore.ts) 包成 dsh `defineTool`,
 * 对齐 opencc AgentTool 的 input schema (description / prompt / subagent_type /
 * model / run_in_background),让 dsh 模式 LLM 能调 subagent spawn。
 *
 * opencc AgentTool input schema 参考 packages/zn-agent-core/src/opencc-src/
 * tools/AgentTool/AgentTool.tsx:94-99;opencc 走 zod 4 + lazySchema,dsh 走
 * dsh-tools 的 schemastery 参数描述(对齐 fs.ts 的 parameters 形态)。
 *
 * **Phase 1 范围** (本次):
 *   - description + prompt + subagent_type + model + run_in_background
 *   - 父 session 自动从 opts.getParentSessionId() 拉
 *   - 父 agent 自动从 ctx.agents.get(parentSessionId) 拉
 *   - run_in_background 立即返回 taskId;否则 await handle.promise 拿结果
 *
 * **Phase 2 范围** (暂不实现):
 *   - name / team_name / mode / isolation / cwd 字段(opencc 多 agent 模式)
 *   - subagent_type 路由: Phase 1 默认 'general-purpose',其他类型报清晰错误
 *   - worktree 隔离: dsh 0.1.0-rc.7 不支持
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  spawnDshSubagent,
  type DshTaskState,
} from '../subagent/taskStore.js'

/**
 * dsh Agent 接口最小子集 — zai 端不直接 import @deepseek-ai/dsh-agent,
 * 而是通过 dsh-bridge 暴露这个 type 来约束 contract(只要 zai 端返回的对象
 * 有 followup / session / cancel 字段,subagent.ts 的 spawnDshSubagent 就能用)。
 */
export type AgentToolParentAgent = {
  followup: (msg: unknown) => void
  session: unknown
  cancel: (cause: { kind: 'user' }) => void
}

/** Agent 工具选项 — 跟 registerBashTool 对齐,接 zai 端注入的 sink。 */
export interface AgentToolOptions {
  /** 当前 cwd — 子 agent 继承。 */
  cwd: string
  /** 父 session id — 通知父 agent 时需要。 */
  getParentSessionId: () => string | undefined
  /**
   * 当前 dsh provider profile name — 子 agent 需继承(否则 dsh 在
   * agent/request waterfall 找不到 provider/model,抛 "has no provider/model"
   * 错误)。dsh-014 修复同样问题。zai dsh factory 注入 'anthropic' (B1a
   * T1.4 收口的 default profile)。
   */
  getProvider?: () => string | undefined
  /**
   * Phase 3 P0-A+ B1: 默认 model name — LLM 没显式传 model 时,子 agent
   * 用 zai 配置的 defaultModel (settings.json model 或 ANTHROPIC_DEFAULT_SONNET_MODEL)。
   * 不传则用 LLM 输入的 `model` 字段(undefined 时 dsh 抛 "has no provider/model")。
   */
  getDefaultModel?: () => string | undefined
  /**
   * 拿父 agent 回调 — Cron 触发时用 + Agent 工具 spawn 后通知父 agent 用。
   * 接受 `AgentToolParentAgent` 子集类型(只要有 followup / session / cancel
   * 字段即可),zai 端不用 import 完整 dsh Agent 类型。
   */
  getParentAgent?: (sessionId: string) => AgentToolParentAgent | undefined
  /**
   * dsh agents service 提供者 — dsh-tools ToolRunContext 不含 cordis ctx,
   * 需要 zai 端把 ctx.get('agents') 预解析后注入。Agent 工具 spawn 子 agent
   * 时需要这个 service。
   */
  getAgentsService?: () => import('@deepseek-ai/dsh-agent').Agent | unknown | undefined
  /**
   * dsh-019 修复:`ctx.plugin is not a function` 错误 — spawnDshSubagent 内部
   * 用 `createScope(parentCtx, ...)` 创建子 scope,需要 parentCtx.plugin(scope)
   * 装载 scope 内部 cordis 实例。stub ctx(只 mock get)缺 plugin 方法,
   * 报 "ctx.plugin is not a function"。zai 端传真实 handle.ctx 走这条路,
   * getAgentsService 仍保留(供 ctx.get('agents') fallback)。
   */
  getDshCtx?: () => Context | undefined
  /**
   * 子任务启动 sink — 转发到 zai `subagentTracker` (类比 bashBackgroundTracker),
   * 让 UI TaskDock 看到 dsh subagent 任务。不传则不注册。
   */
  onTaskStart?: (info: { taskId: string; description: string; prompt: string }) => void
  /**
   * 子任务完成 sink — 转发到 zai `subagentTracker.markFinished`。
   * 状态: 'running' → 'done' / 'failed' / 'cancelled'。
   */
  onTaskFinish?: (info: {
    taskId: string
    status: 'done' | 'failed' | 'cancelled'
    error?: string
  }) => void
  /**
   * Stage 7: 子代理完成时是否 wakeup 父 agent。
   *   - 'wakeup'(默认):完成后通过 `parentAgent.followup(<task-notification>)`
   *     注入父 session inbox(等价 vendor `completionDelivery='wakeup'`)。
   *   - 'quiet':跳过 followup,只走 onTaskFinish / zai SSE(等价 vendor
   *     `completionDelivery='quiet'`)。
   */
  completionDelivery?: 'wakeup' | 'quiet'
  /**
   * Stage 7: zai 端在多少连续 wakeup 后自动转 quiet,防 LLM 自循环。
   * 缺省 3(对齐 vendor `tool-jobs/Config.maxConsecutiveWakes` 默认)。
   * 注意:本 stage 不在 tool 内自动切换 — zai factory 在调用工具前根据
   * counter(parentSessionId) 决策;若 zai 端省略,工具一律 wakeup。
   */
  maxConsecutiveWakes?: number
}

/**
 * 格式化任务结果文本 — 给 LLM 看。
 */
function formatTaskResult(state: DshTaskState): string {
  if (state.status === 'done') {
    return `[dsh-subagent task ${state.taskId} completed in ${state.finishedAt! - state.startedAt}ms]\n\nResult:\n${typeof state.result === 'string' ? state.result : JSON.stringify(state.result ?? null, null, 2)}`
  }
  if (state.status === 'failed') {
    return `[dsh-subagent task ${state.taskId} failed in ${state.finishedAt! - state.startedAt}ms]\n\nError: ${state.error ?? '(unknown)'}`
  }
  if (state.status === 'cancelled') {
    return `[dsh-subagent task ${state.taskId} was cancelled]`
  }
  return `[dsh-subagent task ${state.taskId} still running; this should not happen when await finished]`
}

// NOTE: createAgentTool / registerAgentTool removed — deprecated (2026-08-22).
// Use spawnDshSubagent + dsh-tools defineTool directly instead.