#!/usr/bin/env node
// Smoke test for zai-agent-core's opencc-internals MCP integration.
//
// Spawns the stdio MCP server (server.mjs), connects via MCPClientPool,
// verifies:
//   1. The pool connects successfully
//   2. adaptMcpTools returns a tool with name `mcp__smoke__echo`
//   3. The tool's prompt()/description() return the opencc-format text
//   4. getMcpInstructionsSection produces the "MCP Server Instructions" block
//   5. Calling the tool returns "echo:hello" from the model client
//
// Run from the repo root:
//   node examples/mcp-smoke/smoke.mjs

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { MCPClientPool } from '../../packages/zai-agent-core/dist/mcp/MCPClientPool.js'
import { adaptMcpTools } from '../../packages/zai-agent-core/dist/mcp/MCPToolAdapter.js'
import { getMcpInstructionsSection } from '../../packages/zai-agent-core/dist/mcp/mcpInstructions.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const serverPath = resolve(__dirname, 'server.mjs')

function log(label, ok, detail) {
  const tag = ok ? '✓' : '✗'
  console.log(`${tag} ${label}${detail ? ': ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  console.log('=== zai-agent-core MCP smoke ===\n')

  // 1. Spawn the smoke server.
  const child = spawn('node', [serverPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', (d) => process.stderr.write(`[smoke-server] ${d}`))
  await new Promise((r) => setTimeout(r, 200))
  log('Smoke MCP server spawned (pid ' + child.pid + ')', true)

  // 2. Build the pool with a single stdio spec.
  const pool = new MCPClientPool()
  await pool.connectAll([{
    name: 'smoke',
    transport: { kind: 'stdio', command: 'node', args: [serverPath] },
  }])
  log('MCPClientPool.connectAll succeeded', pool.hasClient('smoke'))

  // 3. adaptMcpTools returns the opencc Tool.
  const tools = await adaptMcpTools(pool, 'smoke')
  log('adaptMcpTools returned tools', tools.length === 1, `count=${tools.length}`)
  const echo = tools[0]
  log('Tool name == mcp__smoke__echo', echo.name === 'mcp__smoke__echo', echo.name)
  log('Tool has description()', typeof echo.description === 'function')
  log('Tool has prompt()', typeof echo.prompt === 'function')

  const desc = await echo.description()
  const prompt = await echo.prompt()
  log('description() contains server name', desc.includes('mcp:smoke'), desc.slice(0, 60) + '...')
  log('prompt() returns the description', prompt.length > 0, prompt.slice(0, 60) + '...')

  // 4. getMcpInstructionsSection includes our server's instructions.
  const section = getMcpInstructionsSection([
    { name: 'smoke', type: 'connected', status: 'connected',
      instructions: 'Always echo user input verbatim with the prefix "echo:".' },
  ])
  log('getMcpInstructionsSection contains # MCP Server Instructions',
    section.includes('# MCP Server Instructions'))
  log('getMcpInstructionsSection contains the server instructions',
    section.includes('Always echo user input verbatim'))

  // 5. Empty mcpClients → empty string (caller can use as falsy guard).
  const empty = getMcpInstructionsSection([])
  log('Empty mcpClients returns ""', empty === '')

  // 6. Tool call: dispatch `echo:hello` and verify result.
  const result = await echo.call(
    { msg: 'hello' },
    {
      cwd: process.cwd(),
      env: process.env,
      abortSignal: new AbortController().signal,
      dataDir: '/tmp',
      canUseTool: async () => ({ behavior: 'allow' }),
      emitEvent: () => {},
      state: {},
      awaitAskUserQuestion: async () => ({ answers: {} }),
      __runtimeConfig: { mcpServers: [{ name: 'smoke', callTimeoutMs: 5000 }] },
    },
    async () => ({ behavior: 'allow' }),
    {},
  )
  log('Tool call returned data', typeof result.data === 'string', result.data?.slice(0, 60))
  log('Tool result data == "echo:hello"', result.data === 'echo:hello', result.data)
  log('Tool result isError == false', result.isError === false)

  // Cleanup
  await pool.disconnectAll()
  child.kill()
  console.log('\n=== smoke complete ===')
}

main().catch((e) => {
  console.error('smoke FAILED:', e)
  process.exit(1)
})