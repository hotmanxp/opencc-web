import { describe, expect, it } from 'vitest'
import {
  buildMcpStatus,
  mcpServerPrefix,
  type McpStateLike,
} from '../../src/opencc-src/server/mcpStatus.js'

/**
 * zai patch (2026-09-22, MCP live view): appState.mcp → 对外状态快照的映射。
 *
 * 这些断言对应三个线上后果:
 *   - servers 要能让用户看出"哪个 server 挂了 + 错误是什么"(过去只有
 *     console.warn);
 *   - tool/command 计数要按 server 归属,否则面板数字没意义;
 *   - MCP prompt 命令要能被识别出来并以 `mcp__server__prompt` 暴露
 *     (slashList 与引擎的 commands 都吃这个形状)。
 */

const connected = (name: string) => ({ name, type: 'connected' })

describe('mcpServerPrefix', () => {
  it('归一化 server 名(与 vendor 工具/命令命名同源)', () => {
    expect(mcpServerPrefix('codegraph')).toBe('mcp__codegraph__')
    // vendor normalizeNameForMCP 把非法字符换成下划线
    expect(mcpServerPrefix('cua.driver')).toBe('mcp__cua_driver__')
  })
})

describe('buildMcpStatus', () => {
  it('过滤 disabled,保留 failed 及其错误信息', () => {
    const state: McpStateLike = {
      clients: [
        connected('codegraph'),
        { name: 'cua-driver', type: 'failed', error: 'spawn ENOENT' },
        { name: 'legacy', type: 'disabled' },
      ],
    }
    const status = buildMcpStatus(state, { lazyConnect: true })
    expect(status.servers.map(s => s.name)).toEqual(['codegraph', 'cua-driver'])
    // disabled 不进列表,但也不算失败
    expect(status.servers.find(s => s.name === 'cua-driver')?.error).toBe(
      'spawn ENOENT',
    )
    expect(status.servers.find(s => s.name === 'codegraph')?.error).toBeUndefined()
  })

  it('按 server 归属统计工具数与命令数', () => {
    const state: McpStateLike = {
      clients: [connected('codegraph'), connected('cua-driver')],
      tools: [
        { mcpInfo: { serverName: 'codegraph' } },
        { mcpInfo: { serverName: 'codegraph' } },
        { mcpInfo: { serverName: 'cua-driver' } },
      ],
      commands: [
        { name: 'mcp__codegraph__build-graph', isMcp: true },
        { name: 'mcp__cua-driver__screenshot', isMcp: true },
      ],
    }
    const status = buildMcpStatus(state, { lazyConnect: true })
    const byName = Object.fromEntries(status.servers.map(s => [s.name, s]))
    expect(byName.codegraph).toMatchObject({ toolCount: 2, commandCount: 1 })
    expect(byName['cua-driver']).toMatchObject({ toolCount: 1, commandCount: 1 })
  })

  it('命令优先用 vendor 的 userFacingName,否则按 `server:prompt (MCP)` 兜底', () => {
    const state: McpStateLike = {
      clients: [connected('codegraph')],
      commands: [
        {
          name: 'mcp__codegraph__build-graph',
          description: '构建依赖图',
          isMcp: true,
          argNames: ['root'],
          userFacingName: () => 'codegraph:build-graph (MCP)',
        },
        {
          // 没有 userFacingName —— 走兜底格式
          name: 'mcp__codegraph__plain',
          description: 'x',
          isMcp: true,
        },
      ],
    }
    const status = buildMcpStatus(state, { lazyConnect: true })
    expect(status.commands[0]).toMatchObject({
      name: 'mcp__codegraph__build-graph',
      displayName: 'codegraph:build-graph (MCP)',
      serverName: 'codegraph',
      argNames: ['root'],
    })
    expect(status.commands[1]?.displayName).toBe('codegraph:plain (MCP)')
  })

  it('非 mcp__ 前缀的命令不进 MCP 命令列表', () => {
    const state: McpStateLike = {
      clients: [connected('codegraph')],
      commands: [
        { name: 'clear', description: '内置命令' },
        { name: 'superpowers:commit', description: 'plugin 命令' },
        { name: 'mcp__codegraph__build', isMcp: true },
      ],
    }
    const status = buildMcpStatus(state, { lazyConnect: true })
    expect(status.commands.map(c => c.name)).toEqual(['mcp__codegraph__build'])
  })

  it('透传 connecting / lastConnectFailure / lazyConnect', () => {
    const failure = {
      at: 1_700_000_000_000,
      failed: 1,
      total: 2,
      servers: ['cua-driver'],
    }
    const status = buildMcpStatus(
      { clients: [], connecting: true, lastConnectFailure: failure },
      { lazyConnect: true },
    )
    expect(status.connecting).toBe(true)
    expect(status.lastConnectFailure).toEqual(failure)
    // zai-server 恒为 true:boot 期不 await MCP,由后台连接补齐
    expect(status.lazyConnect).toBe(true)
  })

  it('空状态不炸(connectMcp:false 的 boot 期)', () => {
    const status = buildMcpStatus(undefined, { lazyConnect: true })
    expect(status).toEqual({
      lazyConnect: true,
      connecting: false,
      servers: [],
      commands: [],
      lastConnectFailure: null,
    })
  })
})