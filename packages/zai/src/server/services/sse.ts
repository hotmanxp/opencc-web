import type { Response } from 'express'

/**
 * SSE 写入工具。从 routes/event.ts 抽出,供 event.ts 和 tasks.ts 共享。
 * 任何具有 { type, ... } 的对象都可以序列化。`id:` line 由独立的
 * `seq` 字段控制（用于 Last-Event-ID 续读），与 JSON payload 内的
 * `eventId` 字段解耦，避免两边撞车。
 */
export function writeSse(
  res: Response,
  event: { seq?: string | number; type: string } & Record<string, unknown>,
): void {
  const id = event.seq ?? (event as { eventId?: string | number }).eventId
  if (id !== undefined) res.write(`id: ${id}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const