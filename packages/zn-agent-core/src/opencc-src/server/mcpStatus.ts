/**
 * MCP 状态映射(zai patch 2026-09-22,MCP live view)。
 *
 * `createOpenccRuntime` 的后台 MCP 连接把结果写进 `appState.mcp`,但过去
 * 没有任何入口读出来 —— 失败只有 console.warn。这里把「appState.mcp → 对外
 * 状态快照」的映射抽成纯函数:
 *
 *   1. 便于单测(spec 的输入面只有几个数组,不需要 boot 一个 headless
 *      runtime);
 *   2. 让 createOpenccRuntime-impl.ts(带 @ts-nocheck)只留接线代码。
 *
 * 输出形状见 ./serverTypes.js 的 OpenccMcpStatus —— 该文件是公开类型面,
 * 必须保持 self-contained,所以这里只 import 那些类型 + 一个无依赖的纯
 * 工具(normalization.ts 不 import 任何东西)。
 */

import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import type {
  OpenccMcpCommandSummary,
  OpenccMcpConnectFailure,
  OpenccMcpServerSummary,
  OpenccMcpStatus,
} from './serverTypes.js'

/** `mcp__<normalizedServer>__<tool|prompt>`,与 vendor client.ts:2132 同源。 */
export function mcpServerPrefix(name: string): string {
  return `mcp__${normalizeNameForMCP(name)}__`
}

/**
 * 输入面刻意收窄成结构类型:调用方传 appState.mcp(多余字段无所谓),
 * 单测直接喂最小 fixture。vendor 的 Tool / Command / MCPServerConnection
 * 都满足这个形状。
 */
export interface McpStateLike {
  clients?: Array<{ name: string; type: string; error?: string }>
  tools?: Array<{ mcpInfo?: { serverName?: string } }>
  commands?: Array<{
    name: string
    description?: string
    isMcp?: boolean
    argNames?: string[]
    userFacingName?: () => string
  }>
  connecting?: boolean
  lastConnectFailure?: OpenccMcpConnectFailure | null
}

/**
 * appState.mcp → OpenccMcpStatus。
 *
 * - `disabled` 的 client 是配置层面禁用,不出现在 servers 里(与
 *   connectMcpWithRetry 的"不计入失败"口径一致)。
 * - toolCount / commandCount 按 server 名前缀归属统计 —— tool 走 vendor 在
 *   每个 MCP 工具上挂的 `mcpInfo.serverName`(client.ts:1834),command 走
 *   `mcp__<normalizedServer>__` 前缀。
 * - 命令的 displayName 优先用 vendor 的 `userFacingName()`(`<server>:<prompt>
 *   (MCP)`);拿不到时用同样的格式兜底。
 */
export function buildMcpStatus(
  state: McpStateLike | undefined,
  opts: { lazyConnect: boolean },
): OpenccMcpStatus {
  const clients = (state?.clients ?? []).filter(c => c.type !== 'disabled')
  const tools = state?.tools ?? []
  const rawCommands = state?.commands ?? []

  const servers: OpenccMcpServerSummary[] = clients.map(c => ({
    name: c.name,
    type: c.type,
    toolCount: tools.filter(
      t => t.mcpInfo?.serverName === c.name,
    ).length,
    commandCount: rawCommands.filter(cmd =>
      cmd.name.startsWith(mcpServerPrefix(c.name)),
    ).length,
    ...(c.type === 'failed' && c.error ? { error: c.error } : {}),
  }))

  const commands: OpenccMcpCommandSummary[] = rawCommands
    .filter(
      cmd => cmd.isMcp === true || /^mcp__.+__/.test(cmd.name),
    )
    .map(cmd => {
      const owner = servers.find(s => cmd.name.startsWith(mcpServerPrefix(s.name)))
      const promptName = owner
        ? cmd.name.slice(mcpServerPrefix(owner.name).length)
        : cmd.name
      const custom =
        typeof cmd.userFacingName === 'function'
          ? cmd.userFacingName.call(cmd)
          : undefined
      return {
        name: cmd.name,
        displayName:
          custom || (owner ? `${owner.name}:${promptName} (MCP)` : cmd.name),
        description: cmd.description ?? '',
        serverName: owner?.name ?? '',
        ...(cmd.argNames ? { argNames: cmd.argNames } : {}),
      }
    })

  return {
    lazyConnect: opts.lazyConnect,
    connecting: state?.connecting ?? false,
    servers,
    commands,
    lastConnectFailure: state?.lastConnectFailure ?? null,
  }
}