// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { useAgentStore } from '../store/useAgentStore'
import CompactingIndicator from './CompactingIndicator'

const renderToHtml = () => render(<CompactingIndicator />)

// 压缩过程态指示条 (2026-10-12)。
//
// 关键回归是这个组件**独立于 CompactionToastDock**:后者靠每条 toast 的
// expiresAt(5s)自动回收,压缩跑几十秒会被误删。两条断言分别锁"该显示时显示"
// 与"结束后完全消失(不留占位、不残留 DOM)",后者兼作"没被塞进 toast 池"的
// 间接证明 —— 若合并进 ToastDock,这里会因为 5s 回收而行为不同。
describe('CompactingIndicator', () => {
  beforeEach(() => {
    useAgentStore.setState({ compacting: false, toasts: [] })
  })

  test('compacting=false 时不渲染任何 DOM', () => {
    const { container } = renderToHtml()
    expect(container.innerHTML).toBe('')
  })

  test('compacting=true 时显示「正在压缩…」', () => {
    useAgentStore.setState({ compacting: true })
    const { container } = renderToHtml()
    expect(container.textContent).toContain('正在压缩')
    // 语义提示给屏幕阅读器
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  test('结束后完全消失, 不留占位', () => {
    useAgentStore.setState({ compacting: true })
    const first = renderToHtml()
    expect(first.container.textContent).toContain('正在压缩')

    useAgentStore.setState({ compacting: false })
    const second = renderToHtml()
    expect(second.container.innerHTML).toBe('')
  })

  test('不写入 toasts 池 (与 ToastDock 的 5s 回收互不影响)', () => {
    useAgentStore.setState({ compacting: true })
    renderToHtml()
    expect(useAgentStore.getState().toasts).toHaveLength(0)
  })
})