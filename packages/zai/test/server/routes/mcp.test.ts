import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * /api/mcp/status + /api/mcp/reconnect。
 *
 * 背景:headless runtime 的 MCP 连接是 boot 期后台异步做的,两次退避重试
 * 都失败后该进程重启前不会再有 MCP 工具。这两个端点是把那件事变得可见/
 * 可操作的唯一入口,所以要覆盖三种降级:
 *   - runtime 还没 init(getRuntime 抛错)→ 503,前端静默;
 *   - runtime 是老 core(没有 mcp 成员)→ 503,不 500;
 *   - reconnect 内部抛错 → 500 + error 文本。
 */

const h = vi.hoisted(() => ({
  runtimeReady: true,
  hasMcp: true,
  reconnectThrows: false,
  reconnectCalls: 0,
  status: {
    lazyConnect: true,
    connecting: false,
    servers: [
      {
        name: 'codegraph',
        type: 'connected',
        toolCount: 3,
        commandCount: 1,
      },
      { name: 'cua-driver', type: 'failed', toolCount: 0, commandCount: 0, error: 'spawn ENOENT' },
    ],
    commands: [
      {
        name: 'mcp__codegraph__build-graph',
        displayName: 'codegraph:build-graph (MCP)',
        description: '构建依赖图',
        serverName: 'codegraph',
      },
    ],
    lastConnectFailure: {
      at: 1_700_000_000_000,
      failed: 1,
      total: 2,
      servers: ['cua-driver'],
    },
  },
}))

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => {
    if (!h.runtimeReady) throw new Error('Agent runtime not initialized')
    const runtime: Record<string, unknown> = {}
    if (h.hasMcp) {
      runtime.mcp = {
        getStatus: () => h.status,
        reconnect: async () => {
          if (h.reconnectThrows) throw new Error('spawn failed')
          h.reconnectCalls += 1
          return { ...h.status, lastConnectFailure: null }
        },
      }
    }
    return runtime
  },
}))

async function buildApp() {
  const { mcpRouter } = await import('../../../src/server/routes/mcp.js')
  const app = express()
  app.use(express.json())
  app.use('/api', mcpRouter)
  return app
}

beforeEach(() => {
  h.runtimeReady = true
  h.hasMcp = true
  h.reconnectThrows = false
  h.reconnectCalls = 0
})

describe('GET /api/mcp/status', () => {
  it('回传 server 列表、命令与最近失败汇总', async () => {
    const res = await request(await buildApp()).get('/api/mcp/status')
    expect(res.status).toBe(200)
    expect(res.body.servers.map((s: { name: string }) => s.name)).toEqual([
      'codegraph',
      'cua-driver',
    ])
    expect(res.body.servers[1].error).toBe('spawn ENOENT')
    expect(res.body.commands[0].name).toBe('mcp__codegraph__build-graph')
    expect(res.body.lastConnectFailure).toMatchObject({
      failed: 1,
      total: 2,
      servers: ['cua-driver'],
    })
  })

  it('runtime 未 init → 503 runtime_not_ready(而不是 500)', async () => {
    h.runtimeReady = false
    const res = await request(await buildApp()).get('/api/mcp/status')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('runtime_not_ready')
  })

  it('runtime 没有 mcp 成员(旧 core)→ 503', async () => {
    h.hasMcp = false
    const res = await request(await buildApp()).get('/api/mcp/status')
    expect(res.status).toBe(503)
  })
})

describe('POST /api/mcp/reconnect', () => {
  it('触发一次重连并回传最新状态', async () => {
    const res = await request(await buildApp()).post('/api/mcp/reconnect')
    expect(res.status).toBe(200)
    expect(h.reconnectCalls).toBe(1)
    expect(res.body.lastConnectFailure).toBeNull()
  })

  it('重连抛错 → 500 + error 文本', async () => {
    h.reconnectThrows = true
    const res = await request(await buildApp()).post('/api/mcp/reconnect')
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('spawn failed')
  })

  it('runtime 未 init → 503', async () => {
    h.runtimeReady = false
    const res = await request(await buildApp()).post('/api/mcp/reconnect')
    expect(res.status).toBe(503)
  })
})