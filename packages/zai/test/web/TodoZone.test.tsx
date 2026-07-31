// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import TodoZone from '../../src/web/src/components/TodoZone.tsx'
import type { V2TaskItem } from '../../src/web/src/store/useAgentStore.js'

const v2 = (id: string, subject: string, status: V2TaskItem['status']): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0,
})

describe('TodoZone', () => {
  it('空 tasks → render null', () => {
    const { container } = render(<TodoZone tasks={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('3 项 tasks → render 标题 + 3 项', () => {
    const tasks: V2TaskItem[] = [
      v2('t1', 'A', 'completed'),
      v2('t2', 'B', 'in_progress'),
      v2('t3', 'C', 'pending'),
    ]
    render(<TodoZone tasks={tasks} />)
    expect(screen.getByText('3 tasks (1 done, 1 in progress, 1 open)')).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('completed 项渲染 ✓ 图标', () => {
    const tasks: V2TaskItem[] = [
      v2('t1', 'done-item', 'completed'),
    ]
    const { container } = render(<TodoZone tasks={tasks} />)
    const li = container.querySelector('[data-testid="task-item-completed"]')!
    expect(li.textContent).toContain('✓')
  })

  it('in_progress 项渲染 ■ 图标, pending 项渲染 ☐', () => {
    const tasks: V2TaskItem[] = [
      v2('t1', 'ip', 'in_progress'),
      v2('t2', 'pd', 'pending'),
    ]
    const { container } = render(<TodoZone tasks={tasks} />)
    expect(container.querySelector('[data-testid="task-item-in_progress"]')!.textContent).toContain('■')
    expect(container.querySelector('[data-testid="task-item-pending"]')!.textContent).toContain('☐')
  })

  it('deleted 项不渲染 (软删除)', () => {
    const tasks: V2TaskItem[] = [
      v2('t1', 'visible', 'completed'),
      v2('t2', 'gone', 'deleted'),
    ]
    render(<TodoZone tasks={tasks} />)
    expect(screen.getByText('visible')).toBeInTheDocument()
    expect(screen.queryByText('gone')).toBeNull()
    expect(screen.getByText('1 tasks (1 done, 0 in progress, 0 open)')).toBeInTheDocument()
  })
})
