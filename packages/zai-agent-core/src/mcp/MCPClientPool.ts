import { Client } from '@modelcontextprotocol/sdk/client/index.js'
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

  private async connectOne(spec: McpServerSpec): Promise<void> {
    const entry: ServerEntry = {
      spec,
      client: new Client({ name: `zai-agent-core/${spec.name}`, version: '0.0.0' }, { capabilities: {} }),
      status: 'connecting',
      retries: 0,
      lastCheckAt: Date.now(),
    }
    this.servers.set(spec.name, entry)

    try {
      const transport = createMcpTransport(spec, new AbortController().signal)
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
}