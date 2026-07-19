// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import QuestionCard from './QuestionCard.jsx'

const baseProps = {
  answers: {} as Record<string, string>,
  annotations: {} as Record<string, { notes?: string }>,
  status: 'pending' as const,
  onAnswer: vi.fn(),
  onNotesChange: vi.fn(),
  onSubmit: vi.fn(),
  onReject: vi.fn(),
}

const q = (over: Partial<any> = {}) => ({
  question: 'pick one?',
  header: 'Topic',
  options: [
    { label: 'A', description: 'a' },
    { label: 'B', description: 'b' },
  ],
  multiSelect: false,
  ...over,
})

describe('QuestionCard — 单问题直出', () => {
  test('单个问题时页面不渲染 Tabs 容器, Submit 按钮直接出现在末尾', () => {
    const { container } = render(
      <QuestionCard
        {...baseProps}
        questions={[q()]}
      />,
    )
    // 渲染问题本身
    expect(screen.getByText('pick one?')).toBeInTheDocument()
    // 单问题直出: 不应该渲染 antd Tabs 容器, 也不会有 Review tab
    expect(container.querySelector('.ant-tabs')).toBeNull()
    expect(screen.queryByText('Review')).toBeNull()
    // Submit 按钮直接渲染在页面里
    expect(screen.getByText('Submit answers')).toBeInTheDocument()
  })

  test('单问题未回答时 Submit 按钮 disabled, 回答后 enable 并触发 onSubmit', () => {
    const onAnswer = vi.fn()
    const onSubmit = vi.fn()
    const { rerender } = render(
      <QuestionCard
        {...baseProps}
        onAnswer={onAnswer}
        onSubmit={onSubmit}
        questions={[q()]}
        answers={{}}
      />,
    )
    // "Submit answers" 文本 + closest('button') 拿到 antd Button 根元素
    const submit = screen.getByText('Submit answers').closest('button')!
    expect(submit).toBeDisabled()

    // 选 A → 重渲染模拟 store 更新
    rerender(
      <QuestionCard
        {...baseProps}
        onAnswer={onAnswer}
        onSubmit={onSubmit}
        questions={[q()]}
        answers={{ 'pick one?': 'A' }}
      />,
    )
    expect(submit).not.toBeDisabled()
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

describe('QuestionCard — 多问题保留 Tabs + Review 流程', () => {
  const twoQs = [
    q({ question: 'q1', header: 'H1' }),
    q({ question: 'q2', header: 'H2' }),
  ]

  test('多个问题时 Tabs 容器存在, Review tab 渲染', () => {
    const { container } = render(
      <QuestionCard
        {...baseProps}
        questions={twoQs}
        answers={{ q1: 'A', q2: 'B' }}
      />,
    )
    expect(container.querySelector('.ant-tabs')).not.toBeNull()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  test('未全部回答时 Review tab 里的 Submit disabled', () => {
    render(
      <QuestionCard
        {...baseProps}
        questions={twoQs}
        answers={{ q1: 'A' }}
      />,
    )
    // 切到 Review tab — 在 antd Tabs 里 Review 文本是可点击的 tab 标题
    fireEvent.click(screen.getByText('Review'))
    const submit = screen.getByText('Submit answers').closest('button')!
    expect(submit).toBeDisabled()
  })
})