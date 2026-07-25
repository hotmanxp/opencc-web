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