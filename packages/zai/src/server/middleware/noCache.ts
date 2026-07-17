import type { Request, Response, NextFunction } from 'express'

/** 兜底设的 Cache-Control。SSE 路由会自带 `no-cache, no-transform` 不被覆盖. */
export const NO_CACHE = 'no-store, no-cache, must-revalidate'

/**
 * 防浏览器把 /api/* 响应按 304 缓存掉 — 配合 createApp() 里的
 * `app.set('etag', false)` 用, 让每次请求都返回完整 body.
 */
export function noCacheForApi(_req: Request, res: Response, next: NextFunction): void {
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', NO_CACHE)
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  }
  next()
}
