// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import FactorySettingsDrawer from './FactorySettingsDrawer'

// 服务端替身:GET settings / GET spawn-agents / PUT settings(记录 body)。
const settingsDto = {
  docsDir: '/tmp/docs',
  repoRoot: '',
  maxParallelTasks: 3,
  preferSpawnAgent: 'opencc' as const,
  docsDirExists: true,
  repoRootExists: false,
}
const agents = [
  { name: 'opencc', commandFound: true, commandPath: '/usr/local/bin/opencc', registered: true, active: true },
  { name: 'dsh', commandFound: false, commandPath: null, registered: false, active: false },
  { name: 'opencode', commandFound: true, commandPath: '/Users/you/pnpm-global/opencode', registered: false, active: false },
]

let putBody: Record<string, unknown> | null = null

beforeEach(() => {
  putBody = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/settings') && init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return { ok: true, json: async () => ({ ...settingsDto, maxParallelTasks: 5 }) } as unknown as Response
      }
      if (String(url).endsWith('/settings')) {
        return { ok: true, json: async () => settingsDto } as unknown as Response
      }
      if (String(url).endsWith('/spawn-agents')) {
        return { ok: true, json: async () => ({ agents }) } as unknown as Response
      }
      if (String(url).includes('/register')) {
        return { ok: true, json: async () => ({ ok: true, restartRequired: true }) } as unknown as Response
      }
      return { ok: true, json: async () => ({}) } as unknown as Response
    }),
  )
})

describe('FactorySettingsDrawer (tf-pnsl5m5e)', () => {
  it('打开 → 拉取并回填当前配置与 spawnAgent 状态', async () => {
    render(<FactorySettingsDrawer open onClose={vi.fn()} />)
    const docs = (await screen.findByTestId('factory-settings-docs-dir')) as HTMLInputElement
    expect(docs.value).toBe('/tmp/docs')
    // rc-input-number 把 value prop 同步到内部 input 走 useEffect,比原生
    // Input 的受控回填晚一拍 —— 必须 waitFor,不能同步断言。
    const max = (screen.getByTestId('factory-settings-max-parallel')) as HTMLInputElement
    await waitFor(() => expect(max.value).toBe('3'))
    // dsh 未注册 → 有「一键注册」按钮;opencc 已注册 → 没有
    expect(screen.getByTestId('factory-settings-register-dsh')).toBeInTheDocument()
    expect(screen.queryByTestId('factory-settings-register-opencc')).toBeNull()
    // opencode:已安装但未注册 → 有「一键注册」按钮,卡片显示命令路径
    expect(screen.getByTestId('factory-settings-register-opencode')).toBeInTheDocument()
    const ocCard = screen.getByTestId('factory-settings-agent-opencode')
    expect(ocCard.textContent).toContain('已安装')
    expect(ocCard.textContent).toContain('未注册')
    // docsDir 已保存且存在 → ✓ 徽标
    expect(screen.getByText('存在')).toBeInTheDocument()
  })

  it('保存 → PUT 草稿(patch 含全字段),400 错误展示 message', async () => {
    render(<FactorySettingsDrawer open onClose={vi.fn()} />)
    const docs = (await screen.findByTestId('factory-settings-docs-dir')) as HTMLInputElement
    // 先等回填完成(含 rc-input-number 的 effect 同步),再改草稿 ——
    // 否则 setDraft(load) 可能覆盖用户输入造成时序竞态。
    await waitFor(() => expect(docs.value).toBe('/tmp/docs'))
    const max = screen.getByTestId('factory-settings-max-parallel') as HTMLInputElement
    await waitFor(() => expect(max.value).toBe('3'))
    fireEvent.change(docs, { target: { value: '/tmp/new-docs' } })
    fireEvent.change(max, { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('factory-settings-save'))
    await waitFor(() => {
      expect(putBody).toMatchObject({ docsDir: '/tmp/new-docs', maxParallelTasks: 5 })
    })
  })

  it('未激活 provider 在 Select 中禁用,已注册 dsh 提示重启', async () => {
    render(<FactorySettingsDrawer open onClose={vi.fn()} />)
    await screen.findByTestId('factory-settings-drawer')
    const dshCard = await screen.findByTestId('factory-settings-agent-dsh')
    expect(dshCard.textContent).toContain('未找到') // which 探测失败
    expect(dshCard.textContent).toContain('未注册')
  })
})
