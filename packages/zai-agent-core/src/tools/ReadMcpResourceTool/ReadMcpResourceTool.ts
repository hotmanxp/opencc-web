import { z } from 'zod'
import type { LegacyTool } from '../Tool.js'

const inputSchema = z.object({
  serverName: z.string(),
  uri: z.string(),
})

type ResourceContent = { text?: string; blob?: string; mimeType?: string }

export const ReadMcpResourceTool: LegacyTool<typeof inputSchema, string> = {
  name: 'ReadMcpResource',
  description:
    'Read a single resource from a connected MCP server by serverName + uri.',
  inputSchema,
  isReadOnly: () => true,
  async call(input, ctx) {
    const pool = ctx.__runtimeConfig?.mcpClientPool
    if (!pool) {
      return { output: 'mcpClientPool not configured', isError: true }
    }
    if (!pool.hasClient(input.serverName)) {
      return {
        output: `mcp server not connected: ${input.serverName}`,
        isError: true,
      }
    }
    try {
      const client = pool.getClient(input.serverName)
      const res = await client.readResource({ uri: input.uri })
      const contents: ResourceContent[] = (res.contents ?? []) as ResourceContent[]
      const text = contents
        .map((c) => {
          if (typeof c.text === 'string') return c.text
          if (typeof c.blob === 'string') {
            return Buffer.from(c.blob, 'base64').toString('utf8')
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return { output: text || JSON.stringify(res.contents ?? []) }
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      }
    }
  },
}