/**
 * dsh 工具注册基建 — B2 T2.1。
 *
 * 把 zai 的 compat/tools (buildDefaultTools 产物) 通过 `ctx.tools.register()`
 * 暴露给 dsh 模型。注册按 dsh Tools API (defineTool) 包装。
 *
 * 工具能力面（B2 §4）：
 * - bash (cwd 跟踪 + 后台任务通知) — zai compat/tools/BashTool
 * - Read/Edit/Write (fs) — zai compat/tools/fs/*
 * - ripgrep — zai compat/vendor/ripgrep
 * - MCP 客户端工具 — MCPClientPool
 * - Skill — loadSkillsFromDirs() + SkillTool
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerBashTool } from './bash.js'
import { registerFsTools } from './fs.js'
import { registerRipgrepTool } from './ripgrep.js'
import { registerMcpTools } from './mcp.js'
import { registerSkillTools } from './skill.js'
import { registerAgentTool, type AgentToolParentAgent } from './subagent.js'
import { registerDisplayFilesTool } from './displayFiles.js'
import { registerTaskListTools } from './taskList.js'
import { registerCronTools, type CronParentAgent } from './cron.js'

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
 * 串行装配：bash → fs → ripgrep → MCP → Skill，并把各工具的 disposer
 * 聚合为一个统一 disposer 返回（用于 zai-side 卸载场景）。
 */
export async function registerZaiTools(
  ctx: Context,
  opts: RegisterZaiToolsOptions,
): Promise<() => void> {
  const disposers: Array<() => void> = []

  // 1. Bash 工具（含 cwd 跟踪 + 后台任务 + cwd tracker）
  disposers.push(
    registerBashTool(ctx, {
      cwd: opts.cwd,
      onBackgroundStart: opts.onBackgroundStart,
      notifyBackground: opts.notifyBackground,
    }),
  )

  // 2. fs 工具（FileRead/Edit/Write/Stat — 4 个工具）
  disposers.push(...registerFsTools(ctx, { cwd: opts.cwd }))

  // 3. ripgrep 工具（PATH rg 优先 + 内置 fallback）
  disposers.push(registerRipgrepTool(ctx, { cwd: opts.cwd }))

  // 4. MCP 工具（异步，async connect）
  const { disposers: mcpDisposers } = await registerMcpTools(ctx, { cwd: opts.cwd })
  disposers.push(...mcpDisposers)

  // 5. Skill 工具（异步，扫描 skills 目录）
  disposers.push(...(await registerSkillTools(ctx, { cwd: opts.cwd })))

  // 6. dsh-017 新增：DisplayFiles 工具（目录列表）
  disposers.push(registerDisplayFilesTool(ctx, { cwd: opts.cwd }))

  // 7. dsh-017 新增：Agent 工具（subagent spawn）
  disposers.push(registerAgentTool(ctx, {
    cwd: opts.cwd,
    getParentSessionId: opts.getSessionId ?? (() => undefined),
    getAgentsService: opts.getAgentsService,
    getDshCtx: opts.getDshCtx ?? (() => ctx),
    // Phase 3 P0-A+ B1: 子 agent 继承父 provider + model(避免
    // "has no provider/model" 错)。
    getProvider: opts.getProvider,
    getDefaultModel: opts.getDefaultModel,
    onTaskStart: opts.onTaskStart,
    onTaskFinish: opts.onTaskFinish,
  }))

  // 8. dsh-017 新增：Task 工具集（TaskCreate/Get/List/Update — 4 个）
  if (opts.getSessionId) {
    disposers.push(registerTaskListTools(ctx, {
      getSessionId: opts.getSessionId,
      onTaskChange: opts.onTaskChange,
    }))
  }

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