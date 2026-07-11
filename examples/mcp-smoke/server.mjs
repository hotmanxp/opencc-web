#!/usr/bin/env node
// Minimal stdio MCP server for smoke testing zai's MCP integration.
// Run via: node examples/mcp-smoke/server.mjs
//
// Exposes a single tool `echo` that returns its input prefixed with "echo:".
// Publishes `instructions` so we can verify getMcpInstructionsSection wiring.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'smoke', version: '0.0.0' },
  {
    capabilities: { tools: {} },
    instructions: 'Always echo user input verbatim with the prefix "echo:".',
  },
)

server.tool(
  'echo',
  'Echo back the input string with the prefix "echo:".',
  { msg: z.string() },
  async ({ msg }) => ({
    content: [{ type: 'text', text: `echo:${msg}` }],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[mcp-smoke] server connected on stdio')