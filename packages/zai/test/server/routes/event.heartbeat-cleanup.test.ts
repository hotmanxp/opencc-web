import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import eventRouter from '../../../src/server/routes/event.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import { resetSseResBrokenForTests } from '../../../src/server/services/sse.js'
import {
  __setBackgroundRuntime,
  type RestartAwareBackgroundRuntime,
} from '../../../src/server/services/backgroundRuntime.js'

const HEARTBEAT_MS = 15_000

type Handler = (req: Request, res: Response) => Promise<void>

// 直接从 router stack 取 handler: SSE 是长连接, supertest 无法在 fake timer 下
// 精确观察 setInterval 的生命周期, 这里用最小 req/res 双 mock 驱动。
function getEventHandler(): Handler {
  const stack = (eventRouter as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Handler }> } }> }).stack
  const layer = stack.find((l) => l.route?.path === '/event')
  if (!layer?.route) throw new Error('GET /event route not found')
  return layer.route.stack[0].handle
}

function makeReqRes(writeImpl: (chunk: string) => boolean) {
  const req = new EventEmitter() as unknown as Request & EventEmitter
  ;(req as unknown as { query: Record<string, unknown> }).query = {}
  ;(req as unknown as { headers: Record<string, unknown> }).headers = {}

  const write = vi.fn(writeImpl)
  const end = vi.fn()
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write,
    end,
  } as unknown as Response

  return { req, res, write, end }
}

const heartbeatWrites = (write: ReturnType<typeof vi.fn>) =>
  write.mock.calls.filter(([chunk]) => chunk === ': heartbeat\n\n').length

describe('GET /event heartbeat cleanup', () => {
  beforeEach(() => {
    resetSseResBrokenForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clears the heartbeat timer when the client closes the connection', async () => {
    const { req, res, write, end } = makeReqRes(() => true)
    const pending = getEventHandler()(req, res)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(heartbeatWrites(write)).toBe(1)

    req.emit('close')
    await pending

    expect(end).toHaveBeenCalled()

    // timer 已清除: 再推进多个心跳周期也不会有新的写入
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(heartbeatWrites(write)).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the heartbeat timer when res.write throws a non-EPIPE error', async () => {
    const boom = Object.assign(new Error('stream destroyed'), { code: 'ERR_STREAM_DESTROYED' })
    const { req, res, write, end } = makeReqRes((chunk) => {
      if (chunk === ': heartbeat\n\n') throw boom
      return true
    })

    const pending = getEventHandler()(req, res)

    // 心跳写失败 → handler 应结束并在 finally 中清理, 不能吞掉 timer
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    await pending

    expect(heartbeatWrites(write)).toBe(1)
    expect(end).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(heartbeatWrites(write)).toBe(1)

    // unsubscribe 也已执行: 新事件不会再写到这个 res
    const before = write.mock.calls.length
    eventBus.emit({ type: 'toast', sessionId: null, level: 'info', message: 'after-close' })
    expect(write.mock.calls.length).toBe(before)

    void req
  })

  it('unsubscribes when the client closes during the bg.list() await window', async () => {
    // Regression: close 监听原先注册在 `await bg.list()` **之后**。Node 的
    // 'close' 是一次性事件 —— 客户端在那个窗口里断开时,监听器永不触发,
    // `closed` promise 永久挂起 → finally 不执行 → unsubscribe 不调用、
    // 心跳 timer 不清。订阅就永久留在 eventBus 里。
    //
    // 必须注入一个真正挂起的 bg.list():没有它,handler 在到达
    // `await closed` 之前没有任何挂起点,emit('close') 落在注册之后,
    // 测试就会在有 bug 的代码上照样通过(已验证)。
    let releaseList: (() => void) | null = null
    __setBackgroundRuntime({
      list: () => new Promise((resolve) => { releaseList = () => resolve([]) }),
    } as unknown as RestartAwareBackgroundRuntime)

    try {
      const { req, res, write, end } = makeReqRes(() => true)
      const pending = getEventHandler()(req, res)

      // 跑进 bg.list() 的 await(此时 close 监听是否已注册,正是被测的差异)
      await vi.advanceTimersByTimeAsync(0)
      expect(releaseList).not.toBeNull()

      req.emit('close')
      releaseList?.()
      await pending

      expect(end).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      // unsubscribe 已执行: 新事件不会再写到这个 res
      const before = write.mock.calls.length
      eventBus.emit({ type: 'toast', sessionId: null, level: 'info', message: 'after-early-close' })
      expect(write.mock.calls.length).toBe(before)
    } finally {
      __setBackgroundRuntime(null)
    }
  })
})
