// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import MobileSupervisorDrawer from './MobileSupervisorDrawer'
import { useAgentStore } from '../../store/useAgentStore'

vi.mock('../../pages/AgentConversation', () => ({
  default: () => <div data-testid="supervisor-conv-mock" />,
}))

beforeEach(() => {
  useAgentStore.setState({
    status: 'idle',
  })
})

describe('MobileSupervisorDrawer (2026-09-04)', () => {
  it('默认 Drawer 不可见(portal 未挂载)', () => {
    render(
      <MobileSupervisorDrawer open={false} onOpen={vi.fn()} onClose={vi.fn()} />,
    )
    // AntD Drawer 即便 open=false 也会渲染 wrapper,但内容容器不带 visible class
    // —— 通过查 data-testid 验证 AgentConversation mock 不在 DOM。
    expect(screen.queryByTestId('supervisor-conv-mock')).toBeNull()
    // FAB 始终可见
    expect(screen.getByTestId('mobile-supervisor-fab')).toBeTruthy()
    // 默认 idle 时不显示 streaming 圆点
    expect(screen.queryByTestId('mobile-supervisor-fab-dot')).toBeNull()
  })

  it('点 FAB → 调 onOpen', () => {
    const onOpen = vi.fn()
    render(
      <MobileSupervisorDrawer open={false} onOpen={onOpen} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId('mobile-supervisor-fab'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('open=true → Drawer 内容存在(含 AgentConversation mock)', () => {
    render(
      <MobileSupervisorDrawer open={true} onOpen={vi.fn()} onClose={vi.fn()} />,
    )
    // AntD Drawer 默认 destroyOnHidden=false 时内容保留在 DOM
    expect(screen.getByTestId('mobile-supervisor-drawer')).toBeTruthy()
    expect(screen.getByTestId('supervisor-conv-mock')).toBeTruthy()
  })

  it('status=streaming → FAB 右上角显示小圆点', () => {
    useAgentStore.setState({ status: 'streaming' })
    render(
      <MobileSupervisorDrawer open={false} onOpen={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('mobile-supervisor-fab-dot')).toBeTruthy()
  })

  it('status=idle → FAB 无圆点', () => {
    useAgentStore.setState({ status: 'idle' })
    render(
      <MobileSupervisorDrawer open={false} onOpen={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('mobile-supervisor-fab-dot')).toBeNull()
  })
})