// packages/zai/test/web/autoScroll.test.ts
//
// decideAutoScroll: 决定"messages 更新是否要 scrollIntoView 底部"。
// 这是 Agent.tsx 那个 effect 的核心决策, 抽出来好测:
//
//   - 用户主动滚过 (scrollFollowLocked) → 绝对不滚 (5s 锁)
//   - 容器内容长高 (contentGrew) + 用户在底部 → 滚动 (streaming 期间的关键信号)
//   - messages 没新增 + 容器没长高 → 不滚
//   - 已经离底部很远 (distanceToBottomPx > NEAR_BOTTOM_PX) → 不滚
//   - 其他 → 滚
//
// ROOT CAUSE 修复历史:
//   1) 旧逻辑只看 [messages, pendingAsk, scrollFollowLocked], messages 数组在
//      streaming delta 时每条都换新引用, 但 length 不变, 仍然 fire scrollIntoView,
//      把阅读历史的用户视线拉回。
//   2) 第一次 fix 加上"length 不增长 → 不滚", 但漏掉了 streaming 期间 length
//      不变、容器内容却长高 (同一 bubble 持续 append) 的场景, 用户根本看不到
//      新内容。
//   3) 当前 fix 引入 contentGrew (scrollHeight 是否真长高) 作为互补信号。
//   4) 折叠视图 (transcriptCollapsed) 引入 messagesRefChanged fallback
//      (collapsed 后 outer scrollHeight 被 clamp 截住, contentGrew 失真).
//
// 返回值新增 reason 字段 — 每条规则一个稳定 id, 调试和日志输出都靠它.
import { describe, it, expect } from 'vitest'
import { decideAutoScroll } from '../../src/web/src/hooks/autoScroll.js'

type Case = Parameters<typeof decideAutoScroll>[0]
const decide = (input: Case) => decideAutoScroll(input)

describe('decideAutoScroll', () => {
  it('messages 数量增长 (新条目追加) → 滚动', () => {
    const r = decide({
      prevLength: 5,
      nextLength: 6,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('contentGrewInBottom')
  })

  it('messages 数量不变 + 内容没变 (纯 effect 重跑) → 不滚', () => {
    // upsertStreamBlock 每条 delta 都返回新 messages 数组, 但 length 仍 5,
    // scrollHeight 也没变 → 不该滚。
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  it('messages 数量不变 + 容器长高 + 用户在底部 → 滚动 (streaming delta 修复核心)', () => {
    // 关键修复: streaming 期间同一 assistant.text bubble 持续 append, length
    // 不变但 scrollHeight 一直在涨。这种场景必须 follow, 否则用户看不到新内容。
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('contentGrewInBottom')
  })

  it('messages 数量不变 + 容器长高 + 用户已上滚 (> 80px) → 不滚 (放手模式)', () => {
    // 用户主动上滚翻历史, 此时新内容涌入也不要拉回, 让 "新消息 N" 提示处理。
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 400,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('userScrolledAway')
  })

  it('messages 数量不变 + 容器长高 + 用户主动滚 (lock) → 不滚', () => {
    // 即便用户在底部 (contentGrew + 距离 ≤ 80), 只要 lock 住就不打扰。
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: true,
      scrollFollowLocked: true,
      distanceToBottomPx: 0,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('scrollFollowLocked')
  })

  it('messages 数量减少 (clearMessages / 切 session) → 不滚', () => {
    // 切会话 / clearMessages 时 messages 长度从 N → 0, 不应该把哨兵
    // 拉回底部 (切完应停在顶)。但 pendingAsk 出现会单独走自己的滚动。
    const r = decide({
      prevLength: 10,
      nextLength: 0,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  it('用户主动滚过 (scrollFollowLocked) → 绝对不滚, 即便 length 增长 + 内容长高', () => {
    const r = decide({
      prevLength: 3,
      nextLength: 4,
      contentGrew: true,
      scrollFollowLocked: true,
      distanceToBottomPx: 0,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('scrollFollowLocked')
  })

  it('用户已上滚离开底部 (> 80px) 且只是 delta → 不滚', () => {
    // prev=next 且 contentGrew=false 时, rule #4 先于 rule #5 命中, reason 是 noChange.
    // 这条 case 实际跟"长高 + 上滚"测试 (#4) 区别在于: 显式把 contentGrew 抠
    // 成 false, 验证 rule 顺序 — 上滚但容器没长高 → noChange.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 400,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  it('新消息追加但用户已上滚远 (> 80px) → 不滚 (放手模式)', () => {
    // 用户在读历史, AI 此时 push 了一条新消息; 不打扰用户, 让他继续读。
    // 视觉上用"新消息 N"标记即可, 不强行拉回。
    const r = decide({
      prevLength: 5,
      nextLength: 6,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 200,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('userScrolledAway')
  })

  it('新消息追加且距离底部 ≤ 80px (用户已在底部) → 滚动', () => {
    const r = decide({
      prevLength: 5,
      nextLength: 6,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 40,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('contentGrewInBottom')
  })

  it('边界 80px = NEAR_BOTTOM_PX 临界值 → 滚动', () => {
    const r = decide({
      prevLength: 5,
      nextLength: 6,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 80,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('contentGrewInBottom')
  })

  it('初始化 (prevLength = -1) → 滚动, 让首屏落到底部', () => {
    const r = decide({
      prevLength: -1,
      nextLength: 0,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 9999,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('init')
  })

  // 折叠视图 fallback (rule #3.5): CollapsedMessageBubble 的
  // maxHeight:140 + overflow:hidden clamp 让 outer scrollHeight 在文字
  // 越过 ~6 行后停涨, contentGrew 在 streaming / tool_result 阶段恒为
  // false. 此时用 messages 引用变化作为 fallback 信号 — store 真的写过
  // 新数据即视为"有新内容要跟". 仅在用户已在底部 (≤80px) 时触发, 用户
  // 上滚仍 stay 保护阅读位置.

  it('折叠视图 + length 不变 + contentGrew=false + 引用换了 + 在底部 → 滚动', () => {
    // 根因场景: 折叠态下 tool_use:done 是 in-place 更新, messages.length 不变,
    // outer scrollHeight 因 ToolGroupCard 仍 compact 而停涨, 旧逻辑 stay.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
      folded: true,
      messagesRefChanged: true,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('foldedFallback')
  })

  it('折叠视图 + length 不变 + contentGrew=false + 引用换了 + 在历史中段 → 不滚', () => {
    // 保护用户阅读历史的位置, 即便 store 写过新数据也不拉回.
    // 折叠 fallback (rule #3.5) 要求 distance<=80, 这里 distance=400 直接跳出
    // 该规则; 接着 rule #4: prev=next + contentGrew=false → noChange.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 400,
      folded: true,
      messagesRefChanged: true,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  it('折叠视图 + 用户主动滚 (lock) → 绝对不滚, 即便引用换了', () => {
    // scrollFollowLocked 在 rule #1 优先拦截, 折叠 fallback 在后面也救不回来.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: true,
      distanceToBottomPx: 0,
      folded: true,
      messagesRefChanged: true,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('scrollFollowLocked')
  })

  it('折叠视图 + 引用没换 (effect 误重跑) → 不滚', () => {
    // messagesRefChanged 是关键信号, 没换就当 effect 误重跑, 仍 stay.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
      folded: true,
      messagesRefChanged: false,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  it('折叠视图 + length 增长 (新消息) + 在底部 → 滚动 (原有 path 不变)', () => {
    // length grew 的路径仍走 rule #3 (contentGrewInBottom), 折叠 fallback
    // 在 rule #3.5 不触发 (nextLength === prevLength 这一前置条件不满足).
    // 验证两条路径互不干扰.
    const r = decide({
      prevLength: 5,
      nextLength: 6,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
      folded: true,
      messagesRefChanged: true,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('contentGrewInBottom')
  })

  it('非折叠视图 + length 不变 + contentGrew=false + 引用换了 → 仍 stay', () => {
    // 折叠 fallback 在 folded=false 时不生效, 展开态走原有 rule #4 stay.
    // 重要: 这条保证展开态行为完全不变, 折叠态是纯增量.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 0,
      folded: false,
      messagesRefChanged: true,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  // wasAtBottom (rule #5a): scrollTop 被 clamp 落后于新 scrollHeight 时的补滚.
  // 根因: streaming bubble 两次 effect 之间长 > 80px, hook 调 scrollTo({top:
  // scrollHeight}) 被浏览器 clamp 到 scrollHeight - clientHeight, 然后 React
  // 后续 render 让 scrollHeight 再涨, 下次 effect 的 distanceToBottomPx 看起来
  // > 80 误判 userScrolledAway. shouldFollow 用 wasAtBottom 信号 (上一帧
  // scrollTop 没动) 兜底.
  // 默认 wasAtBottom=false 时, 已有 18 个 case 行为完全不变 — 这条规则只在
  // hook 层显式传 wasAtBottom=true 时才激活.

  it('上一帧在底部 + contentGrew + 此刻 distance > 80 → follow (rule #5a clamp 落后补滚)', () => {
    // 根因场景: scrollTop=810 (被 clamp 到旧 scrollHeight=1488 - 678), 新
    // scrollHeight=1579, distance=91. 若 user 上一帧就停在 810 没动 (wasAtBottom),
    // 实际是 scrollTop 落后于新内容, 跟.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 200,
      wasAtBottom: true,
    })
    expect(r.decision).toBe('follow')
    expect(r.reason).toBe('wasAtBottomContentGrew')
  })

  it('上一帧在底部 + contentGrew=false + 此刻 distance > 80 → stay (noChange 优先, rule #5 不达)', () => {
    // 兜底分支不激活: prev=next + contentGrew=false 时 rule #4 先于 rule #5 命中,
    // reason 是 noChange. 这条 verify 的是 wasAtBottom 不会让 rule #4 失效.
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: false,
      scrollFollowLocked: false,
      distanceToBottomPx: 200,
      wasAtBottom: true,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('noChange')
  })

  it('上一帧未在底部 + contentGrew + 此刻 distance > 80 → stay (userScrolledAway 不变)', () => {
    // 兜底分支 guard: wasAtBottom=false 时 (user 真的看过历史), 即便 contentGrew
    // 也不拉回 (让 "新消息 N" 提示处理, 与折叠 fallback / streaming delta 行为一致).
    const r = decide({
      prevLength: 5,
      nextLength: 5,
      contentGrew: true,
      scrollFollowLocked: false,
      distanceToBottomPx: 200,
      wasAtBottom: false,
    })
    expect(r.decision).toBe('stay')
    expect(r.reason).toBe('userScrolledAway')
  })
})
