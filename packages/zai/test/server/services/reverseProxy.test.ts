/**
 * zai 反向代理单元测试 — 覆盖 plan 里 10 个用例:
 *   1. HTTP GET 透传 body
 *   2. Host header 改写为 127.0.0.1:<port>
 *   3. SSE 不 buffer(首字节 < 500ms)
 *   4. WebSocket upgrade + echo
 *   5. ECONNREFUSED → 502 Bad Gateway
 *   6. 非 --lan → 403
 *   7. query string 透传
 *   8. 大 body 上下行(2MB)
 *   9. 前缀剥离(/proxy/<port>/foo → 上游收到 /foo)
 *  10. 客户端断 → 上游 socket 关闭
 *
 * 关键约束(superpowers AGENTS.md):
 *  - 仅 `pnpm --filter @zn-ai/zai test <this file>` 单文件运行,**禁止** `pnpm -r test`
 *  - 真实 http listen + ws 客户端,不 mock 网络层
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import express from 'express'
import request from 'supertest'
import WebSocket, { WebSocketServer } from 'ws'
import {
  createReverseProxyMiddleware,
  handleProxyUpgrade,
  proxyErrorHtml,
} from '../../../src/server/services/reverseProxy.js'

interface StartedZai {
  url: string
  port: number
  close: () => Promise<void>
}

interface StartedUpstream {
  port: number
  close: () => Promise<void>
}

/** 启一个挂上 reverseProxy middleware + upgrade handler 的 zai app server。 */
async function startZaiServer(opts: { lan: boolean }): Promise<StartedZai> {
  const app = express()
  app.use(
    '/proxy',
    createReverseProxyMiddleware({
      isEnabled: () => opts.lan,
    }),
  )
  const server = http.createServer(app)
  server.on(
    'upgrade',
    handleProxyUpgrade({
      isEnabled: () => opts.lan,
    }),
  )
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 启一个上游 http server,用于接收代理转发的请求。 */
async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<StartedUpstream> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address() as net.AddressInfo
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 找一个当前空闲的端口(立即关闭)用于 ECONNREFUSED 测试。 */
async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as net.AddressInfo
      s.close(() => resolve(addr.port))
    })
  })
}

describe('reverseProxy middleware (lan=true)', () => {
  let zai: StartedZai

  beforeEach(async () => {
    zai = await startZaiServer({ lan: true })
  })

  afterEach(async () => {
    await zai.close()
  })

  it('用例 1: HTTP GET 透传 body 和 status', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ hello: 'world' }))
    })
    try {
      const res = await request(zai.url).get(`/proxy/${upstream.port}/api`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ hello: 'world' })
    } finally {
      await upstream.close()
    }
  })

  it('用例 2: 改写 Host header 为 127.0.0.1:<port>(避免 Vite 严格校验)', async () => {
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ host: req.headers.host }))
    })
    try {
      // supertest 会忽略 .set('Host', ...)(node http 也限制 client 改 Host),
      // 用原生 http.request 让 Host 真的能被改写到上游。
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: zai.port,
            path: `/proxy/${upstream.port}/api`,
            method: 'GET',
            headers: { Host: 'fake-lan-host:9999' },
          },
          (res) => {
            let buf = ''
            res.setEncoding('utf8')
            res.on('data', (c) => (buf += c))
            res.on('end', () => resolve(buf))
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.end()
      })
      const parsed = JSON.parse(body)
      expect(parsed.host).toBe(`127.0.0.1:${upstream.port}`)
    } finally {
      await upstream.close()
    }
  })

  it('用例 3: SSE 不 buffer — 上游 50ms 后写首字节,客户端 < 500ms 收到', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.flushHeaders()
      setTimeout(() => {
        res.write('data: first\n\n')
        setTimeout(() => {
          res.write('data: second\n\n')
          res.end()
        }, 80)
      }, 50)
    })
    try {
      const fullData: string[] = []
      let firstChunkAt = -1
      const t0 = Date.now()
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          `${zai.url}/proxy/${upstream.port}/sse`,
          (res) => {
            res.setEncoding('utf8')
            res.on('data', (c) => {
              fullData.push(c)
              if (firstChunkAt < 0) firstChunkAt = Date.now() - t0
            })
            res.on('end', () => resolve())
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.setTimeout(3000, () => reject(new Error('SSE client timeout')))
      })
      const joined = fullData.join('')
      // 不依赖 Node chunk 切分时机(两帧可能在同一 chunk 里,合在一起解析)
      expect(joined).toContain('data: first')
      expect(joined).toContain('data: second')
      // 第一字节到达 < 500ms:上游 50ms 后发首字节,proxy 不能 buffer
      expect(firstChunkAt).toBeGreaterThanOrEqual(0)
      expect(firstChunkAt).toBeLessThan(500)
    } finally {
      await upstream.close()
    }
  })

  it('用例 4: WebSocket upgrade 成功,echo 双向 pipe', async () => {
    // 上游启一个 ws server,接受任何路径的 upgrade
    const wss = new WebSocketServer({ noServer: true })
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        ws.send(isBinary ? data : `echo: ${data.toString()}`)
      })
    })
    const upstreamServer = http.createServer()
    upstreamServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      } else {
        socket.destroy()
      }
    })
    await new Promise<void>((resolve, reject) => {
      upstreamServer.on('error', reject)
      upstreamServer.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = upstreamServer.address() as net.AddressInfo
    const upstream: StartedUpstream = {
      port: addr.port,
      close: () =>
        new Promise<void>((resolveClose) => {
          wss.close(() => {
            upstreamServer.closeAllConnections?.()
            upstreamServer.close(() => resolveClose())
          })
        }),
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${zai.port}/proxy/${upstream.port}/ws`,
        )
        const timer = setTimeout(
          () => reject(new Error('ws echo timeout')),
          3000,
        )
        ws.on('open', () => ws.send('hello'))
        ws.on('message', (data) => {
          if (data.toString() === 'echo: hello') {
            clearTimeout(timer)
            ws.close()
            resolve()
          }
        })
        ws.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
    } finally {
      await upstream.close()
    }
  })

  it('用例 5: 上游未监听 → 502 Bad Gateway(HTML 错误页)', async () => {
    const port = await findFreePort()
    const res = await request(zai.url).get(`/proxy/${port}/`)
    expect(res.status).toBe(502)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('502 Bad Gateway')
    expect(res.text).toContain(`127.0.0.1:${port}`)
  })

  it('用例 7: query string 透传 — 上游 req.url 含 ?a=1&b=2', async () => {
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ url: req.url }))
    })
    try {
      const res = await request(zai.url).get(
        `/proxy/${upstream.port}/api?a=1&b=2`,
      )
      expect(res.status).toBe(200)
      expect(res.body.url).toBe('/api?a=1&b=2')
    } finally {
      await upstream.close()
    }
  })

  it('用例 8: 大 body 上下行(2MB POST + 回显)', async () => {
    const upstream = await startUpstream((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('X-Input-Length', String(body.length))
        res.end(body) // 回显
      })
    })
    try {
      const payload = 'x'.repeat(2 * 1024 * 1024)
      const res = await request(zai.url)
        .post(`/proxy/${upstream.port}/upload`)
        .set('Content-Type', 'text/plain')
        .send(payload)
      expect(res.status).toBe(200)
      expect(res.headers['x-input-length']).toBe(String(2 * 1024 * 1024))
      expect(res.text.length).toBe(2 * 1024 * 1024)
      expect(res.text).toBe(payload)
    } finally {
      await upstream.close()
    }
  })

  it('用例 9: 前缀剥离 — 上游收到 /foo/bar,不是 /proxy/<port>/foo/bar', async () => {
    const upstream = await startUpstream((req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ url: req.url }))
    })
    try {
      const res = await request(zai.url).get(
        `/proxy/${upstream.port}/foo/bar`,
      )
      expect(res.status).toBe(200)
      expect(res.body.url).toBe('/foo/bar')
    } finally {
      await upstream.close()
    }
  })

  it('用例 10: 客户端断 → 上游 socket 关闭(防泄漏)', async () => {
    let upstreamReqClosed = false
    const upstream = await startUpstream((req, res) => {
      req.on('close', () => {
        upstreamReqClosed = true
      })
      // 长响应延迟,模拟慢服务
      setTimeout(() => {
        try {
          res.statusCode = 200
          res.end('ok')
        } catch {
          // 上游可能已关闭
        }
      }, 5000)
    })
    try {
      // 用原生 http 发请求,50ms 后 destroy
      await new Promise<void>((resolve) => {
        const req = http.request(
          `${zai.url}/proxy/${upstream.port}/slow`,
          { method: 'GET' },
          (res) => {
            res.on('data', () => {})
            res.on('end', () => resolve())
            res.on('error', () => resolve())
          },
        )
        req.on('error', () => resolve())
        req.end()
        setTimeout(() => {
          req.destroy()
          resolve()
        }, 50)
      })
      // 给上游 close handler 一些时间触发
      await new Promise((r) => setTimeout(r, 200))
      expect(upstreamReqClosed).toBe(true)
    } finally {
      await upstream.close()
    }
  })
})

describe('reverseProxy middleware (lan=false)', () => {
  it('用例 6: 非 --lan 模式 → 403 + 提示信息', async () => {
    const zai = await startZaiServer({ lan: false })
    try {
      const res = await request(zai.url).get(`/proxy/8081/foo`)
      expect(res.status).toBe(403)
      expect(res.text).toContain('--lan')
    } finally {
      await zai.close()
    }
  })

  it('非 --lan 模式 → WebSocket upgrade 也 403', async () => {
    const zai = await startZaiServer({ lan: false })
    try {
      // 用原生 net socket 发 HTTP/1.1 upgrade,断言收到 403
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection(
          { host: '127.0.0.1', port: zai.port },
          () => {
            sock.write(
              'GET /proxy/8081/ws HTTP/1.1\r\n' +
                'Host: 127.0.0.1\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
                'Sec-WebSocket-Version: 13\r\n\r\n',
            )
          },
        )
        let buf = ''
        sock.on('data', (c) => {
          buf += c.toString()
          if (buf.includes('\r\n\r\n')) {
            expect(buf).toContain('403')
            sock.destroy()
            resolve()
          }
        })
        sock.on('error', reject)
        sock.setTimeout(2000, () => {
          sock.destroy()
          reject(new Error('upgrade 403 timeout, got: ' + buf))
        })
      })
    } finally {
      await zai.close()
    }
  })
})

describe('proxyErrorHtml', () => {
  it('renders 502 page with port info', () => {
    const html = proxyErrorHtml(8100)
    expect(html).toContain('502 Bad Gateway')
    expect(html).toContain('127.0.0.1:8100')
  })
})