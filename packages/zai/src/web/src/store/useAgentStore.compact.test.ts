// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest'
import { useAgentStore, loadTranscriptMessages } from './useAgentStore.js'

// 压缩事件接线 (2026-10-12) 的 store 侧回归。
//
// 三条独立断言:
//   1. compact_boundary 落进 messages (常驻分界线), 不走 toasts;
//   2. runtime.compacted 推 toast, 文案按 savedTokens 有无分叉;
//   3. 历史回放能认 vendor 形状 + legacy 形状, 且不再把 auto 摘要渲染成
//      一个巨大的用户气泡。

beforeEach(() => {
  useAgentStore.setState({
    activeSessionId: null,
    messages: [],
    sendSeq: 0,
    status: 'idle',
    pendingAsk: null,
    toasts: [],
    sessionId: null,
  })
})

describe('compact_boundary 事件', () => {
  test('写进 messages 而不是 toasts', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'compact_boundary',
      eventId: 'e-bnd', ts: 1, sessionId: 's1', seq: 1,
      trigger: 'auto', preTokens: 180000, messagesSummarized: 42,
    })
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({
      type: 'compact_boundary',
      sessionId: 's1',
      trigger: 'auto',
      preTokens: 180000,
      messagesSummarized: 42,
    })
    expect(s.toasts).toHaveLength(0)
  })

  test('没有 messagesSummarized 时不写入该键', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'compact_boundary',
      eventId: 'e-bnd', ts: 1, sessionId: 's1', seq: 1,
      trigger: 'manual', preTokens: 5000,
    })
    const m = useAgentStore.getState().messages[0] as Record<string, unknown>
    expect(m.trigger).toBe('manual')
    expect(m).not.toHaveProperty('messagesSummarized')
  })

  test('别的会话的边界不写进当前视图 (sid 过滤)', () => {
    useAgentStore.setState({ sessionId: 'current' })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'compact_boundary',
      eventId: 'e-bnd', ts: 1, sessionId: 'other', seq: 1,
      trigger: 'auto', preTokens: 100,
    })
    expect(useAgentStore.getState().messages).toHaveLength(0)
  })
})

describe('runtime.compacted toast 文案', () => {
  test('有 savedTokens 时显示节省量', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacted',
      eventId: 'e-c', ts: 1000, sessionId: 's1', seq: 1,
      trigger: 'manual', preTokens: 100000, postTokens: 40000,
      savedTokens: 60000, timestamp: 1000,
    })
    expect(useAgentStore.getState().toasts[0]!.text).toBe(
      '对话已压缩 · 节省 60,000 tokens',
    )
  })

  test('auto 路径缺 savedTokens 时改述已归档规模, 不谎报"节省 0"', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacted',
      eventId: 'e-c', ts: 1000, sessionId: 's1', seq: 1,
      trigger: 'auto', preTokens: 180000, timestamp: 1000,
    })
    const toast = useAgentStore.getState().toasts[0]!
    expect(toast.text).toBe('对话已压缩 · 上下文 180,000 tokens 已归档')
    expect(toast.text).not.toContain('节省 0')
  })

  test('expiresAt = timestamp + 5000', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacted',
      eventId: 'e-c', ts: 1000, sessionId: 's1', seq: 1,
      trigger: 'auto', preTokens: 100, timestamp: 12345,
    })
    expect(useAgentStore.getState().toasts[0]!.expiresAt).toBe(17345)
  })
})

describe('loadTranscriptMessages — 历史回放', () => {
  test('认 vendor 形状 (system + subtype + compactMetadata)', () => {
    const out = loadTranscriptMessages('s1', [
      {
        uuid: 'b1', type: 'system', subtype: 'compact_boundary',
        content: 'Conversation compacted', timestamp: 1,
        compactMetadata: { trigger: 'auto', preTokens: 90000, messagesSummarized: 12 },
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'compact_boundary', trigger: 'auto',
      preTokens: 90000, messagesSummarized: 12,
    })
  })

  test('认 legacy 形状 (type:compact_boundary)', () => {
    // 遗留 shim compat/runtime/compactService.ts 仍写这种行。
    const out = loadTranscriptMessages('s1', [
      {
        uuid: 'b1', type: 'compact_boundary', timestamp: 1,
        message: { role: 'user', content: [{ type: 'text', text: '对话从这之后被压缩为摘要。' }] },
        compactMetadata: { trigger: 'manual', preTokens: 5000, messagesSummarized: 30 },
      },
    ])
    expect(out[0]).toMatchObject({
      type: 'compact_boundary', trigger: 'manual', preTokens: 5000,
    })
  })

  test('auto 摘要不渲染成用户气泡, 正文折进分界线', () => {
    const out = loadTranscriptMessages('s1', [
      {
        uuid: 'b1', type: 'system', subtype: 'compact_boundary', timestamp: 1,
        compactMetadata: { trigger: 'auto', preTokens: 90000 },
      },
      {
        uuid: 's1m', type: 'user', isCompactSummary: true, timestamp: 2,
        message: { role: 'user', content: 'This session is being continued from a previous conversation...' },
      },
      {
        uuid: 'u1', type: 'user', timestamp: 3,
        message: { role: 'user', content: '继续' },
      },
    ])
    // 分界线 + 真正的用户消息;摘要那条不单独出现
    expect(out.map((m) => m.type)).toEqual(['compact_boundary', 'user.text'])
    expect((out[0] as Record<string, unknown>).summary).toContain(
      'This session is being continued',
    )
  })

  test('块形态的 auto 摘要同样折进分界线', () => {
    const out = loadTranscriptMessages('s1', [
      {
        uuid: 'b1', type: 'system', subtype: 'compact_boundary', timestamp: 1,
        compactMetadata: { trigger: 'auto', preTokens: 90000 },
      },
      {
        uuid: 's1m', type: 'user', isCompactSummary: true, timestamp: 2,
        message: { role: 'user', content: [{ type: 'text', text: '摘要正文(块形态)' }] },
      },
    ])
    expect(out).toHaveLength(1)
    expect((out[0] as Record<string, unknown>).summary).toContain('摘要正文(块形态)')
  })

  test('普通用户消息不受 isCompactSummary 守卫影响', () => {
    const out = loadTranscriptMessages('s1', [
      { uuid: 'u1', type: 'user', timestamp: 1, message: { role: 'user', content: '你好' } },
    ])
    expect(out.map((m) => m.type)).toEqual(['user.text'])
  })
})
