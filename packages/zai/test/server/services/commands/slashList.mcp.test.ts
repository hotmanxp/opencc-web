import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setCommandRegistry } from '@zn-ai/zn-agent-core'

/**
 * MCP prompt 命令进入 `/api/slash` 下拉。
 *
 * vendor 只把 MCP prompt 注册进 appState.mcp.commands(名如
 * `mcp__codegraph__build-graph`),从不进 CommandRegistry —— 所以
 * slashList 的前三段(builtin / user / plugin)都扫不到它们,用户既搜不到
 * 也无法补全。这里 mock 掉 agentRuntime,只验证补的那一段。
 */

const h = vi.hoisted(() => ({
  /** 模拟 runtime 还没 init(启动早期 / 单测)。 */
  throwOnGetRuntime: false,
  status: {
    lazyConnect: true,
    connecting: false,
    servers: [
      { name: 'codegraph', type: 'connected', toolCount: 3, commandCount: 1 },
    ],
    commands: [
      {
        name: 'mcp__codegraph__build-graph',
        displayName: 'codegraph:build-graph (MCP)',
        description: '构建依赖图',
        serverName: 'codegraph',
        argNames: ['root'],
      },
    ],
    lastConnectFailure: null,
  },
}))

vi.mock('../../../../src/server/services/agentRuntime.js', () => ({
  listSkills: async () => [],
  getRuntime: () => {
    if (h.throwOnGetRuntime) throw new Error('Agent runtime not initialized')
    return {
      mcp: { getStatus: () => h.status, reconnect: async () => h.status },
    }
  },
}))

beforeEach(() => {
  setCommandRegistry(null)
  h.throwOnGetRuntime = false
})

describe('slashList — MCP 命令', () => {
  it('把 MCP prompt 命令追加为可补全的 prompt item', async () => {
    const { slashList } = await import(
      '../../../../src/server/services/commands/slashList.js'
    )
    const out = await slashList({ skills: [] })
    const mcpItems = out.filter(i => i.name.startsWith('mcp__'))
    expect(mcpItems).toHaveLength(1)
    expect(mcpItems[0]).toEqual({
      kind: 'command',
      name: 'mcp__codegraph__build-graph',
      description: '构建依赖图',
      type: 'prompt',
      argumentHint: 'root',
      isBuiltIn: false,
      displayName: 'codegraph:build-graph (MCP)',
      // pluginName 复用为 server 名 —— 前端就是拿它渲染 `(xxx)` 前缀
      pluginName: 'codegraph',
    })
  })

  it('runtime 未 init 时静默降级(getRuntime 抛错不冒泡)', async () => {
    h.throwOnGetRuntime = true
    const { slashList } = await import(
      '../../../../src/server/services/commands/slashList.js'
    )
    const out = await slashList({ skills: [] })
    expect(out.filter(i => i.name.startsWith('mcp__'))).toHaveLength(0)
  })
})