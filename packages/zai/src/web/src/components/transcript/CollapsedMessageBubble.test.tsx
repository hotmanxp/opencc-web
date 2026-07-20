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