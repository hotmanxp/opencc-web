// @vitest-environment happy-dom
// UpdateNotifier — zai 自升级弹窗。回归覆盖 HRMSV3-ZN-WEBSITE#668:
// installing(正在后台升级)→ complete(升级完成)顺序下,升级完成的 Modal
// 必须弹出 — 之前用组件内 ref 记录 installing 的 currentKey,complete 时
// 同 key 被短路,Modal 永不出现。
import { beforeEach, describe, expect, test } from 'vitest'
import '@testing-library/jest-dom'
import { act, render } from '@testing-library/react'
import { useAppStore } from '../store/useAppStore.js'
import { UpdateNotifier } from './UpdateNotifier.jsx'

// vi.mock 工厂被 hoist 到顶部,antd 命名导出 spy 不生效(ESM live binding),
// 用 vi.hoisted 声明 mock fn 再在工厂里替换 named export — 与 BranchSelector/
// MobileQuickDrawer 测试同一模式。
const mocks = vi.hoisted(() => ({
  modalInfo: vi.fn(),
  modalError: vi.fn(),
  notifInfo: vi.fn(),
  notifDestroy: vi.fn(),
}))

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>()
  return {
    ...actual,
    Modal: {
      ...actual.Modal,
      info: mocks.modalInfo,
      error: mocks.modalError,
    },
    notification: {
      ...actual.notification,
      info: mocks.notifInfo,
      destroy: mocks.notifDestroy,
    },
  }
})

// 走真实 store reducer(applyAppUpdate),跟 SSE → useEventStream → store
// 的生产数据流一致。
const checkEvent = { type: 'app.update.checking' } as const
const installEvent = (from: string, to: string) =>
  ({ type: 'app.update.installing', from, to }) as const
const completeEvent = (from: string, to: string) =>
  ({ type: 'app.update.complete', from, to }) as const

const emit = (event: any) =>
  act(() => {
    useAppStore.getState().applyAppUpdate(event)
  })

let lastModalInfoOpts: any

describe('UpdateNotifier — zai 自升级弹窗', () => {
  beforeEach(() => {
    useAppStore.setState({
      appUpdate: { status: 'idle', dismissedKey: undefined },
    })
    mocks.modalInfo.mockReset()
    mocks.modalError.mockReset()
    mocks.notifInfo.mockReset()
    mocks.notifDestroy.mockReset()
    mocks.modalInfo.mockImplementation((opts: any) => {
      lastModalInfoOpts = opts
      return { destroy: () => {} } as any
    })
  })

  afterEach(() => {
    lastModalInfoOpts = undefined
  })

  test('installing 状态下发顶部进度通知', () => {
    render(<UpdateNotifier />)
    emit(installEvent('0.3.16', '0.3.17'))
    expect(mocks.notifInfo).toHaveBeenCalledTimes(1)
    const opts = mocks.notifInfo.mock.calls[0][0]
    expect(opts.message).toBe('正在后台升级 zai…')
    expect(opts.description).toContain('0.3.16 → 0.3.17')
  })

  test('回归: installing 之后 complete 必须弹「已升级」Modal,不被 installing 去重掉', () => {
    render(<UpdateNotifier />)
    emit(installEvent('0.31.0', '0.31.1'))
    expect(mocks.notifInfo).toHaveBeenCalledTimes(1)

    emit(completeEvent('0.31.0', '0.31.1'))
    expect(mocks.modalInfo).toHaveBeenCalledTimes(1)
    expect(lastModalInfoOpts.title).toBe('zai 已升级')
    // 顶部进度通知在 complete 后销毁
    expect(mocks.notifDestroy).toHaveBeenCalledWith('app-update-progress')
  })

  test('dismiss 后同一 key 的 complete 重放(SSE 重连 replay)不再弹第二次', () => {
    render(<UpdateNotifier />)
    emit(completeEvent('0.32.0', '0.32.1'))
    expect(mocks.modalInfo).toHaveBeenCalledTimes(1)

    // 点「知道了」→ key 记入 dismissedKey,status 回 idle
    act(() => lastModalInfoOpts.onOk())
    expect(useAppStore.getState().appUpdate.status).toBe('idle')

    // 同 key complete 重放: reducer 会清掉 dismissedKey,但 shownFinalModals
    // Set 仍在(没有经历新一轮 checking)→ 不弹第二次
    emit(completeEvent('0.32.0', '0.32.1'))
    expect(mocks.modalInfo).toHaveBeenCalledTimes(1)
  })

  test('新一轮升级(checking 前导)后,相同 from/to 的 complete 允许重新弹出', () => {
    render(<UpdateNotifier />)
    emit(completeEvent('0.35.0', '0.35.1'))
    expect(mocks.modalInfo).toHaveBeenCalledTimes(1)
    act(() => lastModalInfoOpts.onOk())

    // 用户回滚到 0.35.0 后再升级: fresh checking 清空 Set → complete 可弹
    emit(checkEvent)
    emit(installEvent('0.35.0', '0.35.1'))
    emit(completeEvent('0.35.0', '0.35.1'))
    expect(mocks.modalInfo).toHaveBeenCalledTimes(2)
  })

  test('双挂载(Layout + MobileAgent)同一 complete 只弹一次', () => {
    render(
      <>
        <UpdateNotifier />
        <UpdateNotifier />
      </>,
    )
    emit(completeEvent('0.34.0', '0.34.1'))
    expect(mocks.modalInfo).toHaveBeenCalledTimes(1)
  })

  test('failed 弹错误 Modal', () => {
    render(<UpdateNotifier />)
    emit({
      type: 'app.update.failed',
      from: '0.33.0',
      to: '0.33.1',
      error: 'npm install exited with code 1',
    })
    expect(mocks.modalError).toHaveBeenCalledTimes(1)
    expect(mocks.modalError.mock.calls[0][0].title).toBe('zai 升级失败')
  })
})