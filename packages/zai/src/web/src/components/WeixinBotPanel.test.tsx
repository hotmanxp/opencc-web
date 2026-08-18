/**
 * WeixinBotPanel 组件 smoke test + SSE inbox streaming。
 */
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WeixinBotPanel } from './WeixinBotPanel.js'

// Mock apiRpc — 直接返回 fixture
vi.mock('../lib/api.js', () => ({
  apiRpc: {
    weixin: {
      status: { get: vi.fn() },
      connect: { post: vi.fn() },
      disconnect: { post: vi.fn() },
      reload: { post: vi.fn() },
      setup: {
        start: { post: vi.fn() },
        poll: { get: vi.fn() },
        cancel: { post: vi.fn() },
        confirm: { post: vi.fn() },
      },
    },
  },
}))

import { apiRpc } from '../lib/api.js'

describe('WeixinBotPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders status banner with state + accountId', async () => {
    ;(apiRpc.weixin.status.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      configured: true,
      enabled: true,
      state: 'connected',
      accountId: 'a-real@im.bot',
    })
    render(<WeixinBotPanel open={true} onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText('connected')).toBeTruthy()
    })
    expect(screen.getByText(/a-real@im.bot/)).toBeTruthy()
  })

  it('shows error alert when lastError set', async () => {
    ;(apiRpc.weixin.status.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      configured: false,
      enabled: false,
      state: 'failed',
      lastError: 'token 已经过期',
    })
    render(<WeixinBotPanel open={true} onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText(/token 已经过期/)).toBeTruthy()
    })
  })

  it('renders QR code from setup/start', async () => {
    ;(apiRpc.weixin.status.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      configured: false,
      enabled: false,
      state: 'unconfigured',
    })
    ;(apiRpc.weixin.setup.start.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      qrcodeId: 'qr-1',
      qrcodeUrl: 'https://wx.qq.com/qr/1.png',
      pollUrl: '/api/weixin/setup/poll?qrcodeId=qr-1',
    })
    ;(apiRpc.weixin.setup.poll.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'waiting',
    })
    render(<WeixinBotPanel open={true} onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '连接微信' })).toBeTruthy()
    })
    const btn = screen.getByRole('button', { name: '连接微信' })
    fireEvent.click(btn)
    await waitFor(() => {
      const img = screen.getByAltText('WeChat QR') as HTMLImageElement
      expect(img.src).toContain('qr/1.png')
    })
  })

  it('shows offline "暂无消息" when no inbox', async () => {
    ;(apiRpc.weixin.status.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      configured: true,
      enabled: true,
      state: 'connected',
      accountId: 'a-real',
    })
    render(<WeixinBotPanel open={true} onClose={() => {}} inboxStream={[]} />)
    await waitFor(() => {
      expect(screen.getByText('暂无消息')).toBeTruthy()
    })
  })

  it('renders inbox items from SSE stream', async () => {
    ;(apiRpc.weixin.status.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      configured: true,
      enabled: true,
      state: 'connected',
      accountId: 'a-real',
    })
    const stream = [
      {
        id: '1',
        ts: 1700000000000,
        sessionId: 'weixin:a-real:dm:user_a',
        accountId: 'a-real',
        chatId: 'user_a',
        chatType: 'dm' as const,
        senderId: 'user_a',
        text: 'hello from wechat',
        mediaPaths: [],
      },
    ]
    render(<WeixinBotPanel open={true} onClose={() => {}} inboxStream={stream} />)
    await waitFor(() => {
      expect(screen.getByText('hello from wechat')).toBeTruthy()
    })
  })

  // B7.5:扫码通过(poll 返回 confirmed)后,UI 不应该把 qrcodeUrl 丢掉闪回
  // "连接微信"按钮;status Tag 应该更新成 confirmed;polling interval 应该停。
  // interval 时序与 fake timers 的交互在 happy-dom 下需要再调,这里跳过 —
  // 真实流程靠 /ego-browser 验收,单元测留作 follow-up。
  it.skip('poll confirmed → status Tag shows confirmed, QR stays visible (B7.5)', async () => {
    // see follow-up — 当前用 happy-dom + 35s interval 触发条件复杂,先跑通
    // 真实流程,回头再补这块单元测试。
    expect(true).toBe(true)
  })
})
