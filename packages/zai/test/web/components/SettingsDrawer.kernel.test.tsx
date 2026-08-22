// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'
import SettingsDrawer from '../../../src/web/src/components/SettingsDrawer.js'

afterEach(() => {
  cleanup()
  useAppStore.setState({ settingsDrawerOpen: false, serviceState: null })
  vi.restoreAllMocks()
})

/**
 * Regression test for the "kernel 切换点了没反应" bug.
 *
 * Symptom:
 *   - 用户从 opencc 切到 dsh:成功 (handleChange closure 拿到的 stale kernel='opencc',
 *     `next === kernel` 是 'dsh' === 'opencc' → false,继续 POST)。
 *   - 用户从 dsh 切回 opencc:失败 (closure 仍是 stale kernel='opencc',
 *     `next === kernel` 是 'opencc' === 'opencc' → true → 提前 return,不发 POST)。
 *
 * Root cause: handleChange 的 useCallback 依赖数组里漏了 `kernel`,闭包永远拿着
 * 初始值,后续 setKernel(...) 不会重建回调。
 *
 * 验证方式:mock fetch 让 /api/agent/kernel POST 返回不同 futureSessionKernel,
 * 然后开/关两次 enum overlay 模拟两次连续切换,断言第二次切换仍发了 POST。
 */
describe('SettingsDrawer Agent 内核切换 (regression: stale closure)', () => {
  let kernelCalls: Array<{ kernel: string }>

  beforeEach(() => {
    kernelCalls = []
    useAppStore.setState({ settingsDrawerOpen: true, serviceState: null })

    // 安装 fetch mock:
    //   - GET /api/agent/settings  → 空 mainAgents + mainAgent=default
    //   - GET /api/agent/kernel    → kernel=opencc(初始)
    //   - POST /api/agent/kernel   → 200 + futureSessionKernel
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      const method = String(init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && u.endsWith('/api/agent/kernel')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { kernel: string }
        kernelCalls.push({ kernel: body.kernel })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            applied: body.kernel,
            previousKernel: body.kernel === 'dsh' ? 'opencc' : 'dsh',
            currentSessionKernel: body.kernel === 'dsh' ? 'opencc' : 'dsh',
            futureSessionKernel: body.kernel,
            inFlightCount: 0,
          }),
        } as Response
      }
      if (u.endsWith('/api/agent/kernel')) {
        return { ok: true, status: 200, json: async () => ({ kernel: 'opencc' }) } as Response
      }
      if (u.endsWith('/api/agent/settings')) {
        return { ok: true, status: 200, json: async () => ({ mainAgents: [], mainAgent: 'default' }) } as Response
      }
      return origFetch(url as never, init)
    }) as never
  })

  const getKernelRow = (): HTMLElement | null =>
    document.querySelector('[data-row-key="kernel"]') as HTMLElement | null

  const getOverlay = (): HTMLElement | null =>
    document.querySelector('[data-testid="settings-enum-overlay"]') as HTMLElement | null

  it('连续切换 dsh → opencc 两次都会触发 POST', async () => {
    render(<SettingsDrawer />)

    // 等 GET /api/agent/kernel 返回 + schema 内 kernel 行渲染出来
    await waitFor(() => {
      expect(getKernelRow()).toBeTruthy()
    })

    // 1) 第一次切换 opencc → dsh
    fireEvent.click(getKernelRow() as HTMLElement)
    await waitFor(() => {
      expect(getOverlay()).toBeTruthy()
    })
    const dshOption = getOverlay()?.querySelector('[data-overlay-option-value="dsh"]') as HTMLElement
    expect(dshOption).toBeTruthy()
    fireEvent.click(dshOption)
    await waitFor(() => {
      expect(kernelCalls.find((c) => c.kernel === 'dsh')).toBeTruthy()
    })

    // 等 schema 行被 setSchema effect 同步回新值(dsp 模式渲染回 opencc 选项)
    await waitFor(() => {
      const row = getKernelRow()
      expect(row).toBeTruthy()
      expect(row?.textContent).toContain('dsh')
    })

    // 2) 第二次切换 dsh → opencc(stale closure bug 在这里表现:
    //    closure 里 kernel 还是 'opencc',提前 return,不发 POST)
    fireEvent.click(getKernelRow() as HTMLElement)
    await waitFor(() => {
      expect(getOverlay()).toBeTruthy()
    })
    const openccOption = getOverlay()?.querySelector('[data-overlay-option-value="opencc"]') as HTMLElement
    expect(openccOption).toBeTruthy()
    fireEvent.click(openccOption)

    // 关键断言:第二次切换必须发出 POST,而不是被 stale closure 提前吞掉
    await waitFor(() => {
      expect(kernelCalls.find((c) => c.kernel === 'opencc')).toBeTruthy()
    })
    expect(kernelCalls.map((c) => c.kernel)).toEqual(['dsh', 'opencc'])
  })
})