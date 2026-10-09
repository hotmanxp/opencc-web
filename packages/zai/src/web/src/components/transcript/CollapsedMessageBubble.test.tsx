// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'

const msgMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }))
// 偏离 brief: 严格按 brief 用 vi.mock("antd", () => ({ message: msgMock }))
// 会让 antd.Typography/Card/Space 全变 undefined, 本文件 load 阶段就崩.
// 用 importOriginal + spread 只替换 message, 保留其他导出. 同 MessageBubble.test.tsx.
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>()
  return { ...actual, message: msgMock }
})

describe('CollapsedMessageBubble — copy button', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    writeText.mockClear()
  })

  test('assistant.text 气泡渲染 Copy 按钮', () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'a-1',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.text',
            text: 'collapsed AI text',
          } as any
        }
      />,
    )
    expect(screen.getByLabelText('复制助手回答')).toBeInTheDocument()
  })

  test('user.text 气泡渲染 Copy 按钮', () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'u-1',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'user.text',
            text: 'collapsed user text',
          } as any
        }
      />,
    )
    expect(screen.getByLabelText('复制用户消息')).toBeInTheDocument()
  })

  test('点击 assistant Copy 按钮复制 msg.text', async () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'a-2',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.text',
            text: 'AI markdown here',
          } as any
        }
      />,
    )
    fireEvent.click(screen.getByLabelText('复制助手回答'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('AI markdown here')
    })
  })

  test('点击 user Copy 按钮复制 msg.text', async () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'u-2',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'user.text',
            text: 'user raw input',
          } as any
        }
      />,
    )
    fireEvent.click(screen.getByLabelText('复制用户消息'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('user raw input')
    })
  })
})

// forceExpanded 标志: 由 MessageListView 给 "最后一条 assistant.text" 传 true
// (分屏模式 / transcriptCollapsed=true 时用户期望看到完整 AI 回答).
// 行为: AssistantTextBody 内部 div 用 maxHeight:'none' + overflow:'visible',
// 不渲染 "显示更多" 按钮. 历史 assistant.text 默认 clamp 6 行.
describe('CollapsedMessageBubble — forceExpanded prop', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    writeText.mockClear()
  })

  test('默认 (forceExpanded=false) 时 assistant.text 渲染 clamp box (maxHeight 140px)', () => {
    const { container } = render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'a-default',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.text',
            text: 'some AI text',
          } as any
        }
      />,
    )
    const clampBox = container.querySelector('div[style*="max-height: 140px"]')
    expect(clampBox).not.toBeNull()
    // 默认不渲染 "显示更多" 按钮 (除非内容溢出 + 测了 scrollHeight, 在 happy-dom
    // 里 clientHeight/scrollHeight 永远相等, 所以按钮不出现 — 正是我们想要的)
    expect(screen.queryByText('显示更多')).toBeNull()
  })

  test('forceExpanded=true 时 assistant.text 渲染展开 box (maxHeight:none)', () => {
    const { container } = render(
      <CollapsedMessageBubble
        forceExpanded
        message={
          {
            eventId: 'a-last',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.text',
            text: 'last AI reply, must be fully visible',
          } as any
        }
      />,
    )
    // 展开态: maxHeight: 'none', overflow: 'visible'
    const expandedBox = container.querySelector('div[style*="max-height: none"]')
    expect(expandedBox).not.toBeNull()
    // "显示更多" 按钮被 forceExpanded 抑制
    expect(screen.queryByText('显示更多')).toBeNull()
  })

  test('forceExpanded 对 thinking 消息无影响 (走 ThinkingBlock)', () => {
    const { container } = render(
      <CollapsedMessageBubble
        forceExpanded
        message={
          {
            eventId: 't-1',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.thinking',
            thinking: 'reasoning trace',
          } as any
        }
      />,
    )
    // ThinkingBlock 不渲染 maxHeight clamp box (用 ThinkingBlock 自家结构).
    // 只要不出现 max-height: 140px 的 clamp 元素就算通过.
    expect(container.querySelector('div[style*="max-height: 140px"]')).toBeNull()
  })
})

// runtime.error 是 SSE 流水线 push 的顶层错误事件 (useAgentStore.applyRuntimeEvent
// case 'runtime.error'). 历史上 collapsed 视图把它当成普通 text, 走兜底 Paragraph
// + clamp 渲染, 错误信息被淹没在 transcript 里看不见. 修复后强制以 "错误: msg"
// 红色 Card 展示, 不进 clamp, 至少让用户能扫一眼看到错误内容.
//
// 文本匹配说明: "错误: " 用 <strong> 包裹, 后续 message 是 sibling 文本节点,
// testing-library 默认 textContent 不会跨元素合并, 所以断言用 normalizer 把
// <strong> 标签剔除再比, 也能直接分两个断言 (前缀 / 主体).
describe('CollapsedMessageBubble — runtime.error', () => {
  test('渲染 "错误: message" 文本 (object shape: {message, category})', () => {
    const { container } = render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'err-1',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'runtime.error',
            error: { category: 'network', message: 'upstream 502' },
          } as any
        }
      />,
    )
    // 直接读 container.textContent 跨 <strong> 边界合并, 避免 testing-library
    // 文本节点遍历的怪异行为 (分别匹配 "错误: " 和 "upstream 502 ..." 两个节点).
    expect(container.textContent).toMatch(/错误:\s*upstream 502 \(network\)/)
  })

  test('error 为字符串时也走 "错误: " 前缀', () => {
    const { container } = render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'err-2',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'runtime.error',
            error: 'plain string error',
          } as any
        }
      />,
    )
    expect(container.textContent).toMatch(/错误:\s*plain string error/)
  })

  test('error 缺失时回退到 "发生未知错误"', () => {
    const { container } = render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'err-3',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'runtime.error',
          } as any
        }
      />,
    )
    expect(container.textContent).toMatch(/错误:\s*发生未知错误/)
  })

  test('runtime.error 不进入 maxHeight clamp 也不渲染 "显示更多"', () => {
    const { container } = render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'err-4',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'runtime.error',
            error: { message: 'long error message that would be clamped if rendered as plain text' },
          } as any
        }
      />,
    )
    expect(container.querySelector('div[style*="max-height: 140px"]')).toBeNull()
    expect(screen.queryByText('显示更多')).toBeNull()
  })
})