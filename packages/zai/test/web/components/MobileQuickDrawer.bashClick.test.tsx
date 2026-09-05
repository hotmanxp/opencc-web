// @vitest-environment happy-dom
/**
 * handleBashClick 关闭抽屉时机测试:
 *
 * 背景:MobileQuickDrawer 之前 finally 直接 onClose(),导致 message.success /
 * message.warning / message.error 在抽屉同一帧卸载时被 antd portal 销毁,
 * 用户在移动端根本看不到结果反馈。修复后改为 shouldClose state + useEffect:
 *   - 成功 → 立即 setShouldClose(true) (effect 同步触发 onClose,toast 已渲染)
 *   - busy → message.warning + 立即 setShouldClose(true)
 *   - 失败 (non-zero exit / signal / catch 抛错) →
 *       message.error 先调用,~100ms 后 setShouldClose(true),留出 toast
 *       渲染时间避免被 drawer 卸载吞掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.js'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'

// useBashRepl 真实实现会 EventSource + fetch,这里直接 mock 掉,只暴露我们
// 需要 stub 的 exec / refreshTopCommands。
vi.mock('../../../src/web/src/hooks/useBashRepl.js', () => ({
  useBashRepl: vi.fn(),
}))

// antd message.* 在 happy-dom 下没 AntApp context 会静默 no-op,但本测试只
// 需要确认调用顺序 + 副作用,不需要断言 toast DOM。spy 出来只用于 verify 调用。
// 注意 vi.mock 工厂被 hoist 到顶层,引用 module-scope 变量会 TDZ — 在工厂
// 内部直接 new vi.fn(),由外部测试代码通过 mock 对象拿到。
const messageSpy = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd')
  return {
    ...actual,
    message: messageSpy,
  }
})

import { useBashRepl } from '../../../src/web/src/hooks/useBashRepl.js'
import MobileQuickDrawer from '../../../src/web/src/components/MobileQuickDrawer.jsx'

const mockedUseBashRepl = vi.mocked(useBashRepl)

function setupUseBashReplMock(execResult: any) {
  mockedUseBashRepl.mockReturnValue({
    events: [],
    busy: false,
    currentExecId: null,
    connected: false,
    topCommands: [{ command: 'ls', count: 3 }],
    refreshTopCommands: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(execResult),
    abort: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
  } as never)
}

function setupStores() {
  useAgentStore.setState({
    sessionId: 'sid-1',
    activeSessionId: 'sid-1',
    status: 'idle',
    cwdBySession: { 'sid-1': '/tmp/proj' },
  } as never)
  useAppStore.setState({
    instanceContext: {
      cwd: '/tmp/proj',
      cwdName: 'proj',
      branch: null,
      isManagedChild: false,
      supervisorPid: null,
      instanceId: null,
    },
  } as never)
}

beforeEach(() => {
  vi.useFakeTimers()
  setupStores()
  // 每个 case 干净起见,清掉上一轮 mock 调用计数 + useBashRepl 返回值。
  messageSpy.success.mockClear()
  messageSpy.warning.mockClear()
  messageSpy.error.mockClear()
  mockedUseBashRepl.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  mockedUseBashRepl.mockReset()
})

describe('MobileQuickDrawer.handleBashClick drawer close timing', () => {
  it('case 1: exec returns ok:true → onClose called immediately on success', async () => {
    const onClose = vi.fn()
    setupUseBashReplMock({ ok: true, execId: 'e1', code: 0, signal: null })
    render(<MobileQuickDrawer open onClose={onClose} />)

    const row = document.querySelector(
      '[data-testid="mobile-quick-drawer-bash-row-ls"]',
    ) as HTMLElement
    expect(row).toBeTruthy()

    await act(async () => {
      fireEvent.click(row)
      // 让 exec promise + 后续 setState + effect 全部 flush
      await Promise.resolve()
      await Promise.resolve()
    })

    // message.success 应先调用,onClose 紧随其后 (effect 同步触发)
    expect(messageSpy.success).toHaveBeenCalledTimes(1)
    expect(messageSpy.warning).not.toHaveBeenCalled()
    expect(messageSpy.error).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('case 2: exec returns ok:false, busy:true → message.warning + immediate onClose', async () => {
    const onClose = vi.fn()
    setupUseBashReplMock({ ok: false, busy: true, currentExecId: 'e_old' })
    render(<MobileQuickDrawer open onClose={onClose} />)

    const row = document.querySelector(
      '[data-testid="mobile-quick-drawer-bash-row-ls"]',
    ) as HTMLElement
    expect(row).toBeTruthy()

    await act(async () => {
      fireEvent.click(row)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(messageSpy.warning).toHaveBeenCalledTimes(1)
    expect(messageSpy.warning).toHaveBeenCalledWith('已有命令在执行')
    expect(messageSpy.success).not.toHaveBeenCalled()
    expect(messageSpy.error).not.toHaveBeenCalled()
    // busy 分支不能漏关抽屉 — 这是修复的核心点之一
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('case 3: exec returns ok:false (non-zero exit) → message.error first, then onClose after ~100ms', async () => {
    const onClose = vi.fn()
    setupUseBashReplMock({ ok: true, execId: 'e2', code: 1, signal: null })
    render(<MobileQuickDrawer open onClose={onClose} />)

    const row = document.querySelector(
      '[data-testid="mobile-quick-drawer-bash-row-ls"]',
    ) as HTMLElement
    expect(row).toBeTruthy()

    await act(async () => {
      fireEvent.click(row)
      await Promise.resolve()
      await Promise.resolve()
    })

    // 错误 toast 必须先于 onClose 触发 — finally 同步 onClose 是被它吞掉的根因
    expect(messageSpy.error).toHaveBeenCalledTimes(1)
    expect(messageSpy.error.mock.calls[0][0]).toMatch(/执行失败 \(exit 1\)/)
    expect(onClose).not.toHaveBeenCalled()

    // 推进 fake timer 100ms,setShouldClose 应该把 onClose 拉起来
    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('case 3b: exec throws → message.error first, then onClose after ~100ms', async () => {
    const onClose = vi.fn()
    mockedUseBashRepl.mockReturnValue({
      events: [],
      busy: false,
      currentExecId: null,
      connected: false,
      topCommands: [{ command: 'ls', count: 3 }],
      refreshTopCommands: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockRejectedValue(new Error('network down')),
      abort: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
    } as never)
    render(<MobileQuickDrawer open onClose={onClose} />)

    const row = document.querySelector(
      '[data-testid="mobile-quick-drawer-bash-row-ls"]',
    ) as HTMLElement

    await act(async () => {
      fireEvent.click(row)
      // 让 await exec(...) 抛出的 promise 进入 microtask
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(messageSpy.error).toHaveBeenCalledTimes(1)
    expect(messageSpy.error.mock.calls[0][0]).toMatch(/执行失败.*network down/)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})