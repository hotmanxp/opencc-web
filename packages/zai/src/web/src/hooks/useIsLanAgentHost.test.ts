// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsLanAgentHost } from './useIsLanAgentHost'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubUA(ua: string) {
  vi.stubGlobal('navigator', { userAgent: ua })
}

/**
 * lan-agent 的 WebViewScreen.kt 没有调用 setUserAgentString,走 Android 系统
 * 默认 UA。UA 里必带 WebView 专有特征: 模型串 `; wv)` 与 `Version/4.0`。
 * 普通 Chrome(Safari 兼容模式)两者都没有。
 */
const ANDROID_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36'
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36'
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

function isHost(ua: string) {
  stubUA(ua)
  return renderHook(() => useIsLanAgentHost()).result.current
}

describe('useIsLanAgentHost — Android WebView 宿主判定', () => {
  it('Android WebView 默认 UA 命中(两个特征都在)', () => {
    expect(isHost(ANDROID_WEBVIEW_UA)).toBe(true)
  })

  it('只带 `; wv)` 不带 Version/4.0 也命中', () => {
    expect(
      isHost(
        'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe(true)
  })

  it('只带 Version/4.0 不带 `; wv)` 也命中', () => {
    expect(
      isHost(
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36',
      ),
    ).toBe(true)
  })

  it('普通移动端 Chrome 不命中', () => {
    expect(isHost(ANDROID_CHROME_UA)).toBe(false)
  })

  it('桌面 Chrome 不命中', () => {
    expect(isHost(DESKTOP_CHROME_UA)).toBe(false)
  })

  // iOS Safari 也带 Version/17.0 这类段, 但不匹配 Version/4.0 —— 这是
  // 判定必须写死 4.0 而不是泛匹配 Version/ 的原因, 否则 iPhone 上会误判
  // 成 WebView 宿主而丢掉底部状态栏。
  it('iOS Safari 不命中(Version/4.0 写死, 不泛匹配 Version/)', () => {
    expect(isHost(IOS_SAFARI_UA)).toBe(false)
  })

  it('navigator 缺失时安全返回 false', () => {
    vi.stubGlobal('navigator', undefined)
    expect(renderHook(() => useIsLanAgentHost()).result.current).toBe(false)
  })

  it('同一次挂载内多次 render 结果稳定(不随 render 漂移)', () => {
    stubUA(ANDROID_WEBVIEW_UA)
    const { rerender, result } = renderHook(() => useIsLanAgentHost())
    expect(result.current).toBe(true)
    rerender()
    rerender()
    expect(result.current).toBe(true)
  })
})