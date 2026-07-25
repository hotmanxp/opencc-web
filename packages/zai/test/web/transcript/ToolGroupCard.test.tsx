// @vitest-environment happy-dom
// 注: happy-dom 不支持精确的 CSS 布局计算, AntD Card / Collapse 内部 inline style
// 在 happy-dom 下不能稳定 query 到 (CSSStyleDeclaration 读不到 React 写入的 inline
// style). 这里只验证渲染行为/文字, 不验证 inline 样式.
import { describe, expect, test } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolGroupCard } from '../../../src/web/src/components/transcript/ToolGroupCard.js'
import type { ToolGroupEntry } from '../../../src/web/src/components/transcript/deriveTranscriptNodes.js'

function toolEntry(
  name: string,
  idx: number,
  status: ToolGroupEntry['status'] = 'done',
  previewInput: Record<string, unknown> = {},
): ToolGroupEntry {
  return {
    status,
    index: idx,
    message: {
      type: 'tool_use:done',
      name,
      toolUseId: `tool-${idx}`,
      eventId: `evt-tool-${idx}`,
      sessionId: 'sess-1',
      ts: idx,
      turnIndex: 0,
      blockIndex: idx,
      sendSeq: 0,
      input: previewInput,
    } as any,
  }
}

describe('ToolGroupCard', () => {
  test('Card 渲染成功', () => {
    const entries = [
      toolEntry('Grep', 0),
      toolEntry('Glob', 1),
      toolEntry('Grep', 2),
    ]
    const { container } = render(<ToolGroupCard entries={entries} />)
    expect(container.querySelector('.ant-card')).toBeInTheDocument()
  })

  test('展开 8 个 ToolCallBlock 不崩 (smoke)', () => {
    const entries: ToolGroupEntry[] = []
    for (let i = 0; i < 8; i++) {
      entries.push(
        toolEntry(
          i % 2 === 0 ? 'Grep' : 'Glob',
          i,
          'done',
          { pattern: `pattern-with-some-content-${i}`.repeat(5) },
        ),
      )
    }
    const { container } = render(<ToolGroupCard entries={entries} />)
    fireEvent.click(screen.getByRole('button', { name: /展开 8 个工具/ }))
    expect(container.querySelector('.ant-card')).toBeInTheDocument()
  })

  test('折叠态不渲染 ToolCallBlock (只显示 "折叠显示" 占位文字)', () => {
    const entries = [toolEntry('Grep', 0), toolEntry('Glob', 1)]
    render(<ToolGroupCard entries={entries} />)
    expect(screen.queryByText('Grep')).toBeNull()
    expect(screen.queryByText('Glob')).toBeNull()
    expect(screen.getByText(/折叠显示|工具调用中/)).toBeInTheDocument()
  })

  test('单条 entry 标题显示 "1 个工具调用 · <name>"', () => {
    const entries = [toolEntry('Read', 0)]
    render(<ToolGroupCard entries={entries} />)
    expect(screen.getByText(/^1 个工具调用/)).toBeInTheDocument()
    expect(screen.getByText(/· Read/)).toBeInTheDocument()
  })

  test('多条 entry 标题显示 "N 个工具调用 · ..." + collapse 失败 tag', () => {
    const entries: ToolGroupEntry[] = [
      toolEntry('Grep', 0, 'error'),
      toolEntry('Glob', 1, 'done'),
      toolEntry('Grep', 2, 'error'),
    ]
    render(<ToolGroupCard entries={entries} />)
    expect(screen.getByText(/^3 个工具调用/)).toBeInTheDocument()
    expect(screen.getByText(/2 个失败/)).toBeInTheDocument()
  })
})