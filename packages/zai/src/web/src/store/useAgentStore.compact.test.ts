// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest'
import { useAgentStore, loadTranscriptMessages, createAgentStore } from './useAgentStore.js'

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

// 压缩**过程中**的状态 (2026-10-12)。与上面 compact_boundary / compacted
// 是三件独立的事: 那个是结束后的常驻分界线与 5s toast, 这个是压缩期间的
// 临时过程态。回归重点是复刻 vendor `isCompactingRef` 的幂等语义
// (opencc-src/hooks/useRemoteSession.ts:228-232)。
describe('runtime.compacting 过程态', () => {
  test('开始 → true, 结束 → false', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacting',
      eventId: 'e-c1', ts: 1, sessionId: 's1', seq: 1, compacting: true,
    })
    expect(useAgentStore.getState().compacting).toBe(true)
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacting',
      eventId: 'e-c2', ts: 2, sessionId: 's1', seq: 2, compacting: false,
    })
    expect(useAgentStore.getState().compacting).toBe(false)
  })

  test('重复的 compacting=true 幂等 (keep-alive 每 30s 重发)', () => {
    // core 侧把 setSDKStatus 与 onCompactProgress 都映射成 start, 一次压缩
    // 本来就收到 start×2; 再叠加 vendor 的 keep-alive 定时器重复重发。
    // 早退保证不会每次都唤醒订阅者重渲染。
    useAgentStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e1', ts: 1, seq: 1, sessionId: 's1', compacting: true,
    })
    const first = useAgentStore.getState()
    useAgentStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e2', ts: 2, seq: 2, sessionId: 's1', compacting: true,
    })
    // 状态没变, 且 store 引用未替换 (未触发订阅者)
    expect(useAgentStore.getState()).toBe(first)
    expect(useAgentStore.getState().compacting).toBe(true)
  })

  test('孤立 end (PreCompact hook 抛错) 也能关掉状态 —— 不卡死', () => {
    // vendor: compact_end 在 finally 里, 而 compact_start 在 PreCompact hook
    // 之后 (compact.ts:452 vs 436), hook 抛错会先来 end。
    useAgentStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e-end', ts: 1, seq: 1, sessionId: 's1', compacting: true,
    })
    useAgentStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e-end2', ts: 2, seq: 2, sessionId: 's1', compacting: false,
    })
    expect(useAgentStore.getState().compacting).toBe(false)
    // 从未 start 就收到 end 也不应抛错 (幂等地保持 false)
    useAgentStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e-end3', ts: 3, seq: 3, sessionId: 's1', compacting: false,
    })
    expect(useAgentStore.getState().compacting).toBe(false)
  })

  test('别的会话发来的 compacting 也能关掉本会话的指示 (不按 sid 过滤)', () => {
    // 与 applyCompactionEvent 一致: 过程态是会话级提示而非流级内容。
    // 切到 B 后收到 A 的"压缩结束", 指示照样要关, 否则 B 永远显示压缩中。
    useAgentStore.setState({ sessionId: 'B' })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacting',
      eventId: 'e-x', ts: 1, sessionId: 'A', seq: 1, compacting: true,
    })
    expect(useAgentStore.getState().compacting).toBe(true)
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacting',
      eventId: 'e-y', ts: 2, sessionId: 'A', seq: 2, compacting: false,
    })
    expect(useAgentStore.getState().compacting).toBe(false)
  })

  test('过程态不写 messages 也不写 toasts', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.compacting',
      eventId: 'e-z', ts: 1, sessionId: 's1', seq: 1, compacting: true,
    })
    expect(useAgentStore.getState().messages).toHaveLength(0)
    expect(useAgentStore.getState().toasts).toHaveLength(0)
  })
})

// 三个 2026-10-12 的回归修复。
describe('压缩过程态的三处修复', () => {
  test('修1: 切会话 / clearMessages 复位 compacting (否则永久卡死)', () => {
    // runtime.compacting 是 sid-scoped(不在 isGlobalEvent 白名单), 切到 B
    // 后 A 的 compacting:false 被服务端静默丢弃 → 前端收不到任何关闭信号。
    useAgentStore.setState({ compacting: true })

    useAgentStore.getState().setCurrentSession('sess-B')
    expect(useAgentStore.getState().compacting).toBe(false)

    useAgentStore.setState({ compacting: true })
    useAgentStore.getState().clearMessages()
    expect(useAgentStore.getState().compacting).toBe(false)
  })

  test('修2: reducer 读的是当前 store 实例, 不是模块级单例', () => {
    // 原实现写 `useAgentStore.getState()`, 那是**单例**。Context store
    // (NewSuperTaskModal 等走 applyBatchTo(store, ...)) 会拿到另一个实例,
    // 于是: 单例 false + modal store true + 来一个 false 事件
    //       → 单例侧 false === false 早退 → **modal store 永不更新**。
    const modalStore = createAgentStore()
    // 单例与 modal store 处于不同状态, 正是触发误判的组合。
    useAgentStore.setState({ compacting: false })
    modalStore.setState({ compacting: true })

    modalStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e1', ts: 1, seq: 1, sessionId: 's1', compacting: false,
    })

    // 修复后: 读的是 modal store 自己的状态(true ≠ false) → 不早退 → 更新。
    expect(modalStore.getState().compacting).toBe(false)
  })

  test('修2 补充: 单例状态不影响 Context store 的幂等判断', () => {
    const modalStore = createAgentStore()
    modalStore.setState({ compacting: true })
    useAgentStore.setState({ compacting: true })

    // 两边都是 true, 事件也是 true → modal store 应幂等早退(引用不变)。
    const before = modalStore.getState()
    modalStore.getState().applyCompactingEvent({
      type: 'runtime.compacting',
      eventId: 'e2', ts: 1, seq: 1, sessionId: 's1', compacting: true,
    })
    expect(modalStore.getState()).toBe(before)
  })
})
