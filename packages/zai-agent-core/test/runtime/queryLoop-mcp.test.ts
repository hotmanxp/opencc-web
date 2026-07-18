import { describe, expect, test } from 'vitest'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import type { RuntimeConfig } from '../../src/runtime/types.js'

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

describe('queryLoop MCP wiring', () => {
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
      // modelCaller 必须传函数（不是 generator 实例）—— queryLoop 用 config.modelCaller?.({...}) 调用
      modelCaller: textOnlyModelCaller,
    } as unknown as RuntimeConfig

    const events: unknown[] = []
    const gen = queryLoop({ prompt: 'hi', cwd: '/tmp' }, config)
    for await (const ev of gen) events.push(ev)

    // connectAll swallows per-server errors; pool.health() reflects failure.
    expect(pool.health().bad.ok).toBe(false)
  })

  test('skips MCP boot when mcpClientPool is not configured', async () => {
    const events: unknown[] = []
    const gen = queryLoop(
      { prompt: 'hi', cwd: '/tmp' },
      {
        dataDir: '/tmp',
        // modelCaller 必须传函数（不是 generator 实例）—— queryLoop 用 config.modelCaller?.({...}) 调用
        modelCaller: textOnlyModelCaller,
      } as unknown as RuntimeConfig,
    )
    for await (const ev of gen) events.push(ev)
    // No MCP-related runtime errors expected.
    expect(events.some((e: any) => e.type === 'runtime.error')).toBe(false)
  })
})