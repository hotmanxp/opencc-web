// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalEnvironment, WebTerminalInfo } from '../../../shared/terminal.js'
import { useTerminalTabs } from './useTerminalTabs.js'

const ENVIRONMENT: TerminalEnvironment = {
  cwd: '/foo',
  available: true,
  maxCols: 500,
  maxRows: 200,
  maxInputBytes: 64 * 1024,
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

interface FetchPlan {
  environment?: TerminalEnvironment
  shells?: { path: string; name: string; args: string[] }[]
  terminals?: WebTerminalInfo[]
  createResult?: WebTerminalInfo
  createStatus?: number
  listStatus?: number
  createHint?: string
}

function installFetch(plan: FetchPlan) {
  const calls: { url: string; body: unknown }[] = []
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, body })
    const json = (payload: unknown, status = 200): Response =>
      ({
        ok: status < 400,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }) as unknown as Response
    if (url.startsWith('/api/terminal/environment')) {
      return json(plan.environment ?? ENVIRONMENT)
    }
    if (url.startsWith('/api/terminal/shells')) {
      return json({ shells: plan.shells ?? [info('x').shell] })
    }
    if (url.startsWith('/api/terminal/list')) {
      if (plan.listStatus && plan.listStatus >= 400) {
        return json({ error: 'list failed' }, plan.listStatus)
      }
      return json({ terminals: plan.terminals ?? [] })
    }
    if (url.startsWith('/api/terminal/create')) {
      if (plan.createStatus && plan.createStatus >= 400) {
        return json({ error: 'create failed', hint: plan.createHint }, plan.createStatus)
      }
      return json(plan.createResult ?? info('t-new'))
    }
    return json({ ok: true })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = mock
  return { mock, calls }
}

describe('useTerminalTabs', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('加载环境 / shell 列表 / 已有终端；列表非空时不自动新建', async () => {
    const existing = info('t-1')
    const { calls } = installFetch({ terminals: [existing] })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.terminals.map((t) => t.id)).toEqual(['t-1'])
    expect(result.current.activeId).toBe('t-1')
    expect(result.current.environment?.maxCols).toBe(500)
    expect(calls.some((c) => c.url.startsWith('/api/terminal/create'))).toBe(false)
  })

  it('列表为空时自动新建一个默认 shell 并选中', async () => {
    const created = info('t-auto')
    const { calls } = installFetch({ terminals: [], createResult: created })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))

    await waitFor(() => expect(result.current.terminals.map((t) => t.id)).toEqual(['t-auto']))
    const create = calls.find((c) => c.url.startsWith('/api/terminal/create'))
    expect(create).toBeDefined()
    expect((create?.body as { id: string }).id).toMatch(/^t-[\w-]+$/)
    expect((create?.body as { cwd?: string }).cwd).toBe('/foo')
    expect(result.current.activeId).toBe('t-auto')
  })

  it('node-pty 不可用时不自动新建', async () => {
    const { calls } = installFetch({
      environment: { ...ENVIRONMENT, available: false, unavailableReason: 'boom', hint: 'pnpm install' },
      terminals: [],
    })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.environment?.available).toBe(false)
    expect(calls.some((c) => c.url.startsWith('/api/terminal/create'))).toBe(false)
  })

  it('sessionId 为 null 时不发请求', async () => {
    const { mock } = installFetch({})
    const { result } = renderHook(() => useTerminalTabs(null, '/foo'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(mock).not.toHaveBeenCalled()
    expect(result.current.terminals).toEqual([])
    expect(result.current.ready).toBe(false)
  })

  it('create 追加 tab 并切换到新 tab', async () => {
    const { calls } = installFetch({ terminals: [info('t-1')], createResult: info('t-2') })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    await act(async () => {
      await result.current.create('/bin/bash')
    })
    expect(result.current.terminals.map((t) => t.id)).toEqual(['t-1', 't-2'])
    expect(result.current.activeId).toBe('t-2')
    const create = calls.filter((c) => c.url.startsWith('/api/terminal/create')).at(-1)
    expect((create?.body as { shellPath?: string }).shellPath).toBe('/bin/bash')
  })

  it('create 失败时记录错误与修复提示', async () => {
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    installFetch({ terminals: [info('t-1')], createStatus: 503, createHint: 'pnpm install' })
    await waitFor(() => expect(result.current.ready).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.error).toContain('503')
    expect(result.current.errorHint).toBe('pnpm install')
  })

  it('close 移除 tab，当前 tab 被关后落到剩下第一个', async () => {
    const { calls } = installFetch({ terminals: [info('t-1'), info('t-2')] })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.setActive('t-2'))
    expect(result.current.activeId).toBe('t-2')

    await act(async () => {
      await result.current.close('t-2')
    })
    expect(result.current.terminals.map((t) => t.id)).toEqual(['t-1'])
    expect(result.current.activeId).toBe('t-1')
    expect(calls.some((c) => c.url.includes('/terminal/t-2/close?sessionId=sess-1'))).toBe(true)
  })

  it('rename 乐观更新标题；失败回滚', async () => {
    const { mock } = installFetch({ terminals: [info('t-1', { title: 'zsh' })] })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    await act(async () => {
      await result.current.rename('t-1', '构建日志')
    })
    expect(result.current.terminals[0].title).toBe('构建日志')

    mock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/terminal/environment')) {
        return { ok: true, status: 200, json: async () => ENVIRONMENT } as unknown as Response
      }
      if (url.startsWith('/api/terminal/shells')) {
        return { ok: true, status: 200, json: async () => ({ shells: [] }) } as unknown as Response
      }
      if (url.startsWith('/api/terminal/list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ terminals: [info('t-1', { title: '构建日志' })] }),
        } as unknown as Response
      }
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'rename failed' }),
        text: async () => 'rename failed',
      } as unknown as Response
    })
    await act(async () => {
      await result.current.rename('t-1', '新名字')
    })
    expect(result.current.error).toContain('rename failed')
    expect(result.current.terminals[0].title).toBe('构建日志')
  })

  it('applyInfo 回填尺寸 / 状态 / 标题', async () => {
    installFetch({ terminals: [info('t-1')] })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    await waitFor(() => expect(result.current.ready).toBe(true))

    act(() => result.current.applyInfo(info('t-1', { cols: 120, state: 'exited', exitCode: 1 })))
    expect(result.current.terminals[0]).toMatchObject({ cols: 120, state: 'exited', exitCode: 1 })
  })

  it('加载失败时记录错误，retry 重新拉取', async () => {
    const { calls } = installFetch({ listStatus: 500 })
    const { result } = renderHook(() => useTerminalTabs('sess-1', '/foo'))
    await waitFor(() => expect(result.current.error).toContain('list failed'))

    installFetch({ terminals: [info('t-1')] })
    await act(async () => {
      result.current.retry()
    })
    await waitFor(() => expect(result.current.terminals.map((t) => t.id)).toEqual(['t-1']))
    expect(result.current.error).toBeNull()
    expect(calls.length).toBeGreaterThan(0)
  })
})