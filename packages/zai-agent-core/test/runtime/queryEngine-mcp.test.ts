import { describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'
import { queryEngine } from '../../src/runtime/queryEngine.js'
import type { RuntimeConfig } from '../../src/runtime/types.js'
import type { PluginRuntime, PluginSnapshot } from '../../src/plugins/types.js'

/** modelCaller returns a single text-only message and no tool calls. */
async function* textOnlyModelCaller(): AsyncGenerator<unknown> {
  yield { type: 'message_start' }
  yield {
    type: 'content_block_start',
    content_block: { type: 'text', text: '' },
  }
  yield {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'ok' },
  }
  yield { type: 'content_block_stop' }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
  yield { type: 'message_stop' }
}

function makeStubPluginRuntime(snapshot: Partial<PluginSnapshot>): PluginRuntime {
  return {
    async load() {
      return {
        plugins: [],
        skills: [],
        agents: [],
        mcpServers: [],
        pluginMcpServerNames: [],
        hooks: [],
        errors: [],
        ...snapshot,
      }
    },
    clearCache() {},
  }
}

describe('queryEngine MCP wiring', () => {
  test('connectAll never throws even when all servers fail', async () => {
    const pool = new MCPClientPool()
    const config = {
      dataDir: '/tmp',
      mcpClientPool: pool,
      mcpServers: [
        {
          name: 'bad',
          transport: { kind: 'stdio' as const, command: 'definitely-not-a-real-binary' },
        },
      ],
      modelCaller: textOnlyModelCaller,
    } as unknown as RuntimeConfig

    const events: unknown[] = []
    const gen = queryEngine({ prompt: 'hi', cwd: '/tmp' }, config)
    for await (const ev of gen) events.push(ev)

    // connectAll swallows per-server errors; pool.health() reflects failure.
    expect(pool.health().bad.ok).toBe(false)
  })

  test('skips MCP boot when mcpClientPool is not configured', async () => {
    const events: unknown[] = []
    const gen = queryEngine(
      { prompt: 'hi', cwd: '/tmp' },
      {
        dataDir: '/tmp',
        modelCaller: textOnlyModelCaller,
      } as unknown as RuntimeConfig,
    )
    for await (const ev of gen) events.push(ev)
    // No MCP-related runtime errors expected.
    expect(events.some((e: any) => e.type === 'runtime_error')).toBe(false)
  })

  // ---- plugin MCP integration (Task 6) ----------------------------------
  //
  // Two cases to verify:
  //   1. working plugin MCP server → pool.health() reports ok:true.
  //   2. failing plugin MCP server → pool.health() reports ok:false AND
  //      queryEngine still terminates with runtime.done for a text-only turn.
  //
  // For (1) we spin up a real stdio MCP server via a tiny Node.js script.
  // The script uses the SDK's StdioServerTransport + Server with the
  // required handlers so the client can complete the initialize handshake.
  // The script is created in a tmpdir and launched via process.execPath.

  test('plugin MCP auto-connect on session open → pool.health() reflects success', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'zai-mcp-ok-'))
    try {
      const scriptPath = join(tmpDir, 'fake-mcp-server.mjs')
      // Minimal MCP server speaking JSON-RPC over stdio. The handlers
      // only need to respond to `initialize` (and a no-op `tools/list`
      // so the SDK finishes its handshake) — we don't actually call
      // any tool, we just want the connection to land.
      //
      // The script uses absolute paths into zai-agent-core's
      // node_modules so the spawned Node can resolve the MCP SDK
      // without needing a package.json next to the script.
      const sdkRoot = join(process.cwd(), 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
      const scriptBody = `
import { Server } from ${JSON.stringify(`${sdkRoot}/server/index.js`)}
import { StdioServerTransport } from ${JSON.stringify(`${sdkRoot}/server/stdio.js`)}
import { ListToolsRequestSchema } from ${JSON.stringify(`${sdkRoot}/types.js`)}

const server = new Server(
  { name: 'fake-plugin-mcp', version: '0.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
const transport = new StdioServerTransport()
await server.connect(transport)
`
      await writeFile(scriptPath, scriptBody, 'utf-8')

      const pool = new MCPClientPool()
      // Capture pool.health() at the moment queryEngine has booted the
      // MCP servers but hasn't yet run the SessionEnd finally-block that
      // disconnects plugin-owned servers. The modelCaller is invoked
      // after MCP boot, so checking health inside it is the right hook.
      let healthSnapshot: Record<string, { ok: boolean }> | null = null
      const captureModelCaller = async function* () {
        healthSnapshot = pool.health()
        yield { type: 'message_start' }
        yield {
          type: 'content_block_start',
          content_block: { type: 'text', text: '' },
        }
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ok' },
        }
        yield { type: 'content_block_stop' }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
        yield { type: 'message_stop' }
      }
      const pluginRuntime = makeStubPluginRuntime({
        mcpServers: [
          {
            name: 'plugin:demo:echo',
            transport: { kind: 'stdio', command: process.execPath, args: [scriptPath] },
          },
        ],
        pluginMcpServerNames: ['plugin:demo:echo'],
      })
      const config = {
        dataDir: tmpDir,
        mcpClientPool: pool,
        pluginRuntime,
        modelCaller: captureModelCaller,
      } as unknown as RuntimeConfig

      const events: unknown[] = []
      const gen = queryEngine({ prompt: 'hi', cwd: tmpDir }, config)
      for await (const ev of gen) events.push(ev)

      // 1. Plugin MCP server entry was in the pool (mid-session).
      expect(healthSnapshot).not.toBeNull()
      expect(healthSnapshot!['plugin:demo:echo']).toBeDefined()
      expect(healthSnapshot!['plugin:demo:echo'].ok).toBe(true)
      // 2. Query still terminates cleanly (text-only turn).
      expect(events.at(-1) as any).toMatchObject({ type: 'runtime.done' })
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('failed plugin MCP does not crash query → pool.health() reflects failure, runtime.done reached', async () => {
    const pool = new MCPClientPool()
    // Same mid-session capture trick as the success test: queryEngine
    // disconnects plugin-owned servers in the SessionEnd finally-block,
    // so the post-generator pool is empty. The modelCaller runs after
    // MCP boot and before the disconnect.
    let healthSnapshot: Record<string, { ok: boolean }> | null = null
    const captureModelCaller = async function* () {
      healthSnapshot = pool.health()
      yield { type: 'message_start' }
      yield {
        type: 'content_block_start',
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'ok' },
      }
      yield { type: 'content_block_stop' }
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
      yield { type: 'message_stop' }
    }
    const pluginRuntime = makeStubPluginRuntime({
      mcpServers: [
        {
          name: 'plugin:demo:broken',
          transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-xyz' },
        },
      ],
      pluginMcpServerNames: ['plugin:demo:broken'],
    })
    const config = {
      dataDir: '/tmp',
      mcpClientPool: pool,
      pluginRuntime,
      modelCaller: captureModelCaller,
    } as unknown as RuntimeConfig

    const events: unknown[] = []
    const gen = queryEngine({ prompt: 'hi', cwd: '/tmp' }, config)
    for await (const ev of gen) events.push(ev)

    // 1. health() reported the broken plugin server with ok:false mid-session.
    expect(healthSnapshot).not.toBeNull()
    expect(healthSnapshot!['plugin:demo:broken']).toBeDefined()
    expect(healthSnapshot!['plugin:demo:broken'].ok).toBe(false)
    // 2. queryEngine still terminates with runtime.done for a text-only turn.
    expect(events.at(-1) as any).toMatchObject({ type: 'runtime.done' })
  })
})