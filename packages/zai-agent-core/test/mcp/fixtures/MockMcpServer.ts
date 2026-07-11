import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export type MockTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

export type MockResource = {
  uri: string
  name?: string
  mimeType?: string
  text?: string
}

export type MockMcpServerOptions = {
  tools?: MockTool[]
  resources?: MockResource[]
  failOnConnect?: boolean
  callToolImpl?: (name: string, args: unknown) => Promise<unknown>
}

export interface MockMcpServer {
  transport: Transport
  close: () => Promise<void>
  simulateDisconnect: () => void
}

/**
 * Build an in-memory MCP server pair and wire a `Server` to advertise
 * a fixed set of tools/resources, plus an optional `callToolImpl` override.
 * Returns the client-side transport plus teardown helpers.
 */
export async function startMockMcpServer(
  options: MockMcpServerOptions = {}
): Promise<MockMcpServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  if (options.failOnConnect) {
    // Immediately tear down the server side so the client's connect() fails.
    await serverTransport.start().catch(() => {})
    serverTransport.onclose?.()
    return {
      transport: clientTransport,
      close: async () => {
        try {
          await clientTransport.close()
        } catch {
          // best-effort
        }
      },
      simulateDisconnect: () => {
        clientTransport.onclose?.()
      },
    }
  }

  const server = new Server(
    { name: 'mock-mcp-server', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  )

  const tools = options.tools ?? []
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    })),
  }))

  const resources = options.resources ?? []
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      mimeType: r.mimeType,
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const found = resources.find((r) => r.uri === req.params.uri)
    if (!found) throw new Error(`resource not found: ${req.params.uri}`)
    return {
      contents: [{ uri: found.uri, mimeType: found.mimeType, text: found.text ?? '' }],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (options.callToolImpl) {
      const result = await options.callToolImpl(req.params.name, req.params.arguments)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
    return { content: [{ type: 'text', text: `called ${req.params.name}` }] }
  })

  await server.connect(serverTransport)

  return {
    transport: clientTransport,
    close: async () => {
      try {
        await server.close()
      } catch {
        // best-effort
      }
      try {
        await clientTransport.close()
      } catch {
        // best-effort
      }
    },
    simulateDisconnect: () => {
      clientTransport.onclose?.()
    },
  }
}

export type { JSONRPCMessage }