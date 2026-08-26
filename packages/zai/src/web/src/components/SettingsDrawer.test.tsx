// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SettingsList, default as SettingsDrawer, type SettingsSchema } from './SettingsDrawer.js'
import { useAppStore } from '../store/useAppStore.js'

const schema: SettingsSchema = [
  {
    section: 'Display',
    rows: [
      {
        key: 'maxVisibleMessages',
        label: '消息显示上限',
        kind: 'number',
        value: 20,
        min: 5,
        max: 200,
        step: 1,
      },
    ],
  },
]

describe('SettingsList — number row', () => {
  it('renders the row with current value', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    expect(screen.getByText('消息显示上限')).toBeInTheDocument()
    // 当前值 20 应该可见
    expect(screen.getByText('20')).toBeInTheDocument()
    // + / - 按钮始终可见
    expect(screen.getByTestId('number-row-plus-maxVisibleMessages')).toBeInTheDocument()
    expect(screen.getByTestId('number-row-minus-maxVisibleMessages')).toBeInTheDocument()
  })

  it('Enter on selected number row enters edit mode and shows input', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    // 默认选中第一个 row → 直接按 Enter 进入编辑模式
    fireEvent.keyDown(window, { key: 'Enter' })
    const input = screen.getByTestId('number-row-input-maxVisibleMessages')
    expect(input).toBeInTheDocument()
  })

  it('submitting a new value calls onChange with parsed number', () => {
    const onChange = vi.fn()
    render(
      <SettingsList schema={schema} onClose={() => {}} onChange={onChange} />,
    )
    // 进入编辑
    fireEvent.keyDown(window, { key: 'Enter' })
    const input = screen.getByTestId(
      'number-row-input-maxVisibleMessages',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('maxVisibleMessages', 42)
  })

  it('Escape exits edit mode without calling onChange', () => {
    const onChange = vi.fn()
    render(
      <SettingsList schema={schema} onClose={() => {}} onChange={onChange} />,
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    const input = screen.getByTestId(
      'number-row-input-maxVisibleMessages',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    // 输入框应消失,值仍是 20
    expect(
      screen.queryByTestId('number-row-input-maxVisibleMessages'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
  })

  it('+ button increments by step and triggers onChange', () => {
    const onChange = vi.fn()
    render(
      <SettingsList schema={schema} onClose={() => {}} onChange={onChange} />,
    )
    fireEvent.click(screen.getByTestId('number-row-plus-maxVisibleMessages'))
    expect(onChange).toHaveBeenCalledWith('maxVisibleMessages', 21)
  })

  it('− button decrements by step and clamps to min', () => {
    const onChange = vi.fn()
    // 用 min=5, value=5 时 − 应该钳到 5
    const atMinSchema: SettingsSchema = [
      {
        section: 'Display',
        rows: [
          {
            key: 'maxVisibleMessages',
            label: '消息显示上限',
            kind: 'number',
            value: 5,
            min: 5,
            max: 200,
            step: 1,
          },
        ],
      },
    ]
    render(
      <SettingsList
        schema={atMinSchema}
        onClose={() => {}}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByTestId('number-row-minus-maxVisibleMessages'))
    // 已经到 min,再减仍应是 min
    expect(onChange).toHaveBeenCalledWith('maxVisibleMessages', 5)
  })
})

describe('SettingsDrawer — schema wires Display section', () => {
  afterEach(() => {
    cleanup()
    // 重置 store 状态,避免污染后续测试
    useAppStore.setState({
      maxVisibleMessages: 20,
      settingsDrawerOpen: false,
    })
  })

  it('schema includes maxVisibleMessages row under Display section', () => {
    useAppStore.setState({
      maxVisibleMessages: 30,
      settingsDrawerOpen: true,
    })
    render(<SettingsDrawer />)
    // Display section header + 新加的 row 标签 / 数值都应出现
    expect(screen.getByText('显示')).toBeInTheDocument()
    expect(screen.getByText('消息最大显示条数')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
  })
})