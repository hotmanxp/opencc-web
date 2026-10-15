import { useMemo } from 'react'

/**
 * 判定当前页面是否运行在 Android WebView 里(宿主 App 的 WebView,典型如
 * lan-agent 加载 /m 页面)。
 *
 * lan-agent 的 WebViewScreen.kt 没有调用 setUserAgentString,走系统默认 UA。
 * 默认 UA 里有两个 WebView 专有特征:
 *   - `; wv)`      — Android WebView 标识。Chrome for Android 是
 *                    `Chrome/x.x.x.x Mobile Safari/537.36`,不带 `wv`。
 *   - `Version/4.0` — WebView 伪装成旧版 Safari 兼容站点。桌面/移动 Chrome
 *                    都不带这一段。
 * 任一命中即认为是 WebView 宿主;两者都不命中(桌面 Chrome / Safari / iOS
 * WebView 之外的环境)一律 false。
 *
 * 刻意不做模块级缓存:UA 是静态的,一次正则匹配开销可忽略,而缓存会让单测
 * 无法用 vi.stubGlobal('navigator', …) 在同一进程里切换环境。useMemo 挡住
 * 每次 render 的重复计算已经够了。
 */
export function useIsLanAgentHost(): boolean {
  return useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent ?? ''
    return /;\s*wv\)/.test(ua) || /Version\/4\.0/.test(ua)
  }, [])
}