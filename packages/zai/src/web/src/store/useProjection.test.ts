// T5 — seq 守卫 + 投影存储。
//
// applyProjection: higher-seq-wins 合并 (首次写入 / 低 seq 丢弃 / 高 seq 覆盖)。
// upsertStreamBlock / upsertToolCall: seq 严格递增守卫 (乱序/重放/同 seq
// 重复投递直接丢弃, 正常递增合并进同一 block)。

import { describe, expect, it, beforeEach } from 'vitest'
import { useAgentStore } from './useAgentStore.js'

const projection = (seq: number, value: unknown, key = 'title', sessionId = 's1') => ({
  type: 'session/projection' as const,
  eventId: `p${seq}`,
  ts: seq,
  sessionId,
  key,
  value,
  seq,
})

const textBase = (seq: number) => ({
  eventId: '',
  sessionId: 's1',
  ts: seq,
  seq,
  turnIndex: 0,
  type: 'assistant.text' as const,
  index: 0,
})

describe('applyProjection higher-seq-wins', () => {
  beforeEach(() => {
    useAgentStore.setState({ projectionsBySession: {} })
  })

  it('first write lands', () => {
    useAgentStore.getState().applyProjection(projection(10, 'A'))
    expect(useAgentStore.getState().projectionsBySession.s1.title.value).toBe('A')
    expect(useAgentStore.getState().projectionsBySession.s1.title.seq).toBe(10)
  })

  it('lower seq is dropped', () => {
    useAgentStore.getState().applyProjection(projection(10, 'A'))
    useAgentStore.getState().applyProjection(projection(9, 'B'))
    expect(useAgentStore.getState().projectionsBySession.s1.title.value).toBe('A')
  })

  it('higher seq wins', () => {
    useAgentStore.getState().applyProjection(projection(10, 'A'))
    useAgentStore.getState().applyProjection(projection(11, 'B'))
    expect(useAgentStore.getState().projectionsBySession.s1.title.value).toBe('B')
  })

  it('different keys are independent', () => {
    useAgentStore.getState().applyProjection(projection(10, 'A', 'title'))
    useAgentStore.getState().applyProjection(projection(11, 123, 'context.tokens'))
    const s = useAgentStore.getState().projectionsBySession.s1
    expect(s.title.value).toBe('A')
    expect(s['context.tokens'].value).toBe(123)
  })
})

describe('upsertStreamBlock seq guard', () => {
  beforeEach(() => {
    useAgentStore.setState({
      lastSeqBySession: {},
      messages: [],
      sendSeq: 0,
      textSegmentRev: 0,
    })
  })

  it('drops out-of-order / replay / same-seq deltas', () => {
    const u = useAgentStore.getState().upsertStreamBlock
    u('text', textBase(5), 'a')
    u('text', textBase(4), 'b') // 乱序重放 → 丢弃
    u('text', textBase(5), 'c') // 同 seq 重复投递 → 丢弃
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as { text: string }).text).toBe('a')
  })

  it('appends increasing seq deltas into the same block', () => {
    const u = useAgentStore.getState().upsertStreamBlock
    u('text', textBase(5), 'a')
    u('text', textBase(6), 'b')
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as { text: string }).text).toBe('ab')
  })

  it('tracks lastSeqBySession per session', () => {
    const u = useAgentStore.getState().upsertStreamBlock
    u('text', { ...textBase(5), sessionId: 's1' }, 'a')
    u('text', { ...textBase(8), sessionId: 's2' }, 'b') // 不同 sid 独立计数
    expect(useAgentStore.getState().lastSeqBySession).toEqual({ s1: 5, s2: 8 })
  })
})

describe('upsertToolCall seq guard', () => {
  beforeEach(() => {
    useAgentStore.setState({
      lastSeqBySession: {},
      messages: [],
      sendSeq: 0,
      textSegmentRev: 0,
      segmentedToolUseIds: {},
    })
  })

  const toolMsg = (seq: number, type = 'tool_use:start', toolUseId = 't1') => ({
    eventId: `tool-${toolUseId}`,
    sessionId: 's1',
    ts: seq,
    seq,
    turnIndex: 0,
    type,
    toolUseId,
    name: 'Read',
    input: {},
  })

  it('drops replayed tool events with lower seq', () => {
    const u = useAgentStore.getState().upsertToolCall
    u(toolMsg(5))
    u(toolMsg(4)) // 乱序重放 → 丢弃
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].toolUseId).toBe('t1')
    // done 事件 seq=6 正常应用 → 切到已完成
    u(toolMsg(6, 'tool_use:done'))
    expect(useAgentStore.getState().messages[0].type).toBe('tool_use:done')
  })
})
