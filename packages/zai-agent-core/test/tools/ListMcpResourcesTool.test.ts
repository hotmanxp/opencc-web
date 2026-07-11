import { describe, expect, test } from 'vitest'
import { ListMcpResourcesTool } from '../../src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import type { ToolContext } from '../../src/tools/Tool.js'

function makeCtx(runtimeConfig: unknown): ToolContext {
  return {
    cwd: '/tmp',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/tmp',
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    __runtimeConfig: runtimeConfig as ToolContext['__runtimeConfig'],
  }
}

describe('ListMcpResourcesTool', () => {
  test('returns isError when pool not configured', async () => {
    const result = await ListMcpResourcesTool.call({}, makeCtx({}))
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/mcpClientPool not configured/)
  })

  test('lists resources for a connected server', async () => {
    const fakePool = {
      health: () => ({ github: { ok: true, lastCheckAt: 0 } }),
      hasClient: () => true,
      getClient: () => ({
        listResources: async () => ({
          resources: [{ uri: 'skill://x', name: 'x' }],
        }),
      }),
    }
    const result = await ListMcpResourcesTool.call(
      { serverName: 'github' },
      makeCtx({ mcpClientPool: fakePool }),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('skill://x')
  })

  test('reports disconnected server with error', async () => {
    const fakePool = {
      health: () => ({
        broken: { ok: false, error: 'spawn failed', lastCheckAt: 0 },
      }),
      hasClient: () => false,
      getClient: () => {
        throw new Error('should not be called')
      },
    }
    const result = await ListMcpResourcesTool.call(
      { serverName: 'broken' },
      makeCtx({ mcpClientPool: fakePool }),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('spawn failed')
  })
})