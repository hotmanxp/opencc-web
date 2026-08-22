/**
 * MCP 工具桥 — B2 T2.3。
 *
 * 复用 zai MCPClientPool + MCPToolAdapter + permission-matcher，把 MCP 服务
 * 器工具在 dsh 侧注册为可用工具。
 *
 * 连接语义沿用「按需连接，不阻塞启动」(对齐 zai connectMcp:false 现状)。
 *
 * **TODO（P0-2）真实实现**：dsh 上游未提供 dsh-mcp 包；本模块需自实现 MCP provider：
 * 1. 子类化 ctx.tools.register 的 ToolRuntime 插件
 * 2. 调 zai MCPClientPool.listAllTools(cwd) 拉取工具列表
 * 3. 把每个工具包装为 defineTool 调用 ctx.tools.register
 * 4. 实现 permission-matcher 对齐 zai approveRegistry
 *
 * 预计工作量 1-2 天。
 */

import type { Context } from '@deepseek-ai/cordis'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** MCP server name — 用于运行时连接。 */
  serverName: string
  execute: (input: unknown, ctx: unknown) => Promise<unknown>
}

/**
 * 把 zai MCPClientPool 提供的工具包装为 dsh 兼容工具。
 *
 * 当前为 stub：B2 T2.3 真实接线。
 */
export async function listZaiMcpTools(_cwd: string): Promise<McpTool[]> {
  // 复用 zai `MCPClientPool.listAllTools(cwd)`，每个 tool 转 McpTool。
  return []
}

export function registerMcpTools(_ctx: Context, _tools: McpTool[]): void {
  // 当前 stub：B2 T2.3 真实接线 ctx.tools.register。
}