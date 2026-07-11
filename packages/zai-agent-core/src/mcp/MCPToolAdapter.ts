import type { z, ZodTypeAny } from 'zod'
import type { Tool, ToolContext } from '../tools/Tool.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchemaToZod } from './jsonSchemaToZod.js'
import { makeMcpToolName } from './tool-name.js'
import { formatMcpError } from './errors.js'
import type { MCPClientPool } from './MCPClientPool.js'

export type MCPTool = Tool<ZodTypeAny, unknown> & {
  isMcp: true
  mcpInfo: { serverName: string; originalName: string }
}

export async function adaptMcpTools(pool: MCPClientPool, serverName: string): Promise<MCPTool[]> {
  if (!pool.hasClient(serverName)) return []
  const client = pool.getClient(serverName)
  try {
    const result = await client.listTools()
    const tools = result.tools ?? []
    return tools.map((t) => adaptOne(t, serverName, client))
  } catch {
    return []
  }
}

function adaptOne(
  t: { name: string; description?: string; inputSchema?: unknown },
  serverName: string,
  client: import('@modelcontextprotocol/sdk/client/index.js').Client
): MCPTool {
  const inputSchema = jsonSchemaToZod(t.inputSchema)
  return {
    name: makeMcpToolName(serverName, t.name),
    description: `[mcp:${serverName}] ${t.description ?? t.name}`,
    inputSchema,
    isMcp: true,
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    mcpInfo: { serverName, originalName: t.name },
    async call(input: unknown, ctx: ToolContext) {
      const serverSpec = ctx.__runtimeConfig?.mcpServers?.find((s) => s.name === serverName)
      const timeoutMs = serverSpec?.callTimeoutMs ?? 30_000
      try {
        const result = await client.callTool(
          { name: t.name, arguments: input as Record<string, unknown> },
          CallToolResultSchema,
          { signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeoutMs)]) }
        )
        const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
        const text = content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
        const isError = (result as { isError?: boolean }).isError ?? false
        return { output: text || JSON.stringify(content), isError }
      } catch (err) {
        return { output: formatMcpError(err, serverName), isError: true }
      }
    },
  }
}
