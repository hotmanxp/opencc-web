// @vitest-environment happy-dom
// Regression: 紧凑模式 (transcriptCollapsed=true) 下, ToolGroupCard 展开 8 个
// 并行工具调用时, 每个 ToolCallBlock 内部 AntD Collapse header 不会把 Card
// 撑爆 — 修复前 .ant-collapse-header-text 用 flex:auto + 默认 min-width:auto,
// 长 preview + pill + Tag 会按内容自然撑开, 直接撑爆 Card.maxWidth:85% 的
// 上限. 修复方案:
//   1. ToolGroupCard.Card 加 width:100% + box-sizing:border-box + overflow:hidden
//      让 maxWidth 真正生效
//   2. ToolCallBlock 包裹 div 加 width:100% + min-width:0 + box-sizing
//   3. Collapse label 容器加 width:100% + Tag 加 flex-shrink:0
//   4. preview Text 强制 ellipsis (原本就有 flex:1+min-width:0+nowrap+ellipsis)
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

describe('ToolGroupCard — 紧凑模式不溢出', () => {
  test('Card 容器应用 width:100% + overflow:hidden 让 maxWidth 生效', () => {
    const entries = [
      toolEntry('Grep', 0),
      toolEntry('Glob', 1),
      toolEntry('Grep', 2),
    ]
    const { container } = render(<ToolGroupCard entries={entries} />)
    const card = container.querySelector('.ant-card') as HTMLElement
    expect(card).toBeInTheDocument()
    const style = card.style
    // 修复前 width 默认空, maxWidth:85% 失效, Card 跟着内容撑到 100% 视口.
    expect(style.width).toBe('100%')
    expect(style.boxSizing).toBe('border-box')
    expect(style.overflow).toBe('hidden')
    expect(style.maxWidth).toBe('85%')
  })

  test('展开 8 个 ToolCallBlock 不撑爆 Card (smoke — Card 不被内部子元素撑大)', () => {
    // 用 mock IntersectionObserver / ResizeObserver 兜底, happy-dom 不带这俩
    // API, AntD Card / Collapse 内部若用到也不会崩 (但本测试只测样式, 不依赖 layout).
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
    // 展开
    fireEvent.click(screen.getByRole('button', { name: /展开 8 个工具/ }))
    const card = container.querySelector('.ant-card') as HTMLElement
    expect(card).toBeInTheDocument()
    // Card 自身的 inline style 必须包含 box-sizing: border-box + overflow:hidden
    // 否则 AntD Card 在 happy-dom + jsdom 下 width 由内容自然撑开, maxWidth 失效.
    expect(card.style.boxSizing).toBe('border-box')
    expect(card.style.overflow).toBe('hidden')
    expect(card.style.maxWidth).toBe('85%')
    expect(card.style.width).toBe('100%')
  })

  test('展开后每个 ToolCallBlock 包裹 div 应用 width:100% + min-width:0', () => {
    const entries = [toolEntry('Grep', 0), toolEntry('Glob', 1)]
    const { container } = render(<ToolGroupCard entries={entries} />)
    fireEvent.click(screen.getByRole('button', { name: /展开 2 个工具/ }))
    // ToolCallBlock 渲染的最外层 div 在 happy-dom 下是直接 div (非 AntD wrap).
    // 我们 inline 写入 width:100% + min-width:0, 强制内部 flex 容器收缩.
    const wrappers = Array.from(
      container.querySelectorAll('.ant-card .ant-card-body div[style*="width: 100%"]'),
    )
    // 至少要有一个 wrapper div (ToolCallBlock 包裹层) 应用了 width:100%.
    expect(wrappers.length).toBeGreaterThan(0)
  })

  test('折叠态不渲染 ToolCallBlock (只显示 "折叠显示" 占位文字)', () => {
    const entries = [toolEntry('Grep', 0), toolEntry('Glob', 1)]
    render(<ToolGroupCard entries={entries} />)
    // 默认折叠 — 不应渲染 chip pill
    expect(screen.queryByText('Grep')).toBeNull()
    expect(screen.queryByText('Glob')).toBeNull()
    // 占位文字
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