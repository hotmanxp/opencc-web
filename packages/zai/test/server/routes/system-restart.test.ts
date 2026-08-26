import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import systemRouter, { __resetRestartRouter } from '../../../src/server/routes/system.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
  vi.restoreAllMocks()
})

describe('POST /api/system/restart', () => {
  beforeEach(() => {
    __resetRestartRouter()
  })

  it.skip('returns 409 when not managed', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(res.status).toBe(409)
  })

  it('returns 202 when managed and triggers restart with correct IPC type', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    __resetRestartRouter()
    // runtimeLifecycle.closeServer / sendRestart / exit 在新实现里真的干活:
    // closeServer 关 http server(测试里没注册,直接跳过)、sendRestart 通过
    // process.send 发 IPC、exit 调 process.exit。把它们都 stub 掉避免
    // 测试进程被干掉;exit mock 抛 sentinel 让 coordinator promise 走 reject,
    // route handler 已挂 .catch(见 system.ts),不会泄漏成 unhandled rejection。
    let captured: any = null
    ;(process as any).send = (m: any) => { captured = m; return true }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`__process_exit_${code}`)
    })
    const app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => { req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }; next() })
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(res.status).toBe(202)
    // 子进程 → supervisor 必须发 { type: 'restart', reason } 才会触发 respawn。
    // 早期占位类型 'restarted' 与 supervisor 协议不符,即便 closeServer/exit
    // 修了按钮也不重启 — 这就是 SettingsDrawer 重启按钮无响应的根因之一。
    // 见 supervisor.ts:188 + managedChild.ts:ChildMessage。
    expect(captured?.type).toBe('restart')
    expect(captured?.reason).toBe('user_action')
    // 给 coordinator 微任务时间跑完 closeServer → sendRestart → exit(抛错)。
    await new Promise((r) => setTimeout(r, 10))
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
