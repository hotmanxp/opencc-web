// @vitest-environment happy-dom
// SettingsDrawer TUI 重写回归测试 — 验证 opencc /config 风格的键盘交互:
//   ↑↓ 移动光标、Space 切换布尔、Enter 弹枚举下拉、/ 进入搜索、Esc 关闭。
// 这里测试 SettingsList 内部组件 (从 Drawer 抽离, 便于绕开 AntD Drawer portal),
// 集成到 Drawer 时由 Agent.tsx 顶层 mount, 由 store.settingsDrawerOpen 控制显隐。
//
// 键盘事件:SettingsList 监听 window keydown,所以测试用 fireEvent.keyDown(window) 触发。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useAppStore } from '../../src/web/src/store/useAppStore.js'
import {
  SettingsList,
  type SettingsValue,
  type SettingsSchema,
} from '../../src/web/src/components/SettingsDrawer.js'

const schema: SettingsSchema = [
  {
    section: 'Permission',
    rows: [
      { key: 'autoCompact', label: '自动压缩', kind: 'boolean', value: true },
      { key: 'toolCompact', label: '工具历史压缩', kind: 'boolean', value: true },
      { key: 'thinkingMode', label: '思考模式', kind: 'boolean', value: true },
    ],
  },
  {
    section: 'Theme',
    rows: [
      {
        key: 'theme',
        label: '主题',
        kind: 'enum',
        value: 'dark',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'dark', label: 'Dark mode' },
          { value: 'light', label: 'Light' },
        ],
      },
      {
        key: 'permissionMode',
        label: '默认权限模式',
        kind: 'enum',
        value: 'bypassPermissions',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'plan', label: 'Plan' },
          { value: 'bypassPermissions', label: 'Bypass Permissions' },
        ],
      },
    ],
  },
]

beforeEach(() => {
  cleanup()
  useAppStore.setState({
    settingsDrawerOpen: true,
    settingsTheme: 'dark',
    setSettingsTheme: useAppStore.getState().setSettingsTheme,
  } as any)
})

// 用 fireEvent.keyDown(window) 触发 keydown — happy-dom 的 fireEvent
// 会触发 React state batch update;native window.dispatchEvent 不会被 React
// scheduler 捕获,状态变化不会反映到 DOM。
function pressKey(key: string) {
  fireEvent.keyDown(window, { key })
}

// 包一层让测试拥有自己的 schema state — SettingsList 是受控组件,
// 测试需要根据 onChange 更新本地 schema,触发 re-render 才能看到行值变化。
function ControlledSettingsList(props: { onChange?: (k: string, v: SettingsValue) => void }) {
  const [s, setS] = useState<SettingsSchema>(schema)
  return (
    <SettingsList
      schema={s}
      onClose={() => {}}
      onChange={(k, v) => {
        props.onChange?.(k, v)
        setS((prev) =>
          prev.map((sec) => ({
            ...sec,
            rows: sec.rows.map((r) => {
              if (r.key !== k) return r
              if (r.kind === 'boolean' && typeof v === 'boolean') return { ...r, value: v }
              if (r.kind === 'enum' && typeof v === 'string') return { ...r, value: v }
              return r
            }),
          })),
        )
      }}
    />
  )
}

describe('SettingsList — 渲染', () => {
  it('渲染所有 section + row, 值右对齐', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    expect(screen.getByText('Permission')).toBeDefined()
    expect(screen.getByText('Theme')).toBeDefined()
    expect(screen.getByText('自动压缩')).toBeDefined()
    expect(screen.getByText('主题')).toBeDefined()
    // boolean 显示 'true',但 Permission section 有 3 行都 true — 用 getAllByText
    expect(screen.getAllByText('true').length).toBe(3)
    expect(screen.getByText('Dark mode')).toBeDefined()
    expect(screen.getByText('Bypass Permissions')).toBeDefined()
  })

  it('首行默认 selected', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    const selected = document.querySelector('[data-selected="true"]')
    expect(selected?.getAttribute('data-row-key')).toBe('autoCompact')
  })

  it('section header 不是 row, 不带 data-row-key', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    const sectionHeaders = document.querySelectorAll('[data-section-header="true"]')
    expect(sectionHeaders.length).toBe(2)
    sectionHeaders.forEach((el) => {
      expect(el.getAttribute('data-row-key')).toBeNull()
    })
  })
})

describe('SettingsList — ↑↓ 键盘导航', () => {
  it('ArrowDown 把 selected 下移一行', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('ArrowDown')
    expect(document.querySelector('[data-selected="true"]')?.getAttribute('data-row-key')).toBe('toolCompact')
  })

  it('ArrowUp 把 selected 上移一行', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('ArrowDown')
    pressKey('ArrowUp')
    expect(document.querySelector('[data-selected="true"]')?.getAttribute('data-row-key')).toBe('autoCompact')
  })

  it('ArrowDown 跨 section 时跳过 section header', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('ArrowDown') // toolCompact
    pressKey('ArrowDown') // thinkingMode
    pressKey('ArrowDown') // theme
    expect(document.querySelector('[data-selected="true"]')?.getAttribute('data-row-key')).toBe('theme')
  })

  it('已到底部时 ArrowDown clamp', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    for (let i = 0; i < 10; i++) pressKey('ArrowDown')
    expect(document.querySelector('[data-selected="true"]')?.getAttribute('data-row-key')).toBe('permissionMode')
  })

  it('已到顶部时 ArrowUp clamp', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    for (let i = 0; i < 10; i++) pressKey('ArrowUp')
    expect(document.querySelector('[data-selected="true"]')?.getAttribute('data-row-key')).toBe('autoCompact')
  })
})

describe('SettingsList — Space toggle (boolean)', () => {
  it('Space 切换 boolean row 的 true/false', () => {
    render(<ControlledSettingsList />)
    // 初始:Permission 3 个 boolean 行都是 true
    expect(screen.getAllByText('true').length).toBe(3)
    pressKey(' ')
    // autoCompact 切到 false → 剩 2 个 true,新增 1 个 false
    expect(screen.getAllByText('true').length).toBe(2)
    expect(screen.getByText('false')).toBeDefined()
  })

  it('Space 在 enum row 上不做 toggle', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey(' ')
    expect(screen.getByText('Dark mode')).toBeDefined()
  })

  it('Space 通过 onChange 回调把新值传出去', () => {
    const onChange = vi.fn()
    render(<SettingsList schema={schema} onClose={() => {}} onChange={onChange} />)
    pressKey(' ')
    expect(onChange).toHaveBeenCalledWith('autoCompact', false)
  })
})

describe('SettingsList — Enter 弹枚举下拉', () => {
  it('Enter 在 enum row 上弹出下拉浮层, 显示所有 options', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('Enter')
    const overlay = screen.getByTestId('settings-enum-overlay')
    expect(overlay.textContent).toContain('Auto')
    expect(overlay.textContent).toContain('Dark mode')
    expect(overlay.textContent).toContain('Light')
  })

  it('下拉里 ↑↓ 切换高亮, Enter 选中并通过 onChange 回调', () => {
    const onChange = vi.fn()
    render(<SettingsList schema={schema} onClose={() => {}} onChange={onChange} />)
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('Enter')
    pressKey('ArrowDown')
    pressKey('Enter')
    expect(onChange).toHaveBeenCalledWith('theme', 'light')
  })

  it('Esc 关闭枚举下拉, 不修改值', () => {
    const onChange = vi.fn()
    render(<SettingsList schema={schema} onClose={() => {}} onChange={onChange} />)
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('Enter')
    pressKey('Escape')
    expect(screen.queryByTestId('settings-enum-overlay')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Enter 在 boolean row 上不弹下拉, 不回调', () => {
    const onChange = vi.fn()
    render(<SettingsList schema={schema} onClose={() => {}} onChange={onChange} />)
    pressKey('Enter')
    expect(screen.queryByTestId('settings-enum-overlay')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('SettingsList — / 搜索', () => {
  it('/ 进入搜索模式, 输入过滤行', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('/')
    const search = screen.getByTestId('settings-search-input') as HTMLInputElement
    fireEvent.change(search, { target: { value: '主题' } })
    expect(screen.queryByText('自动压缩')).toBeNull()
    expect(screen.queryByText('思考模式')).toBeNull()
    expect(screen.getByText('主题')).toBeDefined()
  })

  it('搜索无命中时显示空提示', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('/')
    const search = screen.getByTestId('settings-search-input') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'xyz不存在的设置' } })
    expect(screen.getByText(/无匹配/)).toBeDefined()
  })

  it('Esc 在搜索模式下退出搜索, 回到完整列表', () => {
    render(<SettingsList schema={schema} onClose={() => {}} />)
    pressKey('/')
    const search = screen.getByTestId('settings-search-input') as HTMLInputElement
    fireEvent.change(search, { target: { value: '主题' } })
    pressKey('Escape')
    expect(screen.queryByTestId('settings-search-input')).toBeNull()
    expect(screen.getByText('自动压缩')).toBeDefined()
  })
})

describe('SettingsList — Esc 关闭 Drawer', () => {
  it('非搜索、非浮层时按 Esc 调用 onClose', () => {
    const onClose = vi.fn()
    render(<SettingsList schema={schema} onClose={onClose} />)
    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsList — 状态联动 (store 集成)', () => {
  it('主题行变更通过 setSettingsTheme 写回 store', () => {
    const onChange = vi.fn((key, value) => {
      if (key === 'theme') useAppStore.getState().setSettingsTheme(value as SettingsValue)
    })
    render(<SettingsList schema={schema} onClose={() => {}} onChange={onChange} />)
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('Enter')
    pressKey('ArrowDown')
    pressKey('Enter')
    expect(useAppStore.getState().settingsTheme).toBe('light')
  })
})