// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import MobileSuperTaskCard from './MobileSuperTaskCard'
import type { TaskSummary } from '../../lib/superTaskApi'

const baseTask = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'tf-mob01',
  title: '移动端示例任务',
  status: 'processing',
  cwd: '/abs/code/proj-a',
  bucket: 'processing-tasks',
  createdAt: '2026-09-02T00:00:00.000Z',
  priority: 'P1',
  ...over,
})

describe('MobileSuperTaskCard (2026-09-04)', () => {
  it('渲染优先级 Tag + 状态 Tag 文案', () => {
    render(<MobileSuperTaskCard task={baseTask()} onOpen={vi.fn()} />)
    // 状态 Tag:「执行中」
    expect(screen.getByText('执行中')).toBeTruthy()
    // 优先级 Tag:P1
    expect(screen.getByText('P1')).toBeTruthy()
  })

  it('点击整卡 → 触发 onOpen(task.id)', () => {
    const onOpen = vi.fn()
    render(<MobileSuperTaskCard task={baseTask()} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('mobile-task-card-tf-mob01'))
    expect(onOpen).toHaveBeenCalledWith('tf-mob01')
  })

  it('键盘 Enter → 也触发 onOpen(task.id)', () => {
    const onOpen = vi.fn()
    render(<MobileSuperTaskCard task={baseTask()} onOpen={onOpen} />)
    const card = screen.getByTestId('mobile-task-card-tf-mob01')
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('tf-mob01')
  })

  it('DOM 内无 checkbox / 暂停继续删除按钮(火柴人也不放)', () => {
    const { container } = render(<MobileSuperTaskCard task={baseTask()} onOpen={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(container.querySelector('.ant-checkbox')).toBeNull()
    // 没有火柴人(移动端不展示)
    expect(container.querySelector('[data-testid^="stickman-"]')).toBeNull()
  })

  it('不同状态 / 优先级 走 SuperTaskCard 三张表(集成验证)', () => {
    const cases: Array<{ status: string; priority: TaskSummary['priority']; label: string; cls: string }> = [
      { status: 'queued', priority: 'P2', label: '排队', cls: 'ant-tag-default' },
      { status: 'failed', priority: 'P0', label: '失败', cls: 'ant-tag-error' },
      { status: 'done', priority: 'P3', label: '完成', cls: 'ant-tag-success' },
    ]
    for (const c of cases) {
      const { container } = render(
        <MobileSuperTaskCard
          task={baseTask({ status: c.status, priority: c.priority, id: `tf-${c.status}` })}
          onOpen={vi.fn()}
        />,
      )
      // 状态 Tag 文案 + class(从 SuperTaskCard 复用 STATUS_TAG)
      const statusTag = container.querySelector(`[data-testid="mobile-status-tag-tf-${c.status}"]`)
      expect(statusTag?.textContent).toBe(c.label)
      expect(statusTag?.className.includes(c.cls)).toBe(true)
      // 优先级 Tag 复用 SuperTaskCard PRIORITY_TAG
      const pTag = container.querySelector(`[data-priority="${c.priority}"]`)
      expect(pTag).toBeTruthy()
    }
  })
})