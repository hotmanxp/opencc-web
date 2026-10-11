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

describe('MobileHeader — 「回到原生 APP 对话」入口(JS bridge)', () => {
  /**
   * 装上 lan-agent 的原生桥。页面侧的转发函数 window.lanAgentGoToAgent
   * 由 lib/lanAgentBridge.ts 在模块加载时注册 —— 本测试不 import 那个模块
   * (它是入口副作用),所以这里两个都手动装,复刻运行时形态。
   */
  function stubBridge(goToAgent: () => boolean = () => true) {
    const native = { goToAgent }
    vi.stubGlobal('AndroidWebview', native)
    vi.stubGlobal('lanAgentGoToAgent', () => window.AndroidWebview?.goToAgent?.() ?? false)
    return native
  }

  it('宿主 + 桥都在时渲染按钮', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    stubBridge()
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.getByTestId('mobile-header-go-native')).toBeInTheDocument()
  })

  it('点击按钮转发到原生桥', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    const spy = vi.fn(() => true)
    stubBridge(spy)
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    screen.getByTestId('mobile-header-go-native').click()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // 非 App 环境(手机浏览器直接开 /m)不该给一个点了没反应的按钮。
  it('宿主但无原生桥时不渲染(非 lan-agent 环境 / App 版本早于该桥)', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.queryByTestId('mobile-header-go-native')).toBeNull()
  })

  it('桥对象在但没有 goToAgent 方法时不渲染', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    vi.stubGlobal('AndroidWebview', {})
    vi.stubGlobal('lanAgentGoToAgent', () => false)
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.queryByTestId('mobile-header-go-native')).toBeNull()
  })

  // 桥是 lan-agent 独有:非宿主环境即便有桥也不该出现(UA 与桥两个信号都得满足)。
  it('非 WebView UA + 有桥仍不渲染', () => {
    stubUA(CHROME_MOBILE_UA)
    stubBridge()
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.queryByTestId('mobile-header-go-native')).toBeNull()
  })

  // 两个按钮共存是 lan-agent 宿主的常态 —— 模型入口不能被新按钮挤掉。
  it('与模型切换按钮共存', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    stubBridge()
    render(<MobileHeader onOpenSessionDrawer={() => {}} />)
    expect(screen.getByTestId('mobile-header-go-native')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-header-model')).toBeInTheDocument()
  })
})
