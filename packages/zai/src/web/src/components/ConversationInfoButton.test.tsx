// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
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

// happy-dom does not auto-dispatch CSS `transitionend`. antd Modal's
// rc-motion state machine (PREPARE → START → ACTIVE → ACTIVATED) is driven
// by chained rAF callbacks, and only at STEP_ACTIVE does it register its
// `transitionend` listener. We force every rAF callback to fire synchronously
// so the listener is attached in the same task as the click; then we dispatch
// `transitionend` on the motion-wrapped elements (`.ant-modal-mask` and
// `.ant-modal`, NOT `.ant-modal-content` — rc-motion rejects events whose
// target isn't the wrapped element). Production keeps the standard
// transitions; this is purely a test-environment affordance.
beforeAll(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    ((cb: FrameRequestCallback) => {
      cb(performance.now())
      return 0
    }) as typeof window.requestAnimationFrame,
  )
})
afterAll(() => {
  vi.mocked(window.requestAnimationFrame).mockRestore()
})

const flushModalTransition = (modalTestId: string) => {
  const root = screen.queryByTestId(modalTestId)
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('.ant-modal-mask, .ant-modal')) {
    fireEvent.transitionEnd(el, { propertyName: 'opacity' })
  }
}

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
    // 初始打开 → 关闭: 同步 rAF 让 rc-motion 走到 STEP_ACTIVE 注册 listener,
    // 然后派发 transitionend 让 destroyOnHidden 卸载子树。
    fireEvent.click(trigger)
    flushModalTransition('mobile-conversation-info-modal')
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    // 再点 → 打开
    fireEvent.click(trigger)
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
  })
})