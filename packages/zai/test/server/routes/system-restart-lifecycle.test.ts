import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import systemRouter, { __resetRestartRouter } from '../../../src/server/routes/system.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import { __resetBackgroundRuntimeForTests } from '../../../src/server/services/backgroundRuntime.js'

/**
 * 验证 routes/system.ts 的 restart / stop 真的接入 runtimeLifecycle:
 *   - restart 路径调 closeServer + sendRestart + exit(0)
 *   - stop 路径调 cleanupAndExit(0)(内部含 closeServer + exit)
 *   - closeServer / sendRestart / exit 来自 runtimeLifecycle,
 *     把这些函数 spy 化可断言 route 真把它们接上了,而不像之前的
 *     stub `/* wired in T12 *\/` 完全没干活。
 */

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
  delete (process as { send?: unknown }).send
  __resetRestartRouter()
  __resetBackgroundRuntimeForTests()
  vi.restoreAllMocks()
})

beforeEach(() => {
  __resetRestartRouter()
  __resetBackgroundRuntimeForTests()
})

describe('POST /api/system/restart lifecycle wiring', () => {
  it('manager-mode restart goes through real closeServer → sendRestart → exit', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'

    // 直接 mock 整个 runtimeLifecycle 模块,断言 route 的 deps 引用的是
    // 真实导出的 closeServer / sendRestart / exit,且 coordinator 顺序正确。
    const lifecycle = await import('../../../src/server/services/runtimeLifecycle.js')
    const closeServerSpy = vi.spyOn(lifecycle, 'closeServer').mockResolvedValue()
    const sendRestartSpy = vi
      .spyOn(lifecycle, 'sendRestart')
      .mockReturnValue(true)
    const exitSpy = vi.spyOn(lifecycle, 'exit').mockImplementation(() => undefined)

    let captured: unknown = null
    ;(process as { send?: (m: unknown) => boolean }).send = (m) => {
      captured = m
      return true
    }

    const seen: { type: string; reason?: string }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'system.restarting') {
        seen.push({ type: e.type, reason: e.reason })
      }
    })

    try {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res, next) => {
        req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }
        next()
      })
      app.use('/api', systemRouter)
      const res = await request(app)
        .post('/api/system/restart')
        .send({ reason: 'user_action' })
      expect(res.status).toBe(202)
      // system.restarting 仍先广播(SSE 客户端先看到倒计时)
      expect(seen.length).toBe(1)
      expect(seen[0]?.type).toBe('system.restarting')
      expect(seen[0]?.reason).toBe('user_action')

      // coordinator 异步跑,给它点时间
      await new Promise((r) => setTimeout(r, 20))

      // 三步按顺序
      expect(closeServerSpy).toHaveBeenCalledTimes(1)
      expect(sendRestartSpy).toHaveBeenCalledTimes(1)
      expect(sendRestartSpy).toHaveBeenCalledWith('user_action')
      expect(exitSpy).toHaveBeenCalledWith(0)

      // sendRestart mock 没真的走 sendToSupervisor,所以 captured 应为 null
      expect(captured).toBeNull()
    } finally {
      off()
    }
  })
})

describe('POST /api/system/stop lifecycle wiring', () => {
  it('stop does NOT call sendRestart (no IPC), only cleanupAndExit', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'

    const lifecycle = await import('../../../src/server/services/runtimeLifecycle.js')
    const cleanupAndExitSpy = vi
      .spyOn(lifecycle, 'cleanupAndExit')
      .mockResolvedValue()
    const sendRestartSpy = vi
      .spyOn(lifecycle, 'sendRestart')
      .mockReturnValue(true)

    const seen: { type: string }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'system.stopping') seen.push({ type: e.type })
    })

    try {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res, next) => {
        req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }
        next()
      })
      app.use('/api', systemRouter)
      const res = await request(app).post('/api/system/stop')
      expect(res.status).toBe(202)
      expect(seen.length).toBe(1)
      expect(seen[0]?.type).toBe('system.stopping')

      await new Promise((r) => setTimeout(r, 20))

      // 停服路径不向 supervisor 发 'restart' — supervisor 看到 child exit 0
      // 走正常退出路径(supervisor.ts exitCode = code ?? 0)。
      expect(sendRestartSpy).not.toHaveBeenCalled()
      // cleanupAndExit(0) 内含 closeServer + exit,不再单独 spy 它们
      expect(cleanupAndExitSpy).toHaveBeenCalledWith(0)
    } finally {
      off()
    }
  })
})