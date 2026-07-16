// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import TodoZone from '../../src/web/src/components/TodoZone.tsx'
import type { TodoItem } from '../../src/web/src/store/useAgentStore.js'

describe('TodoZone', () => {
  it('空 todos → render null', () => {
    const { container } = render(<TodoZone todos={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('3 项 todos → render 标题 + 3 项', () => {
    const todos: TodoItem[] = [
      { content: 'A', status: 'completed', activeForm: 'A' },
      { content: 'B', status: 'in_progress', activeForm: 'B' },
      { content: 'C', status: 'pending', activeForm: 'C' },
    ]
    render(<TodoZone todos={todos} />)
    expect(screen.getByText('3 tasks (1 done, 1 in progress, 1 open)')).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('completed 项渲染 ✓ 图标', () => {
    const todos: TodoItem[] = [
      { content: 'done-item', status: 'completed', activeForm: 'x' },
    ]
    const { container } = render(<TodoZone todos={todos} />)
    const li = container.querySelector('[data-testid="todo-item-completed"]')!
    expect(li.textContent).toContain('✓')
  })

  it('in_progress 项渲染 ■ 图标, pending 项渲染 ☐', () => {
    const todos: TodoItem[] = [
      { content: 'ip', status: 'in_progress', activeForm: 'x' },
      { content: 'pd', status: 'pending', activeForm: 'y' },
    ]
    const { container } = render(<TodoZone todos={todos} />)
    expect(container.querySelector('[data-testid="todo-item-in_progress"]')!.textContent).toContain('■')
    expect(container.querySelector('[data-testid="todo-item-pending"]')!.textContent).toContain('☐')
  })
})
