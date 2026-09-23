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

describe('SettingsDrawer — 微信配置入口只在主实例显示', () => {
  afterEach(() => {
    cleanup()
    useAppStore.setState({
      settingsDrawerOpen: false,
      instanceContext: null,
    })
  })

  // 主实例 = 顶层受管 child:它同样带 ZAI_SUPERVISOR_PID(isManagedChild === true),
  // 只是没有 ZAI_INSTANCE_ID。判据必须是 instanceId 而不是 isManagedChild,否则
  // 主实例的入口会被误摘掉(aeae3d9 引入的回归)。
  it('主实例(顶层受管 child,无 instanceId)显示「微信机器人」入口', () => {
    useAppStore.setState({
      settingsDrawerOpen: true,
      instanceContext: {
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: 'main',
        isManagedChild: true,
        supervisorPid: 12345,
        instanceId: null,
        app: null,
      },
    })
    render(<SettingsDrawer />)
    expect(screen.getByTestId('settings-weixin-section')).toBeInTheDocument()
    expect(screen.getByTestId('open-weixin-bot')).toBeInTheDocument()
  })

  it('受管子进程(app=weixin 专用实例)不显示「微信机器人」入口', () => {
    useAppStore.setState({
      settingsDrawerOpen: true,
      instanceContext: {
        cwd: '/Users/foo',
        cwdName: '~',
        branch: null,
        isManagedChild: true,
        instanceId: 'inst_weixinbot',
        app: 'weixin',
      },
    })
    render(<SettingsDrawer />)
    expect(screen.queryByTestId('settings-weixin-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('open-weixin-bot')).not.toBeInTheDocument()
    // 常规设置列表照常渲染 —— 只摘掉微信入口,不是整个设置页空白
    expect(screen.getByText('显示')).toBeInTheDocument()
  })

  it('用户自定义子实例(instanceId 有值,app 为 null)不显示「微信机器人」入口', () => {
    useAppStore.setState({
      settingsDrawerOpen: true,
      instanceContext: {
        cwd: '/Users/foo/code',
        cwdName: 'code',
        branch: 'main',
        isManagedChild: true,
        instanceId: 'inst_567277e2',
        app: null,
      },
    })
    render(<SettingsDrawer />)
    expect(screen.queryByTestId('settings-weixin-section')).not.toBeInTheDocument()
  })

  it('instanceContext 未 hydrate 时按主实例处理(向后兼容裸 dev / 旧后端)', () => {
    useAppStore.setState({ settingsDrawerOpen: true, instanceContext: null })
    render(<SettingsDrawer />)
    expect(screen.getByTestId('settings-weixin-section')).toBeInTheDocument()
  })
})

describe('SettingsDrawer — 会话归档', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    useAppStore.setState({
      settingsDrawerOpen: false,
      archiveKeepCount: 20,
    })
  })

  it('schema 渲染「会话归档」section 与保留数 number 行', () => {
    // 不 stub 的话挂载期 GET(/api/agent/settings、/api/mcp/status 等)会打
    // 真实连接,teardown 时 happy-dom 把未完成请求 abort 后倾倒到 stderr。
    // /api/mcp/status 必须返回合法空状态:'{}' 会让 McpServersSection 在
    // status.commands.length 处崩溃。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/mcp/status'
          ? new Response(
              JSON.stringify({
                lazyConnect: false,
                connecting: false,
                servers: [],
                commands: [],
              }),
              { status: 200 },
            )
          : new Response('{}', { status: 200 }),
      ),
    )
    useAppStore.setState({ settingsDrawerOpen: true, archiveKeepCount: 35 })
    render(<SettingsDrawer />)
    // 断言用完整标题:section 名带刻意的「(立即生效)」后缀,
    // 子串正则会同时命中祖先容器导致 getByText 多匹配报错。
    expect(screen.getByText('会话归档 (立即生效)')).toBeInTheDocument()
    expect(screen.getByText('保留会话数')).toBeInTheDocument()
    expect(screen.getByText('35')).toBeInTheDocument()
  })

  it('渲染「立即归档」按钮,点击后 POST /api/agent/sessions/archive 并提示条数', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/agent/settings' && (!init || !init.method)) {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      if (url === '/api/agent/sessions/archive') {
        return new Response(
          JSON.stringify({ archived: ['a', 'b'], kept: 20, skipped: 0 }),
          { status: 200 },
        )
      }
      // GET /api/mcp/status(McpServersSection 挂载即拉)返回合法空状态;
      // 返回 '{}' 会让组件在 status.commands.length 处崩溃,返回 5xx 会弹
      // 全局 notification —— 两者都污染本用例。
      if (url === '/api/mcp/status') {
        return new Response(
          JSON.stringify({
            lazyConnect: false,
            connecting: false,
            servers: [],
            commands: [],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    useAppStore.setState({ settingsDrawerOpen: true, archiveKeepCount: 20 })
    render(<SettingsDrawer />)
    fireEvent.click(screen.getByTestId('settings-run-archive'))
    await screen.findByText(/已归档 2 个会话/)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/sessions/archive',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})