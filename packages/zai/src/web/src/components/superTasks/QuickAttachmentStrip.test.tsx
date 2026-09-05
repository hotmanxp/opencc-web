// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import QuickAttachmentStrip, { type QuickAttachment } from './QuickAttachmentStrip.js'

function mkAtt(overrides: Partial<QuickAttachment> = {}): QuickAttachment {
  return {
    localId: `att-${Math.random().toString(36).slice(2)}`,
    mime: 'image/png',
    size: 1024,
    filename: 'shot.png',
    thumbnailUrl: 'blob:fake',
    dataUrl: 'data:image/png;base64,AAA',
    status: 'ready',
    ...overrides,
  }
}

describe('QuickAttachmentStrip', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<QuickAttachmentStrip items={[]} onRemove={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per ready attachment with filename and × button', () => {
    const onRemove = vi.fn()
    render(
      <QuickAttachmentStrip
        items={[mkAtt({ localId: 'a1', filename: 'shot.png' }), mkAtt({ localId: 'a2', filename: 'mock.png' })]}
        onRemove={onRemove}
      />,
    )
    expect(screen.getByTestId('quick-attachment-chip-a1')).toHaveTextContent('shot.png')
    expect(screen.getByTestId('quick-attachment-chip-a2')).toHaveTextContent('mock.png')
  })

  it('calls onRemove(localId) when × is clicked', () => {
    const onRemove = vi.fn()
    render(<QuickAttachmentStrip items={[mkAtt({ localId: 'a1' })]} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId('quick-attachment-chip-a1-remove'))
    expect(onRemove).toHaveBeenCalledWith('a1')
  })

  it('renders error text for status=error attachments', () => {
    render(
      <QuickAttachmentStrip
        items={[mkAtt({ localId: 'err1', status: 'error', error: '文件过大' })]}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByTestId('quick-attachment-chip-err1')).toHaveTextContent('文件过大')
  })

  it('disables × button when disabled=true', () => {
    render(
      <QuickAttachmentStrip
        items={[mkAtt({ localId: 'a1' })]}
        onRemove={vi.fn()}
        disabled
      />,
    )
    const removeBtn = screen.getByTestId('quick-attachment-chip-a1-remove')
    expect(removeBtn.hasAttribute('disabled')).toBe(true)
  })

  it('strip itself has quick-attachment-strip testid when items>0', () => {
    render(<QuickAttachmentStrip items={[mkAtt({ localId: 'a1' })]} onRemove={vi.fn()} />)
    expect(screen.getByTestId('quick-attachment-strip')).toBeInTheDocument()
  })

})