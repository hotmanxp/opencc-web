import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type { McpServerSpec } from './types.js'
import { createMcpTransport } from './transport.js'
import { McpServerError } from './errors.js'

type ServerEntry = {
  spec: McpServerSpec
  client: Client
  status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disconnected'
  retries: number
  lastError?: string
  lastCheckAt: number
}

export class MCPClientPool {
  private servers = new Map<string, ServerEntry>()

  async connectAll(specs: McpServerSpec[]): Promise<void> {
    const wanted = new Set(specs.map((s) => s.name))
    const toDisconnect = [...this.servers.keys()].filter((n) => !wanted.has(n))
    await Promise.allSettled(toDisconnect.map((n) => this.disconnect(n)))

    const toConnect = specs.filter((s) => !this.servers.has(s.name))
    await Promise.allSettled(toConnect.map((spec) => this.connectOne(spec)))
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.keys()].map((n) => this.disconnect(n))
    )
    this.servers.clear()
  }

  health(): Record<string, { ok: boolean; error?: string; lastCheckAt: number }> {
    const out: Record<string, { ok: boolean; error?: string; lastCheckAt: number }> = {}
    for (const [name, entry] of this.servers) {
      out[name] = {
        ok: entry.status === 'connected',
        error: entry.lastError,
        lastCheckAt: entry.lastCheckAt,
      }
    }
    return out
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    try {
      await entry.client.close()
    } catch {
      // best-effort
    }
    entry.status = 'disconnected'
    this.servers.delete(name)
  }

  private async connectOne(
    spec: McpServerSpec,
    transportOverride?: import('@modelcontextprotocol/sdk/shared/transport.js').Transport,
  ): Promise<void> {
    const client = new Client(
      { name: `zai-agent-core/${spec.name}`, version: '0.0.0' },
      { capabilities: { roots: { listChanged: true } } },
    )

    // Advertise the project cwd (or spec-supplied roots) so servers like
    // chrome-devtools-mcp stop printing the "did not negotiate the MCP roots
    // capability" warning and lift their file-writing restrictions.
    const roots = (spec.roots ?? [process.cwd()]).map((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(p)
      return { uri: pathToFileURL(abs).href, name: path.basename(abs) }
    })
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }))

    const entry: ServerEntry = {
      spec,
      client,
      status: 'connecting',
      retries: 0,
      lastCheckAt: Date.now(),
    }
    this.servers.set(spec.name, entry)

    try {
      const transport = transportOverride ?? createMcpTransport(spec, new AbortController().signal)
      await entry.client.connect(transport)
      entry.status = 'connected'
      entry.lastCheckAt = Date.now()
    } catch (err) {
      entry.status = 'failed'
      entry.lastError = err instanceof Error ? err.message : String(err)
      entry.lastCheckAt = Date.now()
      // do not throw — surface via health()
    }
  }

  /**
   * Test-only entry: connect a server using a caller-provided transport
   * (e.g. `InMemoryTransport`). Used by pool tests to exercise the
   * `roots/list` handler end-to-end without spawning stdio subprocesses.
   * @internal
   */
  async __connectWithTransport(
    spec: McpServerSpec,
    transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport,
  ): Promise<void> {
    await this.connectOne(spec, transport)
  }

  /** Read-only view of underlying MCP clients for adapters. Throws on failed servers. */
  getClient(name: string): Client {
    const entry = this.servers.get(name)
    if (!entry) {
      throw new McpServerError(`mcp server not connected: ${name}`, {
        serverName: name,
        retryable: false,
      })
    }
    if (entry.status !== 'connected') {
      throw new McpServerError(`mcp server not connected: ${name}`, {
        serverName: name,
        retryable: true,
      })
    }
    return entry.client
  }

  hasClient(name: string): boolean {
    const e = this.servers.get(name)
    return !!e && e.status === 'connected'
  }

  /**
   * Snapshot of connected clients with their MCP server instructions.
   * Used by the runtime to inject `<mcp_servers>` into the system prompt
   * so the model knows how to use each server's tools. Failed /
   * disconnected servers are skipped — only return what's actually
   * usable right now.
   *
   * `instructions` is the optional string the server returned during
   * the `initialize` handshake; most servers don't publish one. The
   * `name` matches the entry's `spec.name`.
   */
  getInstructionsSnapshot(): Array<{ name: string; type: string; instructions?: string }> {
    const out: Array<{ name: string; type: string; instructions?: string }> = []
    for (const [name, entry] of this.servers) {
      if (entry.status !== 'connected') continue
      let instructions: string | undefined
      try {
        const inst = entry.client.getInstructions?.()
        if (typeof inst === 'string' && inst.length > 0) instructions = inst
      } catch {
        // MCP SDK throws if `getInstructions` runs before `initialize`
        // completed; the entry's `status === 'connected'` guard should
        // catch most races, but be defensive.
      }
      out.push({
        name,
        type: entry.spec.transport.kind,
        ...(instructions ? { instructions } : {}),
      })
    }
    return out
  }
}