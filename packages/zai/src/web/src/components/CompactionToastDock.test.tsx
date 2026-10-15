// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom'
import CompactionToastDock from './CompactionToastDock'
import { useAgentStore } from '../store/useAgentStore'

// 压缩提示条 (2026-10-12)。
//
// reducer 刻意不起定时器(见 useAgentStore applyCompactionEvent 上方注释),
// 只写 expiresAt —— 所以「到点自动消失」这件事本身就是 UI 层的责任,
// 这组用例守的就是它。

beforeEach(() => {
  vi.useFakeTimers()
  useAgentStore.setState({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

function pushToast(overrides: Partial<{ id: string; text: string; expiresAt: number }> = {}) {
  useAgentStore.setState({
    toasts: [
      {
        id: overrides.id ?? 't1',
        text: overrides.text ?? '对话已压缩 · 上下文 1,000 tokens 已归档',
        level: 'info',
        sessionId: 's1',
        expiresAt: overrides.expiresAt ?? Date.now() + 5000,
      },
    ],
  })
}

describe('CompactionToastDock', () => {
  test('无 toast 时不渲染任何 DOM', () => {
    const { container } = render(<CompactionToastDock />)
    expect(container.firstChild).toBeNull()
  })

  test('渲染 toast 文案', () => {
    pushToast({ text: '对话已压缩 · 节省 60,000 tokens' })
    render(<CompactionToastDock />)
    expect(screen.getByText('对话已压缩 · 节省 60,000 tokens')).toBeTruthy()
  })

  test('5s 后自动消失 (expiresAt 回收)', () => {
    pushToast()
    render(<CompactionToastDock />)
    expect(screen.getByText(/对话已压缩/)).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(useAgentStore.getState().toasts).toHaveLength(0)
  })

  test('未到期不被提前清掉', () => {
    pushToast()
    render(<CompactionToastDock />)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(useAgentStore.getState().toasts).toHaveLength(1)
  })

  test('点 × 手动 dismiss', () => {
    pushToast()
    render(<CompactionToastDock />)
    act(() => {
      screen.getByLabelText('关闭提示').click()
    })
    expect(useAgentStore.getState().toasts).toHaveLength(0)
  })

  test('多条 toast 各按自己的 expiresAt 回收, 互不误伤', () => {
    const now = Date.now()
    useAgentStore.setState({
      toasts: [
        { id: 'a', text: '早的', level: 'info', sessionId: 's1', expiresAt: now + 2000 },
        { id: 'b', text: '晚的', level: 'info', sessionId: 's1', expiresAt: now + 9000 },
      ],
    })
    render(<CompactionToastDock />)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    // 只回收到期的那条
    expect(useAgentStore.getState().toasts.map((t) => t.id)).toEqual(['b'])

    act(() => {
      vi.advanceTimersByTime(7000)
    })
    expect(useAgentStore.getState().toasts).toHaveLength(0)
  })

  test('已经过期的 toast 在挂载后立即被回收', () => {
    pushToast({ expiresAt: Date.now() - 1000 })
    render(<CompactionToastDock />)
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(useAgentStore.getState().toasts).toHaveLength(0)
  })
})
