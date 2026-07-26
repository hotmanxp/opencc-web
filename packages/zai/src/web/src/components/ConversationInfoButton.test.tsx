// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

import ConversationInfoButton from './ConversationInfoButton.js'

// happy-dom 不会自动派发 CSS `transitionend`,而 antd Modal 内部的 rc-motion
// 状态机离开动画时阻塞在 `transitionend` 监听器上,这让 `destroyOnHidden` 在
// 测试环境下不会同步触发卸载。我们用 vitest fake timers 把 setTimeout 和
// requestAnimationFrame 接管,Modal 关闭后一次性把 timer 跑完,让 rc-motion
// 的 leave 周期跑完,DOM 卸载完毕。生产路径走 antd 标准过渡 + destroyOnHidden,
// 不需要任何修补 —— 这是仅用于 happy-dom 的测试环境 affordance。
describe('ConversationInfoButton — mobile vs desktop branching', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState({ isMobile: false })
    vi.useRealTimers()
  })

  it('desktop (isMobile=false): clicking trigger shows Popover with card content', () => {
    useAppStore.setState({ isMobile: false })
    render(<ConversationInfoButton />)
    // Popover 走 portal, 卡片初始不在 document 里
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('conversation-info-trigger'))
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
    expect(screen.getByTestId('card-session-id').textContent).toBe('sess-test-123')
    // 移动端 Modal 不应出现
    expect(screen.queryByTestId('mobile-conversation-info-modal')).not.toBeInTheDocument()
  })

  it('mobile (isMobile=true): Modal mounts with card content immediately', () => {
    useAppStore.setState({ isMobile: true })
    render(<ConversationInfoButton />)
    act(() => {
      vi.runAllTimers()
    })
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
    act(() => {
      vi.runAllTimers()
    })
    const trigger = screen.getByTestId('conversation-info-trigger')
    // 初始打开 → 关闭: 跑完 fake timers 让 rc-motion 完成 leave + destroyOnHidden
    fireEvent.click(trigger)
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    // 再点 → 打开
    fireEvent.click(trigger)
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
  })
})