// @ts-nocheck -- adapts MCP SDK tool descriptors to the opencc-internals Tool
// shape used by zai-agent-core's queryEngine.

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchemaToZod } from './jsonSchemaToZod.js'
import { makeMcpToolName, MAX_MCP_DESCRIPTION_LENGTH } from './tool-name.js'
import { formatMcpError } from './errors.js'
import type { MCPClientPool } from './MCPClientPool.js'

export type MCPToolInfo = {
  serverName: string
  originalName: string
}

/**
 * Adapt MCP server tools to zai's opencc Tool shape.
 *
 * Mirrors the legacy adapter for built-in tools (see
 * `tools/legacyAdapter.ts`): wraps each tool with the opencc Tool contract
 * (`description()`, `prompt()`, `checkPermissions()`,
 * `mapToolResultToToolResultBlockParam()`, etc.) and returns `data`/`isError`
 * from `call()` per opencc convention.
 */
export async function adaptMcpTools(
  pool: MCPClientPool,
  serverName: string,
): Promise<Tool[]> {
  if (!pool.hasClient(serverName)) return []
  const client = pool.getClient(serverName)
  let result
  try {
    result = await client.listTools()
  } catch {
    return []
  }
  const tools = result.tools ?? []
  return tools.map(t => adaptOne(t, serverName, client))
}

function adaptOne(
  t: { name: string; description?: string; inputSchema?: unknown },
  serverName: string,
  client: import('@modelcontextprotocol/sdk/client/index.js').Client,
): Tool {
  const fullName = makeMcpToolName(serverName, t.name)
  const inputSchema = jsonSchemaToZod(t.inputSchema)
  const descriptionText = t.description ?? t.name
  const promptText = descriptionText.length > MAX_MCP_DESCRIPTION_LENGTH
    ? descriptionText.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
    : descriptionText

  return {
    name: fullName,
    isMcp: true,
    mcpInfo: { serverName, originalName: t.name } as any,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    isLsp: false,
    shouldDefer: false,
    maxResultSizeChars: 100_000,
    inputSchema: inputSchema as any,
    inputJSONSchema: t.inputSchema as any,
    aliases: undefined,

    async description() {
      return `[mcp:${serverName}] ${descriptionText}`
    },
    async prompt() {
      return promptText
    },

    async checkPermissions(input: unknown) {
      // Per-tool permission defaults to allow; runtime `canUseTool` is
      // consulted before this entry point by `executeToolsStreaming`.
      return { behavior: 'allow', updatedInput: input }
    },

    toAutoClassifierInput(input: unknown) {
      if (typeof input === 'string') return input
      try { return JSON.stringify(input) } catch { return String(input) }
    },

    userFacingName: () => `${serverName}:${t.name}`,

    mapToolResultToToolResultBlockParam(content: unknown) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: typeof content === 'string' ? content : JSON.stringify(content),
        is_error: false,
      }
    },

    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    isResultTruncated: () => false,
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: false }),

    async call(input: unknown, ctx: any, _canUseTool?: any, _parentMessage?: any) {
      // Look up callTimeoutMs from the runtime config the queryEngine
      // attaches to ctx (`__runtimeConfig` is the zai legacy escape hatch).
      const serverSpec = ctx.__runtimeConfig?.mcpServers?.find(
        (s: any) => s.name === serverName,
      )
      const timeoutMs = serverSpec?.callTimeoutMs ?? 30_000
      try {
        const result = await client.callTool(
          { name: t.name, arguments: input as Record<string, unknown> },
          CallToolResultSchema,
          {
            signal: AbortSignal.any([
              ctx.abortSignal,
              AbortSignal.timeout(timeoutMs),
            ]),
          },
        )
        const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
        const text = content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
        const isError = (result as { isError?: boolean }).isError ?? false
        return {
          data: text || JSON.stringify(content),
          isError,
        }
      } catch (err) {
        return {
          data: formatMcpError(err, serverName),
          isError: true,
        }
      }
    },
  } as unknown as Tool
}