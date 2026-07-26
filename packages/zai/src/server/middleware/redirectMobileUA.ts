import type { Request, Response, NextFunction } from 'express'

/**
 * UA 白名单 — 覆盖 iPhone / iPad / iPod / Android（含纯 Android UA）/ Mobile Safari。
 * 不包含 'Macintosh' — iPadOS 13+ 桌面伪装 UA 走桌面端,在前端 MobileAgent 横幅处兜底(见 spec §3.3)。
 */
const MOBILE_UA_RE = /Mobile|Android|iPhone|iPad|iPod|Safari/

export function matchesMobileUA(ua: string | undefined): boolean {
  if (!ua) return false
  return MOBILE_UA_RE.test(ua)
}

/**
 * 把 /agent 重定向到 /m,保留 querystring。
 * 只对 /agent 路径生效;其它路径(/login /dashboard /m /api/...)直接 next()。
 * 不对 /m 重定向 — 避免 /m → /m 死循环。
 */
export function redirectMobileUA(req: Request, res: Response, next: NextFunction): void {
  // Express 的 app.use('/agent', mw) 会自动 strip 挂载前缀,中间件内
  // req.path 是相对路径('/...'),req.url 也是相对路径。完整路径要用
  // req.baseUrl + req.path(Express 官方 mount 语义);querystring 也要从
  // req.originalUrl 拿。
  const fullPath = req.baseUrl + req.path
  // req.path 在 app.use('/agent', ...) 下为 '/', 所以 '/agent/' 也算 '/agent'。
  if (!/^\/agent(?:\/|\\?|$)/.test(fullPath)) {
    next()
    return
  }
  const ua = req.headers['user-agent']
  if (!matchesMobileUA(typeof ua === 'string' ? ua : undefined)) {
    next()
    return
  }
  const suffix = req.originalUrl.replace(/^\/agent/, '')
  res.redirect(302, '/m' + suffix)
}
