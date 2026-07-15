import { notification } from 'antd'

export class ApiError extends Error {
  readonly status: number
  readonly method: string
  readonly url: string
  readonly body: string
  readonly at: number

  constructor(
    status: number,
    method: string,
    url: string,
    body: string,
  ) {
    super(`${status} ${method} /api${url}`.trimEnd())
    this.name = 'ApiError'
    this.status = status
    this.method = method
    this.url = url
    this.body = body
    this.at = Date.now()
  }
}

// 节流:key → 上次通知的 timestamp(ms)。LRU 上限 64,超出从头淘汰。
const THROTTLE_WINDOW_MS = 2000
const MAX_KEYS = 64
const lastNotifyAt = new Map<string, number>()

function shouldNotify(key: string): boolean {
  const now = Date.now()
  const last = lastNotifyAt.get(key)
  if (last !== undefined && now - last < THROTTLE_WINDOW_MS) return false
  lastNotifyAt.set(key, now)
  if (lastNotifyAt.size > MAX_KEYS) {
    const oldest = lastNotifyAt.keys().next().value
    if (oldest !== undefined) lastNotifyAt.delete(oldest)
  }
  return true
}

// 仅测试用
export function __resetThrottleForTests(): void {
  lastNotifyAt.clear()
}

export function notifyApiError(err: ApiError): void {
  const key = `${err.method} ${err.url} ${err.status}`
  if (!shouldNotify(key)) return
  let bodyDisplay: string
  try {
    bodyDisplay = JSON.stringify(JSON.parse(err.body), null, 2)
  } catch {
    bodyDisplay = err.body
  }
  const description =
    `${err.method} /api${err.url}\n` +
    `status: ${err.status}\n` +
    `time:   ${new Date(err.at).toISOString()}\n\n` +
    bodyDisplay
  notification.error({
    message: `${err.status} ${err.method} /api${err.url}`.trimEnd(),
    description,
    duration: 6,
  })
}

export function notifySseError(path: string, reason: string): void {
  const key = `sse:${path}`
  if (!shouldNotify(key)) return
  notification.error({
    message: 'SSE 连接已断开',
    description: `path: ${path}\nreason: ${reason}`,
    duration: 6,
  })
}
