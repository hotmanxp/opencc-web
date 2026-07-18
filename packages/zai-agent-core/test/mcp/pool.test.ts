import { describe, expect, test, beforeEach } from 'vitest'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'
import { McpServerError } from '../../src/mcp/errors.js'

describe('MCPClientPool', () => {
  let pool: MCPClientPool
  beforeEach(() => { pool = new MCPClientPool() })

  test('connectAll with empty specs resolves without throw', async () => {
    await pool.connectAll([])
    expect(pool.health()).toEqual({})
  })

  test('disconnectAll on empty pool is idempotent', async () => {
    await pool.disconnectAll()
    await pool.disconnectAll()
  })

  test('health reflects failed server without throwing', async () => {
    await pool.connectAll([
      {
        name: 'broken',
        transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-12345' },
        reconnect: { maxRetries: 0, backoffMs: 1 },
      },
    ])
    const h = pool.health()
    expect(h.broken.ok).toBe(false)
    expect(h.broken.error).toBeDefined()
  })

  test('connectAll does not throw when one server fails', async () => {
    await pool.connectAll([
      { name: 'broken', transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-12345' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
      { name: 'also-broken', transport: { kind: 'stdio', command: 'also-not-real-67890' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
    ])
    expect(pool.health().broken.ok).toBe(false)
    expect(pool.health()['also-broken'].ok).toBe(false)
  })

  test('incrementally disconnects removed servers', async () => {
    // broken-stdio path verifies connectAll diff logic
    await pool.connectAll([
      { name: 'a', transport: { kind: 'stdio', command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
      { name: 'b', transport: { kind: 'stdio', command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
    ])
    await pool.connectAll([
      { name: 'a', transport: { kind: 'stdio', command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
    ])
    expect(pool.health().a).toBeDefined()
    expect(pool.health().b).toBeUndefined()
  })

  test('getClient throws McpServerError for a failed server', async () => {
    await pool.connectAll([
      {
        name: 'broken',
        transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-12345' },
        reconnect: { maxRetries: 0, backoffMs: 1 },
      },
    ])
    expect(pool.hasClient('broken')).toBe(false)
    expect(() => pool.getClient('broken')).toThrow(McpServerError)
  })
})
