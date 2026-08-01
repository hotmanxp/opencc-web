import { describe, expect, it } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

// 回归测试：zai 端 buildOpenccQueryParams 必须把 opencc `query()`
// 接受的 `includePartialMessages: true` 一并传过去, 否则 opencc
// QueryEngine (opencc-src/QueryEngine.ts:222, 839) 默认走
// `includePartialMessages = false` 分支, 不向消费者 yield
// `stream_event` wrapper. 后果: zai 端只收到终态 `assistant`
// 消息, sdkEventAdapter 一次性合成一个 content_block_delta 把
// 整段文本吐出 → 前端一次性收齐全部 runtime.delta, 没有流式效果.
//
// 见 docs: opencc-src/entrypoints/sdk.d.ts:299-300 注释
// "When true, yields stream_event messages for token-by-token streaming."

const minimalOpts: QueryOptions = {
  prompt: { role: 'user', content: 'hi' },
  cwd: '/tmp',
  model: 'm',
  tools: [],
  sessionId: 's-partial',
}

describe('buildOpenccQueryParams — includePartialMessages flag', () => {
  it('forwards includePartialMessages: true to opencc query() params', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    expect(params.includePartialMessages).toBe(true)
  }, 30_000)
})