import type { Response } from 'express'

/**
 * SSE 写入工具。从 routes/event.ts 抽出,供 event.ts 和 tasks.ts 共享。
 * 任何具有 {eventId, type} 的对象都可以序列化。
 */
export function writeSse(
  res: Response,
  event: { eventId: string | number; type: string } & Record<string, unknown>,
): void {
  res.write(`id: ${event.eventId}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const