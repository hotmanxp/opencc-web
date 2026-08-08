// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'

// 把整个 /api/system 响应拿掉,测试完全 mock 它。
vi.mock('../../../src/web/src/lib/api.js', () => ({
  api: {
    get: vi.fn(),
  },
}))

import { api } from '../../../src/web/src/lib/api.js'
import MobileLayout from '../../../src/web/src/components/MobileLayout.jsx'

const mockedApiGet = vi.mocked(api.get)

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState({ instanceContext: null })
})

describe('MobileLayout hydrate isManagedChild', () => {
  beforeEach(() => {
    // 每次测试前清掉 store,模拟冷启动
    useAppStore.setState({ instanceContext: null })
  })

  it('hydrates isManagedChild + supervisorPid + instanceId from /api/system', async () => {
    // 与桌面端 Layout.tsx 完全一致的 /system 响应结构。MobileLayout 之前漏
    // 掉这三个字段 → SettingsDrawer 的 isManagedChild 永远 false → 「重启/关闭
    // 服务」section 在 /m 路由下整体不渲染。本测试断言 fix 后这三个字段能
    // 正确灌进 store。
    mockedApiGet.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        cwd: '/Users/me/proj',
        cwdName: 'proj',
        branch: 'main',
        host: '0.0.0.0',
        port: 9201,
        ips: ['192.168.1.5'],
        isManagedChild: true,
        supervisorPid: 9999,
        instanceId: 'inst_abc',
      }) as never,
    )

    render(<MobileLayout />)

    await waitFor(() => {
      const ctx = useAppStore.getState().instanceContext
      expect(ctx).not.toBeNull()
      expect(ctx?.isManagedChild).toBe(true)
      expect(ctx?.supervisorPid).toBe(9999)
      expect(ctx?.instanceId).toBe('inst_abc')
      expect(ctx?.host).toBe('0.0.0.0')
      expect(ctx?.port).toBe(9201)
    })
  })

  it('isManagedChild=false on top-level (non-managed) zai-server', async () => {
    mockedApiGet.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: null,
        host: '127.0.0.1',
        port: 9201,
        ips: [],
        isManagedChild: false,
        supervisorPid: null,
        instanceId: null,
      }) as never,
    )

    render(<MobileLayout />)

    await waitFor(() => {
      const ctx = useAppStore.getState().instanceContext
      expect(ctx).not.toBeNull()
      expect(ctx?.isManagedChild).toBe(false)
      expect(ctx?.supervisorPid).toBeNull()
      expect(ctx?.instanceId).toBeNull()
    })
  })

  it('coerces missing supervisor fields to null/false', async () => {
    // 旧版 server / 兼容性场景:server 没把 supervisorPid 字段返回。
    // MobileLayout 不能崩,要把缺失字段降级为 null/false。
    mockedApiGet.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: null,
        host: '127.0.0.1',
        port: 0,
        ips: [],
        // isManagedChild 缺失
        // supervisorPid 缺失
        // instanceId 缺失
      }) as never,
    )

    render(<MobileLayout />)

    await waitFor(() => {
      const ctx = useAppStore.getState().instanceContext
      expect(ctx).not.toBeNull()
      expect(ctx?.isManagedChild).toBe(false)
      expect(ctx?.supervisorPid).toBeNull()
      expect(ctx?.instanceId).toBeNull()
    })
  })

  it('does not change instanceContext if /api/system fetch fails', async () => {
    mockedApiGet.mockImplementation(() =>
      Promise.reject(new Error('boom')) as never,
    )
    useAppStore.setState({ instanceContext: null })
    render(<MobileLayout />)
    // 给 fetch 一拍时间
    await new Promise((r) => setTimeout(r, 10))
    expect(useAppStore.getState().instanceContext).toBeNull()
  })
})