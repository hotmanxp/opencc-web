import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

// 模拟一条典型 turn 内的 SSE 事件序列:
//   text-block-0 (delta x N) → tool-X start/done → text-block-2 (delta x N)
// 验证: 两段 text 落到 messages 数组里两个不同的 assistant.text 条目,
// 工具落成一个 tool_use:start/done 条目, 整体顺序保留 (text0 → toolX → text2).
describe('useAgentStore — text / tool / text 交错事件', () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      textSegmentRev: 0,
      segmentedToolUseIds: {},
    })
  })

  it('text→tool→text 流式事件产生 2 个独立 text 气泡 + 1 个 tool 气泡, 顺序保持', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-1'

    // 1) text-block-0 首条 delta — segment=0, blockIndex=0
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '让我看一下 '
    )
    // 2) text-block-0 后续 delta — 同 segment/block, 应当 append 而非新建
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '当前文件内容.'
    )

    // 3) Anthropic 提前宣告的 content_block_start(tool_use) — blockIndex=1
    // 这一步是关键: store 内部应当把 textSegmentRev 从 0 推到 1.
    state.upsertToolCall({
      eventId: 'cbs-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { cmd: 'ls' } },
    })

    // 4) tool_use:start — 同一 toolUseId, 不再重复 bump
    state.upsertToolCall({
      eventId: 'start-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_x',
      name: 'Bash',
      input: { cmd: 'ls' },
    })

    // 5) tool_use:done
    state.upsertToolCall({
      eventId: 'done-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 'toolu_x',
      output: 'file1.txt\nfile2.txt',
    })

    // 6) text-block-2 首条 delta — segment 现已被工具 bump 到 1, 与 text-block-0 错位
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 2 } as any,
      '好的, 一共 2 个文件.'
    )

    expect(useAgentStore.getState().textSegmentRev).toBe(1)

    const messages = useAgentStore.getState().messages
    const texts = messages.filter((m) => m.type === 'assistant.text')
    const tools = messages.filter(
      (m) =>
        m.type === 'tool_use:start' ||
        m.type === 'tool_use:done' ||
        m.type === 'content_block_start',
    )

    expect(texts).toHaveLength(2)
    expect(tools).toHaveLength(1) // start/done 由 toolUseId upsert 合并到一条
    expect(tools[0]!.type).toBe('tool_use:done')
    expect(tools[0]!.name).toBe('Bash')
    expect(tools[0]!.toolUseId).toBe('toolu_x')

    // 顺序: text0 (segment 0) → toolX → text2 (segment 1)
    expect(texts[0]!.text).toBe('让我看一下 当前文件内容.')
    expect(texts[1]!.text).toBe('好的, 一共 2 个文件.')

    // 两段 text 的 eventId 不同 — 这是气泡分开的关键
    expect(texts[0]!.eventId).not.toBe(texts[1]!.eventId)

    // messages 数组顺序断言: text0 → toolX → text2
    expect(messages.map((m) => m.type)).toEqual([
      'assistant.text',
      'tool_use:done',
      'assistant.text',
    ])
  })

  it('同一 stream block 的 delta 合并进同一气泡', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-2'

    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '你好'
    )
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      ', 世界'
    )

    const texts = useAgentStore.getState().messages.filter((m) => m.type === 'assistant.text')
    expect(texts).toHaveLength(1)
    expect(texts[0]!.text).toBe('你好, 世界')
  })

  it('工具起点后的 text 落在新气泡 (即使 blockIndex 巧合相同)', () => {
    // 复现真实场景: Anthropic SDK 没有正确递增 blockIndex (例如两次都是
    // content_block_delta.index=0), 只要 store 捕捉到 tool_use:start,
    // 下一段文字就应该走新 segment.
    const state = useAgentStore.getState()
    const sessionId = 'sess-3'

    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '段 A'
    )
    // 工具调用 — store 应 bump textSegmentRev
    state.upsertToolCall({
      eventId: 's',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    // Anthropic 在某些实现下可能再次用 index=0 派发下一段 delta;
    // store 仍然应当视作新气泡.
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '段 B'
    )

    const texts = useAgentStore.getState().messages.filter((m) => m.type === 'assistant.text')
    expect(texts).toHaveLength(2)
    expect(texts[0]!.text).toBe('段 A')
    expect(texts[1]!.text).toBe('段 B')
  })

  it('同一 toolUseId 多次 tool_use:start 不重复 bump', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-4'

    // content_block_start(tool_use) 先声明
    state.upsertToolCall({
      eventId: 'cbs',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)

    // 再来 tool_use:start 同 id — 不应再 bump
    state.upsertToolCall({
      eventId: 'start',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)

    // tool_use:done 同 id — 不应再 bump
    state.upsertToolCall({
      eventId: 'done',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 't1',
      output: 'ok',
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)
  })

  it('多个工具依次调用时, 每次都 bump, text 段计 2 次错位', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-5'

    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      'before'
    )
    state.upsertToolCall({
      eventId: 's1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    state.upsertToolCall({
      eventId: 'd1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 't1',
      output: '',
    })
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      'middle'
    )
    state.upsertToolCall({
      eventId: 's2',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't2',
      name: 'Bash',
      input: {},
    })
    state.upsertToolCall({
      eventId: 'd2',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 't2',
      output: '',
    })
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      'after'
    )

    const texts = useAgentStore.getState().messages.filter((m) => m.type === 'assistant.text')
    expect(texts).toHaveLength(3)
    expect(texts.map((t) => t.text)).toEqual(['before', 'middle', 'after'])
    expect(useAgentStore.getState().textSegmentRev).toBe(2)
  })

  it('clearMessages 重置 textSegmentRev / segmentedToolUseIds', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-6'

    state.upsertToolCall({
      eventId: 's',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)
    expect(useAgentStore.getState().segmentedToolUseIds['t1']).toBe(true)

    useAgentStore.getState().clearMessages()
    expect(useAgentStore.getState().textSegmentRev).toBe(0)
    expect(useAgentStore.getState().segmentedToolUseIds).toEqual({})
  })
})
