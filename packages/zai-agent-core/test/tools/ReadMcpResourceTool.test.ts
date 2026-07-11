import { describe, expect, test } from 'vitest'
import { ReadMcpResourceTool } from '../../src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
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

describe('ReadMcpResourceTool', () => {
  test('returns isError when pool not configured', async () => {
    const result = await ReadMcpResourceTool.call(
      { serverName: 'github', uri: 'file://x' },
      makeCtx({}),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/mcpClientPool not configured/)
  })

  test('reads a text resource from a connected server', async () => {
    const fakePool = {
      hasClient: () => true,
      getClient: () => ({
        readResource: async () => ({
          contents: [{ text: 'hello world', mimeType: 'text/plain' }],
        }),
      }),
    }
    const result = await ReadMcpResourceTool.call(
      { serverName: 'github', uri: 'file://hello' },
      makeCtx({ mcpClientPool: fakePool }),
    )
    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('hello world')
  })

  test('returns isError when server is not connected', async () => {
    const fakePool = {
      hasClient: () => false,
      getClient: () => {
        throw new Error('should not be called')
      },
    }
    const result = await ReadMcpResourceTool.call(
      { serverName: 'ghost', uri: 'file://x' },
      makeCtx({ mcpClientPool: fakePool }),
    )
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/not connected: ghost/)
  })
})