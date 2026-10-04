import {
  type ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
  getMcpErrorCode,
  isMcpMethodNotFoundError,
  isMcpResourceNotFoundError,
} from '../../services/mcp/client.js'
import { findServersByName } from '../../services/mcp/normalization.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import {
  getBinaryBlobSavedMessage,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from '../ListMcpResourcesTool/prompt.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.object({
    server: z.string().describe('The MCP server name'),
    uri: z.string().describe('The resource URI to read'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    contents: z.array(
      z.object({
        uri: z.string().describe('Resource URI'),
        mimeType: z.string().optional().describe('MIME type of the content'),
        text: z.string().optional().describe('Text content of the resource'),
        blobSavedTo: z
          .string()
          .optional()
          .describe('Path where binary blob content was saved'),
      }),
    ),
    error: z
      .string()
      .optional()
      .describe('Human-readable error when the server could not read the resource'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ReadMcpResourceTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.server} ${input.uri}`
  },
  shouldDefer: true,
  name: 'ReadMcpResourceTool',
  // The description tells the model to call `readMcpResource`; without this
  // alias that name resolves to nothing.
  aliases: ['ReadMcpResource'],
  searchHint: 'read a specific MCP resource by URI',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { mcpClients } }) {
    const { server: serverName, uri } = input

    const client = findServersByName(mcpClients, serverName)[0]

    if (!client) {
      throw new Error(
        `Server "${serverName}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    if (client.type !== 'connected') {
      throw new Error(`Server "${serverName}" is not connected`)
    }

    if (!client.capabilities?.resources) {
      throw new Error(`Server "${serverName}" does not support resources`)
    }

    const connectedClient = await ensureConnectedClient(client)
    let result: ReadResourceResult
    try {
      result = (await connectedClient.client.request(
        {
          method: 'resources/read',
          params: { uri },
        },
        ReadResourceResultSchema,
      )) as ReadResourceResult
    } catch (error) {
      // A missing method or a stale URI is the model's to act on, not a broken
      // connection — say so in terms it can use instead of surfacing the raw
      // JSON-RPC error.
      if (isMcpMethodNotFoundError(error)) {
        logMCPError(
          client.name,
          'resources/read returned -32601 MethodNotFound — server advertises resources but does not implement reads',
        )
        return {
          data: {
            contents: [],
            error: `Server "${client.name}" advertises resource support but does not implement resource reads.`,
          },
        }
      }
      if (isMcpResourceNotFoundError(error)) {
        logMCPError(
          client.name,
          `resources/read returned ${getMcpErrorCode(error)} — resource not found`,
        )
        fetchResourcesForClient.cache.delete(client.name)
        return {
          data: {
            contents: [],
            error: `Resource not found: ${uri} — it may have been deleted or the URI is stale. Re-run ${LIST_MCP_RESOURCES_TOOL_NAME} to refresh.`,
          },
        }
      }
      throw error
    }

    // Intercept any blob fields: decode, write raw bytes to disk with a
    // mime-derived extension, and replace with a path. Otherwise the base64
    // would be stringified straight into the context.
    const contents = await Promise.all(
      result.contents.map(async (c, i) => {
        if ('text' in c) {
          return { uri: c.uri, mimeType: c.mimeType, text: c.text }
        }
        if (!('blob' in c) || typeof c.blob !== 'string') {
          return { uri: c.uri, mimeType: c.mimeType }
        }
        const persistId = `mcp-resource-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`
        const persisted = await persistBinaryContent(
          Buffer.from(c.blob, 'base64'),
          c.mimeType,
          persistId,
        )
        if ('error' in persisted) {
          return {
            uri: c.uri,
            mimeType: c.mimeType,
            text: `Binary content could not be saved to disk: ${persisted.error}`,
          }
        }
        return {
          uri: c.uri,
          mimeType: c.mimeType,
          blobSavedTo: persisted.filepath,
          text: getBinaryBlobSavedMessage(
            persisted.filepath,
            c.mimeType,
            persisted.size,
            `[Resource from ${serverName} at ${c.uri}] `,
          ),
        }
      }),
    )

    return {
      data: { contents },
    }
  },
  renderToolUseMessage,
  userFacingName,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (content?.error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: content.error,
      }
    }
    // Defensive guard: if content is undefined/null, return a clear indicator
    // rather than sending undefined to jsonStringify which would cause an error.
    if (content === undefined || content === null) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: '[No content returned from MCP resource]',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
