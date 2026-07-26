import type { Response } from 'express'

/**
 * SSE 写入工具。从 routes/event.ts 抽出,供 event.ts 和 tasks.ts 共享。
 * 任何具有 { type, ... } 的对象都可以序列化。`id:` line 由独立的
 * `seq` 字段控制（用于 Last-Event-ID 续读），与 JSON payload 内的
 * `eventId` 字段解耦，避免两边撞车。
 *
 * EPIPE 防护: 如果浏览器中途关闭 EventSource (刷新 tab / NetworkError),
 * res.write 会抛 EPIPE. 这里的 try/catch 把 EPIPE 静默吃掉并标记 socket
 * 已坏, 后续 SSE 写入直接 no-op — 避免 EPIPE 抛出后 unhandled 'error'
 * 事件杀掉 zai 进程. (与 process.stdout 的 EPIPE 防护对称)
 */
let resSseBroken: WeakSet<Response> = new WeakSet<Response>()
export function isSseResBroken(res: Response): boolean {
  return resSseBroken.has(res)
}
export function resetSseResBrokenForTests(): void {
  resSseBroken = new WeakSet<Response>()
}

function safeResWrite(res: Response, data: string): boolean {
  if (resSseBroken.has(res)) return false
  if ((res as { writableEnded?: boolean }).writableEnded) {
    resSseBroken.add(res)
    return false
  }
  try {
    return res.write(data)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPIPE') {
      resSseBroken.add(res)
      try {
        res.end()
      } catch {
        // already closed
      }
      return false
    }
    throw err
  }
}

export function writeSse(
  res: Response,
  event: { seq?: string | number; type: string } & Record<string, unknown>,
): void {
  if (resSseBroken.has(res)) return
  const id = event.seq ?? (event as { eventId?: string | number }).eventId
  if (id !== undefined) safeResWrite(res, `id: ${id}\n`)
  safeResWrite(res, `event: ${event.type}\n`)
  safeResWrite(res, `data: ${JSON.stringify(event)}\n\n`)
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const