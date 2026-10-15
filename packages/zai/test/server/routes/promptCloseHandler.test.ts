import { describe, expect, test, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * S3 的 `res.on("close")` + `writableFinished` 判别,跑在**真 socket** 上。
 *
 * 之前只测了三个 registry 的 `abortAll(reason, sessionId)`,判别逻辑本身一行
 * 没测过 —— 而它恰恰是 S3 的全部意义:正常 200 响应也会触发 close,判错就是
 * 「每次正常发 prompt 都 abort 全局 pending」。mock 出来的 req/res 复现不了
 * Node 的真实时序(什么时候 emit close、writableFinished 当时是什么值),
 * 所以这里用真 http server + 真客户端 socket。
 *
 * 被测的 handler 与 routes/agent.ts 的 POST /agent/prompt 里那段同构。
 */
describe('prompt close handler(writableFinished 判别)', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  })

  /** 起一个 server:建 pending → 写响应;返回本次 abortAll 是否被调用 + 实际值 */
  function startServer(opts: { abortBeforeRespond: boolean; holdMs: number }) {
    const calls: { reason: string; sessionId: string | undefined; writableFinished: boolean }[] = []

    const server = createServer((req, res) => {
      const sessionId = 'sess-under-test'

      // ★ 与 routes/agent.ts 同构:监听注册在第一个 await 之前
      res.on('close', () => {
        if (res.writableFinished) return          // 正常响应完成 → 什么都不做
        calls.push({ reason: 'client_disconnect', sessionId, writableFinished: res.writableFinished })
      })

      void (async () => {
        // 模拟 await(比如 getTranscriptStore().read):给客户端一个掐断的窗口
        await new Promise((r) => setTimeout(r, opts.holdMs))
        if (opts.abortBeforeRespond) {
          // 客户端已断开 → 写入失败,close 已带 writableFinished=false 触发
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessionId }))
      })()
    })

    servers.push(server)
    return { server, calls }
  }

  function listen(s: Server): Promise<number> {
    return new Promise((resolve) => {
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port))
    })
  }

  test('正常 200 响应 → close 会触发但 writableFinished=true → 不 abort', async () => {
    const { server, calls } = startServer({ abortBeforeRespond: false, holdMs: 10 })
    const port = await listen(server)

    const body = await fetch(`http://127.0.0.1:${port}/prompt`).then((r) => r.text())
    expect(JSON.parse(body)).toEqual({ ok: true, sessionId: 'sess-under-test' })

    // 等 close 事件在 server 侧跑完
    await new Promise((r) => setTimeout(r, 80))
    // ★ S3 的核心断言:正常发一条 prompt,一次都不该 abort
    expect(calls).toEqual([])
  })

  test('客户端在响应前掐断 → writableFinished=false → 只 abort 本会话', async () => {
    const { server, calls } = startServer({ abortBeforeRespond: true, holdMs: 300 })
    const port = await listen(server)

    const ac = new AbortController()
    void fetch(`http://127.0.0.1:${port}/prompt`, { signal: ac.signal }).catch(() => {})
    // 响应还没写出来就断开
    await new Promise((r) => setTimeout(r, 60))
    ac.abort()

    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toHaveLength(1)
    expect(calls[0].writableFinished).toBe(false)
    expect(calls[0].sessionId).toBe('sess-under-test')
  })

  test('多次正常请求累积下来仍然零 abort(不会越攒越多)', async () => {
    const { server, calls } = startServer({ abortBeforeRespond: false, holdMs: 5 })
    const port = await listen(server)

    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${port}/prompt`).then((r) => r.text())
    }
    await new Promise((r) => setTimeout(r, 120))
    expect(calls).toEqual([])
  })
})
