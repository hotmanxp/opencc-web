import { describe, expect, test } from 'vitest'
import { translateRuntimeEvents } from './agent.js'

// 平行 tool_use 块: Anthropic SDK 在单条 assistant message 里允许 N 个
// tool_use blocks 并行(各 block 自带 index 0..N-1). 老实现 toolInputBuffer
// 是单 string, 第二个 block 的 input_json_delta 会拼到第一个后面, JSON.parse
// 失败 → raw string 进 runtime.tool_call.input → routes/agent.ts 路径里
// useAgentStore upsertToolCall 把已有 input 覆盖成 mashed string / 抛
// "[buildOpenccQueryParams] tool_use ... emitted empty input".
//
// 这个测试覆盖 translateRuntimeEvents 翻译层: 期望并行 tool_use 各自拿到
// 独立解析后的对象.

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const it of items) yield it
    },
  }
}

describe('translateRuntimeEvents — parallel tool_use blocks', () => {
  test('two parallel tool_use blocks keep distinct parsed inputs', async () => {
    const events = makeAsyncIterable<Record<string, unknown>>([
      { type: 'message_start' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_aaa', name: 'Bash' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls /etc/hostname","description":"List hostname file"}' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_bbb', name: 'Bash' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"whoami","description":"Print current user"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ])

    const out: Array<Record<string, unknown>> = []
    for await (const ev of translateRuntimeEvents(events, 'sess-par-test')) out.push(ev as Record<string, unknown>)

    const toolCalls = out.filter((e) => e.type === 'runtime.tool_call') as Array<{
      type: 'runtime.tool_call'
      toolUseId: string
      toolName: string
      input: unknown
    }>

    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0].toolUseId).toBe('call_aaa')
    expect(toolCalls[0].toolName).toBe('Bash')
    expect(toolCalls[0].input).toEqual({
      command: 'ls /etc/hostname',
      description: 'List hostname file',
    })

    expect(toolCalls[1].toolUseId).toBe('call_bbb')
    expect(toolCalls[1].toolName).toBe('Bash')
    expect(toolCalls[1].input).toEqual({
      command: 'whoami',
      description: 'Print current user',
    })

    const doneEvents = out.filter((e) => e.type === 'runtime.done')
    expect(doneEvents).toHaveLength(1)
  })

  test('three parallel tool_use blocks: split json across deltas per index', async () => {
    // 真实流里 partial_json 经常是按字符拆成很多小块. 验证 map 索引后
    // 每个 block 仍能正确重组 + 解析.
    const events = makeAsyncIterable<Record<string, unknown>>([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'Bash' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '":"ls"}' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_2', name: 'Bash' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '":"pwd"}' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_3', name: 'Bash' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"date"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_stop' },
    ])

    const out: Array<Record<string, unknown>> = []
    for await (const ev of translateRuntimeEvents(events, 'sess-par-3')) out.push(ev as Record<string, unknown>)

    const toolCalls = out.filter((e) => e.type === 'runtime.tool_call') as Array<{
      toolUseId: string
      input: unknown
    }>
    expect(toolCalls).toHaveLength(3)
    expect(toolCalls[0]).toMatchObject({ toolUseId: 'call_1', input: { command: 'ls' } })
    expect(toolCalls[1]).toMatchObject({ toolUseId: 'call_2', input: { command: 'pwd' } })
    expect(toolCalls[2]).toMatchObject({ toolUseId: 'call_3', input: { command: 'date' } })
  })
})