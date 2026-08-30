// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '../store/useAppStore.js'

// Replace the actual hook with a deterministic fixture. We only need the
// shape that ConversationInfoCard consumes.
vi.mock('../hooks/useConversationInfo.js', () => ({
  useConversationInfo: () => ({
    sessionId: 'sess-test-123',
    title: '测试会话',
    startTime: 1_700_000_000_000,
    lastUpdate: 1_700_000_500_000,
    turnCount: 3,
    messageCount: 7,
    status: 'idle',
    cwd: '/tmp/proj',
    model: 'MiniMax-M3',
    settingsLoaded: true,
    displayLabel: 'MiniMax-M3',
    // zai patch (2026-08-30): 新增字段(运行时展示行)。
    coreRuntime: 'repl',
    activeCoreRuntime: 'repl',
  }),
}))

// Stub ConversationInfoCard with a deterministic marker so we can assert
// presence + content without depending on antd Descriptions internals.
vi.mock('./ConversationInfoCard.js', () => ({
  default: ({ info }: { info: { sessionId: string; title: string | null; turnCount: number; messageCount: number } }) => (
    <div data-testid="conversation-info-card">
      <span data-testid="card-session-id">{info.sessionId}</span>
      <span data-testid="card-title">{info.title ?? '—'}</span>
      <span data-testid="card-turns">{info.turnCount}</span>
      <span data-testid="card-messages">{info.messageCount}</span>
    </div>
  ),
}))

// Stub Modal to a minimal synchronous wrapper so the open/close toggle is
// testable in happy-dom without dealing with rc-motion's async leave cycle.
// The real production Modal (with destroyOnHidden) is exercised in browser
// E2E tests; here we just need to verify the trigger toggles mobileOpen and
// that the card body mounts/unmounts accordingly.
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>()
  return {
    ...actual,
    Modal: ({ open, children, ...rest }: { open: boolean; children: React.ReactNode; [k: string]: unknown }) => (
      <div
        data-testid={rest['data-testid'] as string}
        style={{ display: open ? 'block' : 'none' }}
      >
        {open ? children : null}
      </div>
    ),
  }
})

import ConversationInfoButton from './ConversationInfoButton.js'

describe('ConversationInfoButton — mobile vs desktop branching', () => {
  afterEach(() => {
    cleanup()
    useAppStore.setState({ isMobile: false })
  })

  it('desktop (isMobile=false): clicking trigger shows Popover with card content', () => {
    useAppStore.setState({ isMobile: false })
    render(<ConversationInfoButton />)
    // Popover 走 portal, 卡片初始不在 document 里
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('conversation-info-trigger'))
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
    expect(screen.getByTestId('card-session-id').textContent).toBe('sess-test-123')
    // 移动端 Modal 不应出现
    expect(screen.queryByTestId('mobile-conversation-info-modal')).not.toBeInTheDocument()
  })

  it('mobile (isMobile=true): Modal mounts with card content immediately', () => {
    useAppStore.setState({ isMobile: true })
    render(<ConversationInfoButton />)
    // 移动端默认展开(走 Modal 而不是 Popover),不需点击 trigger
    expect(screen.getByTestId('mobile-conversation-info-modal')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
    expect(screen.getByTestId('card-turns').textContent).toBe('3')
    expect(screen.getByTestId('card-messages').textContent).toBe('7')
    // 桌面 Popover 触发路径不应被用到
    expect(screen.queryByTestId('desktop-popover-anchor')).not.toBeInTheDocument()
  })

  it('mobile: clicking the trigger toggles the Modal open state', () => {
    useAppStore.setState({ isMobile: true })
    render(<ConversationInfoButton />)
    const trigger = screen.getByTestId('conversation-info-trigger')
    // 初始打开 → 关闭
    fireEvent.click(trigger)
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    // 再点 → 打开
    fireEvent.click(trigger)
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
  })
})