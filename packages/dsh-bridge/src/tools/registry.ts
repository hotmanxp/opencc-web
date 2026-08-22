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
  disposers.push(registerBashTool(ctx, { cwd: opts.cwd }))

  // 2. fs 工具（FileRead/Edit/Write/Stat — 4 个工具）
  disposers.push(...registerFsTools(ctx, { cwd: opts.cwd }))

  // 3. ripgrep 工具（PATH rg 优先 + 内置 fallback）
  disposers.push(registerRipgrepTool(ctx, { cwd: opts.cwd }))

  // 4. MCP 工具（异步，async connect）
  const { disposers: mcpDisposers } = await registerMcpTools(ctx, { cwd: opts.cwd })
  disposers.push(...mcpDisposers)

  // 5. Skill 工具（异步，扫描 skills 目录）
  disposers.push(...(await registerSkillTools(ctx, { cwd: opts.cwd })))

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