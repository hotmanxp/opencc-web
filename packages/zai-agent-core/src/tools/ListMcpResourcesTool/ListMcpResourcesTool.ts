import { z } from 'zod'
import type { Tool } from '../Tool.js'

const inputSchema = z.object({
  serverName: z.string().optional(),
})

type Result = {
  serverName: string
  ok: boolean
  resources: unknown[]
  error?: string
}

export const ListMcpResourcesTool: Tool<typeof inputSchema, string> = {
  name: 'ListMcpResources',
  description:
    'List resources exposed by connected MCP servers. Optionally filter by serverName.',
  inputSchema,
  isReadOnly: () => true,
  async call(input, ctx) {
    const pool = ctx.__runtimeConfig?.mcpClientPool
    if (!pool) {
      return { output: 'mcpClientPool not configured', isError: true }
    }
    const health = pool.health()
    const targets = input.serverName ? [input.serverName] : Object.keys(health)
    const out: Result[] = []
    for (const name of targets) {
      if (!pool.hasClient(name)) {
        out.push({
          serverName: name,
          ok: false,
          resources: [],
          error: health[name]?.error ?? 'not connected',
        })
        continue
      }
      try {
        const client = pool.getClient(name)
        const res = await client.listResources()
        out.push({ serverName: name, ok: true, resources: res.resources ?? [] })
      } catch (err) {
        out.push({
          serverName: name,
          ok: false,
          resources: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { output: JSON.stringify(out, null, 2) }
  },
}