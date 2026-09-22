// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalEnvironment, WebTerminalInfo } from '../../../../shared/terminal.js'

/**
 * BashTab 是「多终端 tab 宿主」：这里只验 strip 的交互与状态分支，
 * xterm 与 SSE 的接线由 TerminalView.test.tsx 覆盖（因此整块 mock 掉）。
 */
vi.mock('./TerminalView.js', () => ({
  TerminalView: ({ info, visible }: { info: WebTerminalInfo; visible: boolean }) => (
    <div data-testid={`terminal-view-${info.id}`} data-visible={String(visible)} />
  ),
}))

import { BashTab } from './BashTab.js'

const ENVIRONMENT: TerminalEnvironment = {
  cwd: '/foo',
  available: true,
  maxCols: 500,
  maxRows: 200,
  maxInputBytes: 65536,
  maxTerminals: 8,
  scrollback: 1000,
}

function info(id: string, overrides: Partial<WebTerminalInfo> = {}): WebTerminalInfo {
  return {
    id,
    title: 'zsh',
    shell: { path: '/bin/zsh', name: 'zsh', args: ['-i'] },
    cwd: '/foo',
    cols: 100,
    rows: 30,
    state: 'running',
    exitCode: null,
    ...overrides,
  }
}

interface Plan {
  environment?: TerminalEnvironment
  shells?: { path: string; name: string; args: string[] }[]
  terminals?: WebTerminalInfo[]
  /** /create 的响应；默认按请求里的 id 造一个 running 终端。 */
  createResult?: WebTerminalInfo
  listStatus?: number
}

function installFetch(plan: Plan = {}) {
  const calls: { url: string; body: unknown }[] = []
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as { id?: string }) : undefined
    calls.push({ url, body })
    const json = (payload: unknown, status = 200): Response =>
      ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }) as unknown as Response
    if (url.startsWith('/api/terminal/environment')) return json(plan.environment ?? ENVIRONMENT)
    if (url.startsWith('/api/terminal/shells')) {
      return json({ shells: plan.shells ?? [info('x').shell] })
    }
    if (url.startsWith('/api/terminal/list')) {
      if (plan.listStatus && plan.listStatus >= 400) return json({ error: 'list boom' }, plan.listStatus)
      return json({ terminals: plan.terminals ?? [] })
    }
    if (url.startsWith('/api/terminal/create')) {
      return json(plan.createResult ?? info(body?.id ?? 't-created'))
    }
    return json({ ok: true })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = mock
  return { mock, calls }
}

describe('BashTab', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('表头显示 cwd', async () => {
    installFetch({ terminals: [info('t-1')] })
    render(<BashTab sessionId="sess-1" cwd="/foo/bar" />)
    await waitFor(() => expect(screen.getByTestId('bash-cwd').textContent).toBe('/foo/bar'))
  })

  it('无会话时给出提示，不打接口', async () => {
    const { mock } = installFetch()
    render(<BashTab sessionId={null} cwd={null} />)
    expect(screen.getByText(/先选择一个会话/)).toBeDefined()
    expect(mock).not.toHaveBeenCalled()
  })

  it('列表为空时自动建一个终端并渲染 chip；只有可见 tab 挂载视图', async () => {
    const { calls } = installFetch({})
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
    const create = calls.find((c) => c.url.startsWith('/api/terminal/create'))
    expect(create).toBeDefined()
    expect((create?.body as { cols: number }).cols).toBeGreaterThan(1)
  })

  it('每个终端一个 chip，标题来自 info.title', async () => {
    installFetch({ terminals: [info('t-1'), info('t-2', { title: 'build' })] })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    expect(screen.getByTestId('terminal-chip-t-1').textContent).toContain('zsh')
    expect(screen.getByTestId('terminal-chip-t-2').textContent).toContain('build')
    // 默认选中第一个
    expect(screen.getByTestId('terminal-chip-t-1').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('terminal-view-t-1').dataset.visible).toBe('true')
    expect(screen.getByTestId('terminal-view-t-2').dataset.visible).toBe('false')
  })

  it('点 chip 切换当前终端', async () => {
    installFetch({ terminals: [info('t-1'), info('t-2')] })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    await act(async () => {
      fireEvent.click(screen.getByTestId('terminal-chip-t-2'))
    })
    expect(screen.getByTestId('terminal-chip-t-2').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('terminal-view-t-2').dataset.visible).toBe('true')
  })

  it('+ 新建终端（单 shell 时直接建）', async () => {
    const { calls } = installFetch({ terminals: [info('t-1')] })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))
    await act(async () => {
      fireEvent.click(screen.getByTestId('terminal-new'))
    })
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    const create = calls.filter((c) => c.url.startsWith('/api/terminal/create')).at(-1)
    expect((create?.body as { shellPath?: string }).shellPath).toBeUndefined()
  })

  it('关闭 chip 会调用 /close 并移除该 tab', async () => {
    const { calls } = installFetch({ terminals: [info('t-1'), info('t-2')] })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    await act(async () => {
      fireEvent.click(screen.getByTestId('terminal-chip-close-t-2'))
    })
    await waitFor(() => expect(screen.queryByTestId('terminal-chip-t-2')).toBeNull())
    expect(calls.some((c) => c.url.includes('/terminal/t-2/close?sessionId=sess-1'))).toBe(true)
  })

  it('双击 chip 改名 → POST /rename', async () => {
    const { calls } = installFetch({ terminals: [info('t-1')] })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1))

    await act(async () => {
      fireEvent.doubleClick(screen.getByTestId('terminal-chip-t-1'))
    })
    const input = screen.getByTestId('terminal-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: '构建日志' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })
    await waitFor(() => {
      const rename = calls.find((c) => c.url.includes('/terminal/t-1/rename'))
      expect(rename).toBeDefined()
      expect((rename?.body as { title: string }).title).toBe('构建日志')
    })
  })

  it('表头状态区分 running / exited', async () => {
    installFetch({ terminals: [info('t-1', { state: 'exited', exitCode: 1 })] })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getByTestId('terminal-status').textContent).toContain('exited'))
    expect(screen.getByTestId('terminal-status').textContent).toContain('1')
  })

  it('node-pty 不可用时提示原因与安装建议，且不新建', async () => {
    const { calls } = installFetch({
      environment: { ...ENVIRONMENT, available: false, unavailableReason: 'node-pty 未能加载', hint: 'pnpm install' },
    })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getByTestId('terminal-unavailable')).toBeDefined())
    expect(screen.getByText(/node-pty 未能加载/)).toBeDefined()
    expect(screen.getByText('pnpm install')).toBeDefined()
    expect(calls.some((c) => c.url.startsWith('/api/terminal/create'))).toBe(false)
  })

  it('加载失败显示错误与重试；重试成功后渲染终端', async () => {
    installFetch({ listStatus: 500 })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await waitFor(() => expect(screen.getByTestId('terminal-error')).toBeDefined())
    expect(screen.getByText(/list boom/)).toBeDefined()

    installFetch({ terminals: [info('t-9')] })
    await act(async () => {
      fireEvent.click(screen.getByTestId('terminal-retry'))
    })
    await waitFor(() => expect(screen.getByTestId('terminal-chip-t-9')).toBeDefined())
  })
})