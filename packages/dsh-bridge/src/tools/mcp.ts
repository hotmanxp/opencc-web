/**
 * MCP 工具桥 — **Phase 5P-MCP: DEPRECATED**。
 *
 * 本文件原是 dsh-bridge 自实现的 MCPClientPool + schema adapter,共 437 行,
 * 用 `@modelcontextprotocol/sdk` 客户端 + 全池管理 / 重连退避 / health check /
 * single-tenant 多 server 连接。
 *
 * Phase 5P-MCP 起改由 harness 官方 `@deepseek-ai/dsh-mcp-client` 替代:
 *   - 在 `createDshRuntime({ mcpServers: loadMcpServers(cwd) })` 装载阶段
 *     就调用 `ctx.loader.create({ name:'@deepseek-ai/dsh-mcp-client', config:...})`
 *     每个 server 一次(N servers = N plugin instances)。
 *   - 上游自带 reconnect + structured-content validation + schema validation;
 *     删除 dsh-bridge 自实现的 MCP_RETRY_DELAYS_MS / MCP_HEALTH_CHECK_INTERVAL_MS /
 *     DshMcpClientPool 类。
 *   - `~/.mcp.json` 解析仍由 zai 端 `loadMcpServers(cwd)` 处理(4 scope:
 *     enterprise > user > local > project)— dsh-bridge 不再读 fs。
 *
 * 保留本文件仅为:
 *   1. zai-side factory L198 仍 import `registerMcpTools` 通过 `registerZaiTools`
 *      — 现在 stub 函数返回 no-op dispose,不影响 zai-side 类型 / 调用栈。
 *   2. 老 caller 可能 import `McpServerSpec` / `McpTool` / `MCP_RETRY_DELAYS_MS`
 *      等常量 — 改 stub preserve 这些 export,值为 `@deprecated`。
 *   3. `tools/mcpSchema.ts`(140 行 JSON-Schema 适配器)— 已被 dsh-mcp-client
 *      自带 schema validation 替代,完全删除(并从 index.ts 移除 export)。
 */

import type { Context } from '@deepseek-ai/cordis'

/** @deprecated Use upstream `DshMcpServerSpec` from `@zn-ai/dsh-bridge` `createDshRuntime` opts。 */
export interface McpServerSpec {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
}

/** @deprecated Use upstream `ctx.tools.get('mcp__<server>__<tool>')` 枚举 model-visible 工具。 */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
  originalName: string
  execute: (input: unknown) => Promise<unknown>
}

/**
 * @deprecated 已删除:上游 dsh-mcp-client 自带 reconnect + exponential backoff
 *             + per-instance lifecycle 管理。旧的 `[1000,2000,4000,8000,16000]`
 *             退避表不再被任何 caller 使用。
 */
export const MCP_RETRY_DELAYS_MS: readonly number[] = [] as const

/** @deprecated 已删除:上游 dsh-mcp-client 不暴露周期性 ping;connection health 通过 reconnect 隐式表达。 */
export const MCP_HEALTH_CHECK_INTERVAL_MS = 0

/**
 * @deprecated Use upstream `DshMcpServerSpec` passed to `createDshRuntime({mcpServers})`。
 *             在 createDshRuntime 启动阶段,每个 spec 调
 *             `ctx.loader.create({name:'@deepseek-ai/dsh-mcp-client', config:{...}})`,
 *             工具名 `mcp__<server>__<tool>` 自动注册到 ctx.tools。
 *
 * 本 stub 函数保留仅为 zai-side `registerZaiTools({cwd})` 调用栈不报错。
 * 实际 MCP 工具注册由 createDshRuntime 装载阶段完成。
 */
export async function registerMcpTools(
  _ctx: Context,
  _opts: { cwd: string },
): Promise<{
  disposers: Array<() => void>
  pool: unknown
  health: () => Record<string, { ok: boolean; lastError?: string }>
}> {
  // No-op: MCP 工具已在 createDshRuntime 装载阶段由 dsh-mcp-client 注册。
  // 保留返回类型契约以便不破坏 caller;disposers = [], health 永远 empty。
  return {
    disposers: [],
    pool: undefined,
    health: () => ({}),
  }
}
