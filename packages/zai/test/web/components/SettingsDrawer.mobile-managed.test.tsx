// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'
import SettingsDrawer from '../../../src/web/src/components/SettingsDrawer.js'

/**
 * 验证 SettingsDrawer service section 在不同 managed 形态下的渲染行为:
 *
 *   1) 顶层受管子服务(supervisor 直接派生的 child,无 ZAI_INSTANCE_ID):
 *      → **不**渲染「重启/关闭服务」按钮。顶层是 supervisor 的管理入口,
 *      重启/关闭它会影响整个实例群,单实例控制不该暴露在这里。
 *
 *   2) instance-managed child(instance manager 派生的子实例,带 ZAI_INSTANCE_ID):
 *      → 渲染 service section。重启走 /api/system/restart → IPC 'restart'
 *      发给 instanceSupervisor,instanceSupervisor 收到后 stop+start 重新拉起;
 *      关闭走 /api/system/stop → cleanupAndExit。两条按钮只影响当前子实例。
 *
 *   3) 独立 zai-server(isManagedChild=false):不渲染按钮(无 supervisor 可委托)。
 */

afterEach(() => {
  cleanup()
  useAppStore.setState({
    settingsDrawerOpen: false,
    serviceState: null,
    instanceContext: null,
  })
})

describe('SettingsDrawer service section visibility', () => {
  it('hides section on top-level managed child (supervisor entry, not an instance child)', () => {
    // 顶层 supervisor 派生 child:isManagedChild=true, instanceId=null。
    // 它是 supervisor 的管理入口,重启/关闭会影响整个实例群,不暴露按钮。
    useAppStore.setState({
      settingsDrawerOpen: true,
      serviceState: null,
      instanceContext: {
        cwd: '/Users/me/proj',
        cwdName: 'proj',
        branch: 'main',
        host: '0.0.0.0',
        port: 9201,
        ips: ['192.168.1.5'],
        isManagedChild: true,
        supervisorPid: 9999,
        instanceId: null,
      },
    })
    const { queryByTestId, queryByRole } = render(<SettingsDrawer />)
    expect(queryByTestId('settings-service-section')).toBeNull()
    expect(queryByRole('button', { name: /重启服务/ })).toBeNull()
    expect(queryByRole('button', { name: /关闭服务/ })).toBeNull()
  })

  it('hides section on managed child without instanceId (defensive)', () => {
    // isManagedChild=true 但 instanceId 缺失(老 server / 兼容性)。
    // 没有 ZAI_INSTANCE_ID 就不是 instance child,不渲染按钮。
    useAppStore.setState({
      settingsDrawerOpen: true,
      serviceState: null,
      instanceContext: {
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: null,
        isManagedChild: true,
      },
    })
    const { queryByTestId } = render(<SettingsDrawer />)
    expect(queryByTestId('settings-service-section')).toBeNull()
  })

  it('hides section when isManagedChild is explicitly false (mobile + standalone)', () => {
    // 移动端访问独立 zai-server:`isManagedChild` 明确 false,不显示按钮。
    useAppStore.setState({
      settingsDrawerOpen: true,
      serviceState: null,
      instanceContext: {
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: null,
        isManagedChild: false,
        supervisorPid: null,
        instanceId: null,
      },
    })
    const { queryByTestId } = render(<SettingsDrawer />)
    expect(queryByTestId('settings-service-section')).toBeNull()
  })

  it('shows both restart and shutdown buttons on instance-managed child (SWARM 子实例)', () => {
    // instance manager 派生的子实例:ZAI_INSTANCE_ID 已设。
    // 「重启」走 /api/system/restart → IPC 'restart' → instanceSupervisor
    // stop+start 重新拉起;「关闭」走 /api/system/stop → cleanupAndExit。
    useAppStore.setState({
      settingsDrawerOpen: true,
      serviceState: null,
      instanceContext: {
        cwd: '/Users/me/inst',
        cwdName: 'inst',
        branch: 'main',
        host: '127.0.0.1',
        port: 9202,
        ips: [],
        isManagedChild: true,
        supervisorPid: 9999,
        instanceId: 'inst_abc',
      },
    })
    const { getByTestId, getByRole } = render(<SettingsDrawer />)
    expect(getByTestId('settings-service-section')).toBeTruthy()
    expect(getByRole('button', { name: /重启服务/ })).toBeTruthy()
    expect(getByRole('button', { name: /关闭服务/ })).toBeTruthy()
  })
})
