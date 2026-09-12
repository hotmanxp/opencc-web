import { describe, expect, test, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import eventRouter from './event.js'
import { eventBus } from '../services/eventBus.js'
import {
  __setBackgroundRuntime,
  __resetBackgroundRuntimeForTests,
  wrapWithJobStarted,
} from '../services/backgroundRuntime.js'

function makeApp() {
  const app = express()
  app.use('/api', eventRouter)
  return app
}

type SseCapture = { headers: Record<string, string>; body: string }

interface CaptureOptions {
  lastEventId?: string
  /** Passed as ?sid=xxx (also via X-Session-Id header). */
  sid?: string
  /** Called once headers arrive; use to schedule emits before destroy. */
  onReady?: (helpers: { wait: () => Promise<void> }) => void
  /** Predicate that decides when to destroy the stream and resolve. */
  until?: (body: string) => boolean
  timeoutMs?: number
}

// Open SSE connection, disable supertest's buffering (SSE never ends naturally),
// and consume the response stream directly. Resolves once `until(body)` returns
// true, or after timeoutMs as a safety net.
function captureSse(app: express.Express, options: CaptureOptions = {}): Promise<SseCapture> {
  return new Promise((resolve) => {
    let body = ''
    let headers: Record<string, string> = {}
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ headers, body })
    }
    const timer = setTimeout(finish, options.timeoutMs ?? 500)

    const req = request(app).get('/api/event').buffer(false)
    if (options.lastEventId) req.set('Last-Event-ID', options.lastEventId)
    if (options.sid) req.query({ sid: options.sid })

    req.on('response', (res) => {
      headers = res.headers as Record<string, string>
      const check = () => {
        if (options.until?.(body)) res.destroy()
      }
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString()
        check()
      })
      res.on('end', () => finish())
      res.on('error', () => finish())
      // onReady runs after the response stream is set up. Use to schedule
      // emits or other side effects that should land before resolution.
      options.onReady?.({
        wait: () => new Promise((r) => setTimeout(r, 20)),
      })
    })

    req.on('error', () => finish())
    req.end()
  })
}

describe('GET /api/event', () => {
  // eventBus 是 Node 进程级单例, 各 test 共享. 用一次性 marker (含
  // Date.now() + random) 防止前面 test 残留的事件误命中下面的 until 谓词.
  test('responds with text/event-stream and writes server.connected', async () => {
    const app = makeApp()
    const { headers, body } = await captureSse(app, {
      until: (b) => b.includes('event: server.connected') && b.includes('\n\n'),
      timeoutMs: 200,
    })
    expect(headers['content-type']).toMatch(/text\/event-stream/)
    expect(body).toMatch(/event: server\.connected/)
    expect(body).toMatch(/data: /)
    expect(body).toMatch(/id: /)
  })

  test('delivers live emit to subscriber', async () => {
    const app = makeApp()
    const marker = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { body } = await captureSse(app, {
      until: (b) => b.includes(`"message":"${marker}"`),
      timeoutMs: 300,
      onReady: ({ wait }) => {
        // Defer emit so the route handler's `eventBus.subscribe(...)` runs first.
        wait().then(() => eventBus.emit({ type: 'server.error', message: marker }))
      },
    })
    expect(body).toMatch(/event: server\.error/)
    expect(body).toMatch(new RegExp(`data: .*"message":"${marker}"`))
  })

  test('replay when Last-Event-ID is provided and found', async () => {
    const tag = `rpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let live1Id: string | undefined
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'server.error' && 'message' in e && (e as any).message === `${tag}-live1`) {
        live1Id = e.eventId
      }
    })
    eventBus.emit({ type: 'server.error', message: `${tag}-history1` })
    eventBus.emit({ type: 'server.error', message: `${tag}-live1` })
    unsub()

    if (!live1Id) throw new Error('expected live1Id')
    const app = makeApp()
    const { body } = await captureSse(app, {
      lastEventId: live1Id,
      until: (b) => b.includes('event: server.connected') && b.includes('\n\n'),
      timeoutMs: 200,
    })

    // history1 / live1 都在 lastEventId 之前, 不应被重放
    expect(body).not.toMatch(new RegExp(`"message":"${tag}-history1"`))
    expect(body).not.toMatch(new RegExp(`"message":"${tag}-live1"`))
    // server.connected is always emitted
    expect(body).toMatch(/event: server\.connected/)
  })

  // ========== Per-sid isolation (regression: 两个 tab 互串消息) ==========

  test('带 ?sid=A 时, 只收 sid=A 的 runtime.* 事件', async () => {
    const markerA = `sA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const markerB = `sB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      sid: 'A',
      until: (b) => b.includes(markerA),
      timeoutMs: 400,
      onReady: ({ wait }) => {
        // 先发 B 的 (不应当收到), 再发 A 的 (应当收到)
        wait().then(() => {
          eventBus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: markerB } as any)
          eventBus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: markerA } as any)
        })
      },
    })
    expect(body).toMatch(new RegExp(`data: .*"delta":"${markerA}"`))
    expect(body).not.toMatch(new RegExp(`"delta":"${markerB}"`))
  })

  test('带 ?sid=A 时, 全局事件 (server.error) 仍然照收', async () => {
    const marker = `glb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      sid: 'A',
      until: (b) => b.includes(marker),
      timeoutMs: 400,
      onReady: ({ wait }) => {
        wait().then(() => {
          eventBus.emit({ type: 'server.error', message: marker })
        })
      },
    })
    expect(body).toMatch(new RegExp(`data: .*"message":"${marker}"`))
  })

  test('带 ?sid=A 时, 其它 sid 的 job.* / prompt.ask 也不穿透', async () => {
    const askMarker = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const jobId = `j-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      sid: 'A',
      until: (b) => b.includes('event: server.connected'),
      timeoutMs: 300,
      onReady: ({ wait }) => {
        wait().then(() => {
          eventBus.emit({ type: 'job.started', jobId, kind: 'agent_task', sessionId: 'B' } as any)
          eventBus.emit({ type: 'prompt.ask', sessionId: 'B', toolUseId: 't1', questions: [{ question: askMarker, header: 'h', options: [] }] } as any)
        })
      },
    })
    expect(body).not.toMatch(new RegExp(`"question":"${askMarker}"`))
    expect(body).not.toMatch(new RegExp(`"jobId":"${jobId}"`))
  })

  test('不带 sid (旧路径) 维持全量转发', async () => {
    const marker = `unsid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      until: (b) => b.includes(marker),
      timeoutMs: 400,
      onReady: ({ wait }) => {
        wait().then(() => {
          eventBus.emit({ type: 'runtime.delta', sessionId: 'X', turnIndex: 0, delta: marker } as any)
        })
      },
    })
    expect(body).toMatch(new RegExp(`data: .*"delta":"${marker}"`))
  })

  test('带 sid 的 replay 只补该 sid 的历史 (Last-Event-ID)', async () => {
    const sid = `rpl-sid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let tailId: string | undefined
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'runtime.delta' && 'sessionId' in e && (e as any).sessionId === sid && (e as any).delta === `${sid}-tail`) {
        tailId = e.eventId
      }
    })
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-middle` } as any)
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-tail` } as any)
    unsub()
    if (!tailId) throw new Error('expected tailId')

    const app = makeApp()
    const { body } = await captureSse(app, {
      sid,
      lastEventId: tailId, // 续读: 不应重发 middle/tail
      until: (b) => b.includes('event: server.connected'),
      timeoutMs: 200,
    })
    expect(body).not.toMatch(new RegExp(`"delta":"${sid}-middle"`))
    expect(body).not.toMatch(new RegExp(`"delta":"${sid}-tail"`))
    expect(body).toMatch(/event: server\.connected/)
  })

  test('带 sid 重连 replay, 没找到 lastEventId → 补全该 sid 历史', async () => {
    const sid = `rpl-full-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-first` } as any)
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-second` } as any)

    const app = makeApp()
    const { body } = await captureSse(app, {
      sid,
      lastEventId: 'evt_does_not_exist', // 找不到 → 补该 sid 全量
      until: (b) => b.includes('event: server.connected'),
      timeoutMs: 200,
    })
    expect(body).toMatch(new RegExp(`"delta":"${sid}-first"`))
    expect(body).toMatch(new RegExp(`"delta":"${sid}-second"`))
  })

  // ========== 合成 bg state 推送 (regression: 刷新后 CliAgent drawer 空) ==========
  // bug 链: agent_task.changed 是「状态型」事件,每条 task 只 emit 1 次 (attach),
  // 但 per-sid eventBus history 上限 256 (CAPACITY),session 跑久后这条事件
  // 被 runtime.* 流量挤出 history。客户端刷新页面时,SSE 新连接 replay 拿
  // 不到 agent_task.changed → useAgentStore.agentTasksBySession[sid] 缺该
  // task → TaskDrawer 的 detail 是 null → 整段 body 因为 detail 守卫被卸,
  // 体感「没有任务的消息」。
  // 修法: 新 SSE 连接建立后,服务端绕开 eventBus 容量上限,直接遍历 bg
  // runtime 的 task 列表把每条 task 当作「合成的 agent_task.changed」事件
  // 单独 push 给本连接 (不走 eventBus,不被淘汰)。
  describe('合成 bg state 推送 (synth agent_task.changed)', () => {
    afterEach(() => {
      // 每个 case 注入的 fake bg runtime 都清掉, 避免污染其它 test
      __resetBackgroundRuntimeForTests()
    })

    function makeFakeBg(tasks: Array<{ id: string; parentSessionId: string | null; status?: string; agentType?: string; description?: string; eventCount?: number }>) {
      // 用真实 DefaultBackgroundRuntime 的 list 路径会从 disk 读,
      // 这里直接用最简 fake: 走 wrapWithJobStarted 让 list 走到 disk,
      // 所以要在 tmpdir 隔离 store 路径. 但事件路由只 list(), 不读 events,
      // 所以用一个 dict-shaped fake 即可, 不需要 disk 持久化.
      return wrapWithJobStarted({
        async dispatch() { throw new Error('not used') },
        async get(id: string) {
          const t = tasks.find((x) => x.id === id)
          if (!t) return null
          return {
            id: t.id,
            status: (t.status as any) ?? 'completed',
            input: { prompt: `prompt-for-${t.id}` },
            createdAt: 0,
            eventCount: t.eventCount ?? 0,
            ...(t.parentSessionId ? { parentSessionId: t.parentSessionId } : {}),
            ...(t.agentType ? { agentType: t.agentType } : {}),
            ...(t.description ? { description: t.description } : {}),
          } as any
        },
        async list() {
          return tasks.map((t) => ({
            id: t.id,
            status: (t.status as any) ?? 'completed',
            input: { prompt: `prompt-for-${t.id}` },
            createdAt: 0,
            eventCount: t.eventCount ?? 0,
            ...(t.parentSessionId ? { parentSessionId: t.parentSessionId } : {}),
            ...(t.agentType ? { agentType: t.agentType } : {}),
            ...(t.description ? { description: t.description } : {}),
          } as any))
        },
        async cancel() { return { ok: true } },
        async cancelByParentSession() { return { cancelled: 0 } },
        events: (() => (async function* () {})()) as any,
        async shutdown() {},
        attach: (async () => null) as any,
        appendTaskEvent: (async () => undefined) as any,
        finalizeTask: (async () => undefined) as any,
        sendMessageToTask: (async () => ({ ok: true })) as any,
      } as any)
    }

    test('新 SSE 连接 ?sid=A 立即收到 bg 里所有 parentSessionId===A 的合成 agent_task.changed', async () => {
      const sid = `bgstate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const bg = makeFakeBg([
        { id: 't1', parentSessionId: sid, agentType: 'dsh', description: 'CliAgent dsh', eventCount: 200 },
        { id: 't2', parentSessionId: sid, agentType: 'opencc', eventCount: 50 },
        { id: 't3', parentSessionId: 'other-sid', agentType: 'opencode', eventCount: 0 }, // 不该出现
      ])
      __setBackgroundRuntime(bg)

      const app = makeApp()
      const { body } = await captureSse(app, {
        sid,
        until: (b) => b.includes('event: server.connected'),
        timeoutMs: 200,
      })

      // t1 / t2 的合成事件应在 body 中; t3 (parentSessionId 不匹配) 不应
      expect(body).toMatch(/event: agent_task\.changed/)
      expect(body).toMatch(/"id":"t1"/)
      expect(body).toMatch(/"id":"t2"/)
      expect(body).not.toMatch(/"id":"t3"/)
      // 合成的 eventId 标记: 前端 client 不依赖此字段, 但合成路径必须稳定可识别
      expect(body).toMatch(/synth-bgstate-t1/)
      expect(body).toMatch(/synth-bgstate-t2/)
      // synth eventId 与真实 eventId 不冲突(真实 eventId 是 evt- 开头)
      expect(body).not.toMatch(/id: evt-/)
      // 携带 task 全量字段, drawer 拿到 detail 后能渲染 prompt / agentType / eventCount
      expect(body).toMatch(/"agentType":"dsh"/)
      expect(body).toMatch(/"agentType":"opencc"/)
      expect(body).toMatch(/"eventCount":200/)
    })

    test('?sid=A 连接不收到其它 sid 的 bg task (per-sid 隔离)', async () => {
      const sid = `bgstate-iso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const bg = makeFakeBg([
        { id: 'mine', parentSessionId: sid, agentType: 'opencc' },
        { id: 'theirs', parentSessionId: 'other-sid', agentType: 'opencc' },
      ])
      __setBackgroundRuntime(bg)

      const app = makeApp()
      const { body } = await captureSse(app, {
        sid,
        until: (b) => b.includes('event: server.connected'),
        timeoutMs: 200,
      })

      expect(body).toMatch(/"id":"mine"/)
      expect(body).not.toMatch(/"id":"theirs"/)
    })

    test('不带 sid (全量连接) 收到所有 bg task 的合成事件', async () => {
      const bg = makeFakeBg([
        { id: 'a', parentSessionId: 's1' },
        { id: 'b', parentSessionId: 's2' },
        { id: 'c', parentSessionId: null }, // session-less (老数据 / cli 派发)
      ])
      __setBackgroundRuntime(bg)

      const app = makeApp()
      const { body } = await captureSse(app, {
        until: (b) => b.includes('event: server.connected'),
        timeoutMs: 200,
      })

      expect(body).toMatch(/"id":"a"/)
      expect(body).toMatch(/"id":"b"/)
      expect(body).toMatch(/"id":"c"/)
    })

    test('synth 事件不被加进 eventBus history (走单独 push, 不污染后续连接)', async () => {
      const sid = `bgstate-no-pollute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const bg = makeFakeBg([
        { id: 'pp1', parentSessionId: sid, agentType: 'dsh', eventCount: 300 },
      ])
      __setBackgroundRuntime(bg)

      // 第一个连接触发 synth push
      const app = makeApp()
      await captureSse(app, {
        sid,
        until: (b) => b.includes('synth-bgstate-pp1'),
        timeoutMs: 200,
      })

      // 第二个连接不应再看到 synth 事件 (它不是 eventBus.emit 的)
      const { body } = await captureSse(app, {
        sid,
        until: (b) => b.includes('event: server.connected'),
        timeoutMs: 200,
      })
      // 第二次连接: synth 事件还会再触发一次 (因为它每次都从 bg.list 重新推),
      // 但 eventBus history 里不应残留 synth eventId / seq
      // 验证方法: 找第二份 body 里没有出现两次相同的 synth eventId
      const matches = body.match(/synth-bgstate-pp1/g) ?? []
      expect(matches.length).toBe(1) // 仅出现一次
    })

    test('bg runtime 未初始化时, 跳过 synth push 不报错 (兼容 dsh 模式)', async () => {
      // __resetBackgroundRuntimeForTests() 让 getBackgroundRuntime() 抛 'not initialized'
      __resetBackgroundRuntimeForTests()

      const app = makeApp()
      const { body } = await captureSse(app, {
        until: (b) => b.includes('event: server.connected'),
        timeoutMs: 200,
      })
      // 仍然能正常发 server.connected, 不因 synth push 失败而断开
      expect(body).toMatch(/event: server\.connected/)
      // 没有 synth 事件
      expect(body).not.toMatch(/synth-bgstate/)
    })
  })
})