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

  test('Radio 选中后自动跳到下一题 tab (无需手动切 tab)', () => {
    // 用 q1-A / q2-A / q3-A 这种带问题编号的 label, 避免单字母 'A' 在
    // 三个 panel 间撞名. 选中触发用 click label 而不是 click input —
    // happy-dom 下 fireEvent.click(input) 不会触发 antd Radio.Group 的
    // onChange (Radio 监听内部 RcCheckbox 的 click 事件链), 但 click
    // 整个 label 能链式触发内部 input click, 进而触发 onChange.
    //
    // antd Tabs 5.x 切 tab 不卸载 panel (用 CSS hidden + aria-hidden), 所以
    // 不能用 queryByDisplayValue 断言 "q1 panel 已卸载" — 永远会命中. 改
    // 用 getByRole('tab', { selected: true }) / aria-selected 断言 active tab.
    const threeQs = [
      q({ question: 'q1', header: 'H1', options: [{ label: 'q1-A' }, { label: 'q1-B' }] }),
      q({ question: 'q2', header: 'H2', options: [{ label: 'q2-A' }, { label: 'q2-B' }] }),
      q({ question: 'q3', header: 'H3', options: [{ label: 'q3-A' }, { label: 'q3-B' }] }),
    ]
    render(
      <QuestionCard {...baseProps} questions={threeQs} />,
    )
    // 初始 active = q1
    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /H2/ })).toHaveAttribute('aria-selected', 'false')

    // 选 q1-A → handleRadioChange → onAdvance → setTabKey('q2')
    fireEvent.click(screen.getByText('q1-A').closest('label')!)

    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: /H2/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /H3/ })).toHaveAttribute('aria-selected', 'false')
  })

  test('最后一题 Radio 选中后自动跳到 Review tab', () => {
    const twoQs = [
      q({ question: 'q1', header: 'H1', options: [{ label: 'q1-A' }, { label: 'q1-B' }] }),
      q({ question: 'q2', header: 'H2', options: [{ label: 'q2-A' }, { label: 'q2-B' }] }),
    ]
    render(
      <QuestionCard {...baseProps} questions={twoQs} />,
    )
    // 初始 active = q1 (firstQuestion 默认)
    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'true')

    // 手动切到 q2 tab — Review tab 的 accessible name 是 'Review', 其他
    // tab 的 accessible name 由 header Tag + '单选'/'多选' 拼出, 用 regex
    // /H1/ /H2/ 匹配.
    fireEvent.click(screen.getByRole('tab', { name: /H2/ }))
    expect(screen.getByRole('tab', { name: /H2/ })).toHaveAttribute('aria-selected', 'true')

    // 选 q2-B (最后一题) → onAdvance → setTabKey('review')
    fireEvent.click(screen.getByText('q2-B').closest('label')!)

    expect(screen.getByRole('tab', { name: /H2/ })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
  })

  test('Radio 选 Other 时不自动跳 (还要输入文本)', () => {
    const onAnswer = vi.fn()
    const twoQs = [
      q({ question: 'q1', header: 'H1', options: [{ label: 'q1-A' }, { label: 'q1-B' }] }),
      q({ question: 'q2', header: 'H2', options: [{ label: 'q2-A' }, { label: 'q2-B' }] }),
    ]
    render(
      <QuestionCard {...baseProps} onAnswer={onAnswer} questions={twoQs} />,
    )
    // 初始 active = q1
    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'true')

    // 选 Other — onAdvance 在 QuestionPanel 内部被故意排除 (用户还要在
    // Other Input 里写自定义答案). tabKey 应保持 'q1'.
    fireEvent.click(screen.getByText('Other').closest('label')!)

    // handleRadioChange 走 Other 分支, onAnswer 被调但 onAdvance 不被调
    expect(onAnswer).toHaveBeenCalledWith('q1', '__other__')
    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /H2/ })).toHaveAttribute('aria-selected', 'false')
  })

  test('Checkbox (多选) 选中不自动跳 — 用户可能还要勾别的', () => {
    const twoQs = [
      q({ question: 'q1', header: 'H1', multiSelect: true, options: [{ label: 'q1-A' }, { label: 'q1-B' }, { label: 'q1-C' }] }),
      q({ question: 'q2', header: 'H2', options: [{ label: 'q2-A' }, { label: 'q2-B' }] }),
    ]
    render(
      <QuestionCard {...baseProps} questions={twoQs} />,
    )
    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'true')

    // 多选点 q1-A: Checkbox.Group 的 onChange 路径不走 handleRadioChange,
    // onAdvance 不会被调用, 应停留在 q1. label click 链式触发 input click.
    fireEvent.click(screen.getByText('q1-A').closest('label')!)

    expect(screen.getByRole('tab', { name: /H1/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /H2/ })).toHaveAttribute('aria-selected', 'false')
  })
})