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

export interface ZaiTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: unknown, ctx: unknown) => Promise<unknown>
}

/**
 * 注册 zai 工具到 dsh ctx.tools。
 *
 * 真实实现需要 ctx.tools.register() 签名（dsh-tools API）；
 * B2 当前为接口契约，后续按 dsh-tools 实际 API 对接。
 */
export async function registerZaiTools(
  _ctx: Context,
  _tools: ZaiTool[],
): Promise<void> {
  // B2 T2.1 stub — 按 dsh-tools 的 defineTool / ctx.tools.register 签名实现。
  // 当前：先 import zai-side tools 让上层能验证依赖；register 调用留 B2 T2.2-T2.5。
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