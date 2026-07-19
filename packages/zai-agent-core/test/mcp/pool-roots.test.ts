import { describe, expect, test } from 'vitest'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'

/**
 * Regression test: zai's MCP client must declare the `roots` capability and
 * respond to `roots/list`, otherwise servers like chrome-devtools-mcp print
 * the "did not negotiate the MCP roots capability" warning on every connect
 * (and clamp file-writing tools to /tmp).
 */
describe('MCPClientPool roots capability', () => {
  test('server.listRoots() returns spec.roots as file:// URIs', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    let serverSawRoots: { roots: Array<{ uri: string; name?: string }> } | null = null
    const server = new McpServer({ name: 'mock-roots-server', version: '0.0.0' })
    await server.connect(serverTransport)
    // SDK exposes server→client `listRoots` via `server.server` (low-level
    // Server). Wait for handshake to settle, then ask the client for roots.
    void (async () => {
      for (let i = 0; i < 50; i++) {
        try {
          serverSawRoots = await server.server.listRoots()
          return
        } catch {
          await new Promise((r) => setTimeout(r, 10))
        }
      }
    })()

    const pool = new MCPClientPool()
    await pool.__connectWithTransport(
      {
        name: 'mock',
        transport: { kind: 'stdio', command: 'unused' },
        roots: ['/tmp/proj-a', '/tmp/proj-b'],
      },
      clientTransport,
    )

    // Wait for the async listRoots() probe to settle.
    for (let i = 0; i < 100 && serverSawRoots === null; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(serverSawRoots, 'server should have received roots from client').toBeTruthy()
    expect(serverSawRoots!.roots).toHaveLength(2)
    expect(serverSawRoots!.roots[0].uri).toMatch(/proj-a$/)
    expect(serverSawRoots!.roots[1].uri).toMatch(/proj-b$/)
    expect(serverSawRoots!.roots[0].name).toBe('proj-a')

    await pool.disconnectAll()
    await server.close()
  })

  test('falls back to process.cwd() when spec.roots is omitted', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    let serverSawRoots: { roots: Array<{ uri: string; name?: string }> } | null = null
    const server = new McpServer({ name: 'mock-fallback', version: '0.0.0' })
    await server.connect(serverTransport)
    void (async () => {
      for (let i = 0; i < 50; i++) {
        try {
          serverSawRoots = await server.server.listRoots()
          return
        } catch {
          await new Promise((r) => setTimeout(r, 10))
        }
      }
    })()

    const pool = new MCPClientPool()
    await pool.__connectWithTransport(
      { name: 'mock', transport: { kind: 'stdio', command: 'unused' } },
      clientTransport,
    )

    for (let i = 0; i < 100 && serverSawRoots === null; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(serverSawRoots, 'server should have received roots from client').toBeTruthy()
    expect(serverSawRoots!.roots).toHaveLength(1)
    expect(serverSawRoots!.roots[0].uri).toBe(
      `file://${path.resolve(process.cwd())}`,
    )
    expect(serverSawRoots!.roots[0].name).toBe(path.basename(process.cwd()))

    await pool.disconnectAll()
    await server.close()
  })
})