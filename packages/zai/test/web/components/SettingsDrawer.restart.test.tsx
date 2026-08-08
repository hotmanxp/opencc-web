// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'
import SettingsDrawer from '../../../src/web/src/components/SettingsDrawer.js'

afterEach(() => {
  cleanup()
  // 重置 store 状态,避免污染后续测试
  useAppStore.setState({ settingsDrawerOpen: false, serviceState: null })
  vi.restoreAllMocks()
})

describe('SettingsDrawer service section', () => {
  // isManagedChild=true 后,整个"服务"section 仅在受管子服务时渲染。
  // SettingsDrawer 的 useAppStore 读 instanceContext.isManagedChild,
  // 这里通过 setState 把它打开,模拟 Layout hydrate 之后的状态。
  const setManagedChild = (isManagedChild: boolean) => {
    useAppStore.setState({
      settingsDrawerOpen: true,
      serviceState: null,
      instanceContext: {
        cwd: '/tmp/x',
        cwdName: 'x',
        branch: null,
        isManagedChild,
      } as never,
    })
  }

  it('does not render when drawer closed', () => {
    useAppStore.setState({ settingsDrawerOpen: false })
    const { queryByTestId } = render(<SettingsDrawer />)
    expect(queryByTestId('settings-service-section')).toBeNull()
  })

  it('renders section with restart button when drawer open and isManagedChild', () => {
    useAppStore.setState({ settingsDrawerOpen: true, serviceState: null })
    setManagedChild(true)
    const { getByTestId, getByRole } = render(<SettingsDrawer />)
    expect(getByTestId('settings-service-section')).toBeTruthy()
    expect(getByRole('button', { name: /重启服务/ })).toBeTruthy()
  })

  it('does not render section when isManagedChild=false', () => {
    useAppStore.setState({ settingsDrawerOpen: true, serviceState: null })
    setManagedChild(false)
    const { queryByTestId } = render(<SettingsDrawer />)
    expect(queryByTestId('settings-service-section')).toBeNull()
  })

  it('shows confirmation modal before calling API', async () => {
    setManagedChild(true)
    const origFetch = globalThis.fetch
    let called = 0
    globalThis.fetch = vi.fn(() => {
      called++
      return Promise.resolve({ ok: true, status: 202, json: async () => ({}) } as Response)
    })
    try {
      const { getByRole, findByText } = render(<SettingsDrawer />)
      fireEvent.click(getByRole('button', { name: /重启服务/ }))
      // Modal 弹出后,内容里 "将会中断" 应当可见
      const contentNode = await findByText(/将会中断/)
      expect(contentNode).toBeTruthy()
      // 拿到 cancelBtn 立刻点击 — AntD Modal.confirm 在 happy-dom 下会在
      // 多 await tick 之间自动卸载,所以必须在 findByText 解决后立即同步取,
      // 不能再次 await findByText('取消')。
      const cancelBtn = (contentNode.ownerDocument ?? document).querySelector(
        '.ant-modal-content',
      )
      expect(cancelBtn).toBeTruthy()
      const cancelText = cancelBtn?.querySelector('.ant-btn:not(.ant-btn-primary)')
      expect(cancelText).toBeTruthy()
      fireEvent.click(cancelText as HTMLElement)
      await waitFor(() => {
        expect(called).toBe(0)
      })
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
