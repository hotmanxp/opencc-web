// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useAgentStore } from '../store/useAgentStore.js'
import MobileHeader from './MobileHeader.js'

beforeEach(() => {
  useAgentStore.setState({
    sessionId: 's1',
    sessions: [{ sessionId: 's1', title: '测试会话' }],
    status: 'idle',
  })
})

describe('MobileHeader — 会话切换禁用', () => {
  it('idle 时新建会话按钮可用', () => {
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.getByTestId('mobile-header-new-session')).toBeEnabled()
  })

  it('streaming 时新建会话按钮 disabled(对话进行中禁用会话切换)', () => {
    useAgentStore.setState({ status: 'streaming' })
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    const btn = screen.getByTestId('mobile-header-new-session')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute(
      'title',
      '对话进行中,请等待当前回复结束',
    )
  })
})
