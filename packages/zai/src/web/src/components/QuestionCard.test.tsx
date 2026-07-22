// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import QuestionCard from './QuestionCard.jsx'

const baseProps = {
  answers: {} as Record<string, string>,
  annotations: {} as Record<string, { notes?: string; otherText?: string }>,
  status: 'pending' as const,
  onAnswer: vi.fn(),
  onNotesChange: vi.fn(),
  onOtherChange: vi.fn(),
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

  test('选项列表末尾自动追加一个 "Other" 选项 (UI 自动添加, AI prompt 约定)', () => {
    const { container } = render(
      <QuestionCard
        {...baseProps}
        questions={[q()]}
      />,
    )
    // AI 只给了 A/B, UI 必须额外渲染 Other
    expect(screen.getByText('Other')).toBeInTheDocument()
  })

  test('单选选 Other 时弹出 Input,输入文本前 Submit 仍 disabled (占位符未答完)', () => {
    // 2026-07-20 fix: Other 文本独立存 annotations.otherText,
    // answers 始终保持 '__other__' 占位符 (避免 Radio 模式下 Input 块
    // 在打字瞬间被卸载导致焦点丢失的 bug).
    const { rerender } = render(
      <QuestionCard
        {...baseProps}
        questions={[q()]}
        answers={{ 'pick one?': '__other__' }}
      />,
    )
    // 占位符状态下 Submit 必须 disabled — annotations.otherText 还没填,
    // 用户其实还没输入真正的回答
    const submit = screen.getByText('Submit answers').closest('button')!
    expect(submit).toBeDisabled()

    // 模拟 store 收到用户文本 (经 onOtherChange 写 annotations.otherText)
    rerender(
      <QuestionCard
        {...baseProps}
        questions={[q()]}
        answers={{ 'pick one?': '__other__' }}
        annotations={{ 'pick one?': { otherText: 'My custom answer' } }}
      />,
    )
    expect(submit).not.toBeDisabled()
  })

  test('修复: 选中 Other 并打字时, Input 块始终挂载 (焦点不丢失)', () => {
    // 回归测试 — Bug 历史: 之前 onChange 把用户文本写进 answers, 导致
    // currentAnswer 立刻变成 'h' (等), isOtherSelected 变 false, Input
    // 块被卸载, 焦点丢失到附加说明 TextArea. 修复后 answers 保持
    // '__other__' 不变, Input 块始终挂载.
    const onAnswer = vi.fn()
    const onOtherChange = vi.fn()
    const { rerender, container } = render(
      <QuestionCard
        {...baseProps}
        questions={[q()]}
        answers={{ 'pick one?': '__other__' }}
        onAnswer={onAnswer}
        onOtherChange={onOtherChange}
      />,
    )
    // 模拟用户点选 Other → store 写 '__other__'
    expect(container.querySelector('input[placeholder="请输入..."]')).not.toBeNull()

    // 模拟 store 收到第一次按键 (旧实现会写 'h' 进 answers; 新实现只
    // 走 onOtherChange). 重渲染时 answers 仍保持 '__other__'.
    rerender(
      <QuestionCard
        {...baseProps}
        questions={[q()]}
        answers={{ 'pick one?': '__other__' }}
        annotations={{ 'pick one?': { otherText: 'h' } }}
        onAnswer={onAnswer}
        onOtherChange={onOtherChange}
      />,
    )
    // Input 块必须仍在 DOM 里 (旧 bug 这里会被卸载)
    expect(container.querySelector('input[placeholder="请输入..."]')).not.toBeNull()
    // 验证 onAnswer 没有被错误调用 (新实现不污染 answers)
    expect(onAnswer).not.toHaveBeenCalled()
    expect(onOtherChange).toHaveBeenCalledWith('pick one?', 'h')
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