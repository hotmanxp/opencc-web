// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useAgentStore } from '../store/useAgentStore.js'
import MobileHeader from './MobileHeader.js'

beforeEach(() => {
  useAgentStore.setState({
    sessionId: 's1',
    sessions: [{ sessionId: 's1', title: '测试会话' }],
    status: 'idle',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 把 navigator.userAgent 换成指定的 UA 串, 验证宿主判定分支。 */
function stubUA(ua: string) {
  vi.stubGlobal('navigator', { userAgent: ua })
}

// lan-agent 的 WebViewScreen.kt 没调 setUserAgentString,走系统默认 UA。
const ANDROID_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36'
const CHROME_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36'
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'

describe('MobileHeader — 会话切换禁用', () => {
  it('idle 时新建会话按钮可用', () => {
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.getByTestId('mobile-header-new-session')).toBeEnabled()
  })

  it('streaming 时新建会话按钮 disabled(对话进行中禁用会话切换)', () => {
    useAgentStore.setState({ status: 'streaming' })
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    const btn = screen.getByTestId('mobile-header-new-session')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute(
      'title',
      '对话进行中,请等待当前回复结束',
    )
  })
})

describe('MobileHeader — lan-agent 宿主的模型切换入口', () => {
  it('Android WebView UA 下渲染模型切换按钮(底部状态栏被隐藏,入口搬到这里)', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.getByTestId('mobile-header-model')).toBeInTheDocument()
  })

  it('普通移动端 Chrome UA 下不渲染(底部状态栏仍显示,模型入口不重复)', () => {
    stubUA(CHROME_MOBILE_UA)
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.queryByTestId('mobile-header-model')).toBeNull()
  })

  it('桌面 Chrome UA 下不渲染', () => {
    stubUA(DESKTOP_CHROME_UA)
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.queryByTestId('mobile-header-model')).toBeNull()
  })
})
