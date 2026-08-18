import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { eventBus } from '../services/eventBus.js'
import { sessionInbox as realSessionInbox, type InboxMessage } from '../services/sessionInbox.js'

// 队列测试只需验证 /agent/prompt 的入队判定 + /agent/queue/cancel, 不跑真实
// queryLoop: getRuntime().query 挂起, 让第一条永远在跑, 后续 prompt 排队。

const hangingQuery = vi.fn()

const mockTranscriptStore = {
  read: vi.fn(),
  patch: vi.fn(async () => {}),
  list: vi.fn(async () => ({ sessions: [] })),
  append: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
}

vi.mock('../services/agentRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentRuntime.js')>()
  return {
    ...actual,
    getRuntime: () => ({ query: hangingQuery }),
    getTranscriptStore: () => mockTranscriptStore,
    registerSessionController: vi.fn(),
    releaseSessionController: vi.fn(),
    setCurrentSessionId: vi.fn(),
    getAskRegistry: () => ({ abortAll: vi.fn() }),
    getApproveRegistry: () => ({ abortAll: vi.fn() }),
    getPermissionRegistry: () => ({ abortAll: vi.fn() }),
    getCurrentSessionId: () => null,
    abortAgentSession: vi.fn(async () => {}),
    abortSessionController: () => false,
    listSkills: vi.fn(async () => ({ skills: [] })),
  }
})

vi.mock('@zn-ai/zn-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zn-ai/zn-agent-core')>()
  return {
    ...actual,
    runWithSessionId: (_sid: string, fn: () => unknown) => fn(),
    appendUserMessageV2: vi.fn(async () => {}),
    appendAssistantMessageV2: vi.fn(async () => {}),
    appendToolUse: vi.fn(async () => {}),
    appendToolResult: vi.fn(async () => {}),
  }
})

vi.mock('../lib/resolveModel.js', () => ({
  resolveModel: vi.fn(() => ({ model: 'MiniMax-M3', source: 'mock' })),
}))

import agentRouter from './agent.js'

async function* hangingEvents(): AsyncGenerator<never> {
  // 永不产出事件: queryLoop 卡在 for-await, sessionRunning 保持 true。
  await new Promise(() => {})
}

function buildApp(): express.Express {
  const app = express()
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'tmp' }
  app.use(express.json())
  app.use('/api', agentRouter)
  return app
}

describe('POST /agent/prompt — per-session 消息排队', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hangingQuery.mockImplementation(() => hangingEvents())
    mockTranscriptStore.read.mockResolvedValue({
      meta: { title: '', model: null, permissionMode: 'auto', cwd: '/tmp' },
      messages: [],
    })
  })

  it('空闲时 queued:false; 当前轮在跑时 queued:true 且 pending 含本条', async () => {
    const app = buildApp()
    const r1 = await request(app).post('/api/agent/prompt').send({ prompt: 'first' })
    expect(r1.status).toBe(200)
    expect(r1.body.sessionId).toBeDefined()
    expect(r1.body.queued).toBe(false)
    expect(r1.body.queueLength).toBe(0)

    // 第一条 queryLoop 已挂起, 第二条进入队列
    const sid = r1.body.sessionId
    const r2 = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'second', sessionId: sid })
    expect(r2.status).toBe(200)
    expect(r2.body.queued).toBe(true)
    expect(r2.body.queueLength).toBe(1)
    expect(r2.body.pending.some((p: { text: string }) => p.text === 'second')).toBe(true)
    // pending 里不含正在执行的第一条
    expect(r2.body.pending.some((p: { text: string }) => p.text === 'first')).toBe(false)
  })

  it('POST /agent/queue/cancel 移除排队命令, 重复取消返回 removed:false', async () => {
    const app = buildApp()
    const r1 = await request(app).post('/api/agent/prompt').send({ prompt: 'first' })
    const sid = r1.body.sessionId
    const r2 = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'second', sessionId: sid })
    const qid = r2.body.pending[0].id as string

    const cancel = await request(app)
      .post('/api/agent/queue/cancel')
      .send({ sessionId: sid, promptId: qid })
    expect(cancel.status).toBe(200)
    expect(cancel.body.removed).toBe(true)

    const cancel2 = await request(app)
      .post('/api/agent/queue/cancel')
      .send({ sessionId: sid, promptId: qid })
    expect(cancel2.body.removed).toBe(false)
  })

  it('缺少 sessionId/promptId 时返回 400', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/agent/queue/cancel').send({})
    expect(res.status).toBe(400)
  })

  it('PROBE: 跑完一条后, 排队的下一条自动 drain (FIFO 串行)', async () => {
    let callIdx = 0
    let releaseFirst!: () => void
    const releaseP = new Promise<void>((r) => {
      releaseFirst = r
    })
    hangingQuery.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        // 第一条 query: yield 一次让 for-await 进入 + sessionRunning=true,
        // 然后 await 一个外部信号 — 测试在 r2 入队后再放行, 确保 drain 时机
        // 可控. 一旦 releaseFirst() 被调, generator 结束 → for-await 退出 →
        // runQueryLoop finally → sessionRunning.delete → runNextInQueue(sid)
        // 递归调用消费队列里的第二条.
        return (async function* () {
          yield { type: 'noop' }
          await releaseP
        })()
      }
      // 后续 query 仍挂起, 让 session 保持 running 状态观察 drain 之后状态
      return hangingEvents()
    })

    const app = buildApp()
    const r1 = await request(app).post('/api/agent/prompt').send({ prompt: 'first' })
    expect(r1.body.queued).toBe(false)
    const sid = r1.body.sessionId

    const r2 = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'second', sessionId: sid })
    expect(r2.body.queued).toBe(true)
    expect(r2.body.queueLength).toBe(1)

    // 释放第一条 query, 触发 drain 启动第二条
    releaseFirst()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    // drain 已触发, 第二条被 runQueryLoop 消费 → hangingQuery 至少被调 2 次
    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(2)

    // 此时 sid 在 sessionRunning (第二条 hanging), 第三条应当 queued:true
    const r3 = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'third', sessionId: sid })
    expect(r3.body.queued).toBe(true)
    expect(r3.body.queueLength).toBe(1)
    expect(r3.body.pending.some((p: { text: string }) => p.text === 'third')).toBe(true)
  })
})

// ============================================================================
// LIVE: 真端口 + 真 fetch + eventBus 订阅
// 不走 supertest (in-process), 让 Express 监听 127.0.0.1:0 (自动选空闲端口),
// 用全局 fetch 走真 TCP。同时订阅 eventBus 抓 queue.changed 事件, 验证 SSE
// 契约 —— 入队、取消、drain 三个时刻都得正确 emit。
// ============================================================================
describe('LIVE: 真 HTTP 端口 + fetch + eventBus 观察 queue.changed', () => {
  let server: Server
  let baseUrl: string
  let queueEvents: { type: string; sessionId?: string; queueLength?: number; running?: boolean; pending?: { id: string; text: string }[] }[]
  let unsubscribe: () => void

  beforeEach(async () => {
    vi.clearAllMocks()
    hangingQuery.mockImplementation(() => hangingEvents())
    mockTranscriptStore.read.mockResolvedValue({
      meta: { title: '', model: null, permissionMode: 'auto', cwd: '/tmp' },
      messages: [],
    })

    queueEvents = []
    unsubscribe = eventBus.subscribe((e) => {
      if (e.type === 'queue.changed') queueEvents.push(e)
    })

    const app = buildApp()
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    unsubscribe()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  async function postPrompt(body: Record<string, unknown>): Promise<{
    status: number
    body: { sessionId?: string; queued?: boolean; queueLength?: number; pending?: { id: string; text: string }[] }
  }> {
    const res = await fetch(`${baseUrl}/api/agent/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  async function postCancel(body: Record<string, unknown>): Promise<{
    status: number
    body: { removed?: boolean; error?: string }
  }> {
    const res = await fetch(`${baseUrl}/api/agent/queue/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('入队 + drain 全链路 (真 TCP) — queue.changed 事件序列正确', async () => {
    let callIdx = 0
    let releaseFirst!: () => void
    const releaseP = new Promise<void>((r) => {
      releaseFirst = r
    })
    hangingQuery.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        return (async function* () {
          yield { type: 'noop' }
          await releaseP
        })()
      }
      return hangingEvents()
    })

    // 1) 第一条 — 立即启动
    const r1 = await postPrompt({ prompt: 'first' })
    expect(r1.status).toBe(200)
    expect(r1.body.queued).toBe(false)
    const sid = r1.body.sessionId!

    // 2) 第二条 — 入队
    const r2 = await postPrompt({ prompt: 'second', sessionId: sid })
    expect(r2.body.queued).toBe(true)
    expect(r2.body.queueLength).toBe(1)

    // 3) 等 microtask 刷, eventBus 应已收到本 sid 的两次 queue.changed
    //    (r1 入队时 emitQueueChanged; r2 入队时再 emitQueueChanged)
    await new Promise((r) => setImmediate(r))
    const sidEvents = queueEvents.filter((e) => e.sessionId === sid)
    expect(sidEvents.length).toBeGreaterThanOrEqual(2)
    // 第一条入队后: running=true, queueLength=0 (shift 已发生)
    expect(sidEvents[0].running).toBe(true)
    expect(sidEvents[0].queueLength).toBe(0)
    // 第二条入队后: running=true, queueLength=1
    expect(sidEvents.at(-1)!.running).toBe(true)
    expect(sidEvents.at(-1)!.queueLength).toBe(1)

    // 4) 释放第一条, 触发 drain
    releaseFirst()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    // 5) 第二条已被 runQueryLoop 消费 → hangingQuery 被调 2 次
    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(callIdx).toBe(2)

    // 6) drain 之后再 emit queue.changed: running=true, queueLength=0
    const lastBefore3 = queueEvents.filter((e) => e.sessionId === sid).at(-1)!
    expect(lastBefore3.running).toBe(true)
    expect(lastBefore3.queueLength).toBe(0)

    // 7) 第三条 — 第二条还在 hanging, 入队
    const r3 = await postPrompt({ prompt: 'third', sessionId: sid })
    expect(r3.body.queued).toBe(true)
    expect(r3.body.queueLength).toBe(1)
    expect(r3.body.pending!.some((p) => p.text === 'third')).toBe(true)
  })

  it('cancel 经真 TCP — 二次取消 idempotent', async () => {
    const r1 = await postPrompt({ prompt: 'first' })
    const sid = r1.body.sessionId!
    const r2 = await postPrompt({ prompt: 'second', sessionId: sid })
    const qid = r2.body.pending![0].id

    const c1 = await postCancel({ sessionId: sid, promptId: qid })
    expect(c1.status).toBe(200)
    expect(c1.body.removed).toBe(true)

    const c2 = await postCancel({ sessionId: sid, promptId: qid })
    expect(c2.status).toBe(200)
    expect(c2.body.removed).toBe(false)

    // cancel 也走 emitQueueChanged: 取消后 queueLength=0
    const lastCancelEvent = queueEvents.filter((e) => e.sessionId === sid).at(-1)!
    expect(lastCancelEvent.queueLength).toBe(0)
    expect(lastCancelEvent.running).toBe(true)
  })

  it('真端口缺失参数 → 400', async () => {
    const res = await postCancel({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/missing/)
  })

  it('取消不存在的 promptId (但 sessionId 合法) → removed:false', async () => {
    const r1 = await postPrompt({ prompt: 'first' })
    const sid = r1.body.sessionId!
    const r2 = await postPrompt({ prompt: 'second', sessionId: sid })
    expect(r2.body.queueLength).toBe(1)

    const cancel = await postCancel({ sessionId: sid, promptId: 'queue-bogus-id' })
    expect(cancel.status).toBe(200)
    expect(cancel.body.removed).toBe(false)

    // 队列长度不受影响 (idx === -1 分支不 splice)
    const r3 = await postPrompt({ prompt: 'third', sessionId: sid })
    expect(r3.body.queueLength).toBe(2)
  })

  it('取消从未提交过 prompt 的 sessionId → removed:false (走 !q 分支)', async () => {
    const cancel = await postCancel({
      sessionId: '00000000-0000-0000-0000-000000000000',
      promptId: 'queue-anything',
    })
    expect(cancel.status).toBe(200)
    expect(cancel.body.removed).toBe(false)
  })

  it('跨 sessionId 隔离: A 在跑, B 的 prompt 不被排队 (独立 running + queue)', async () => {
    const rA1 = await postPrompt({ prompt: 'a-first' })
    const sidA = rA1.body.sessionId!
    expect(rA1.body.queued).toBe(false)

    // 同一时刻向另一个 session 发 prompt — 应当也立即启动, 不入队
    const rB1 = await postPrompt({ prompt: 'b-first' })
    const sidB = rB1.body.sessionId!
    expect(rB1.body.queued).toBe(false)
    expect(sidB).not.toBe(sidA)

    // 各自独立加第二条 — 都应该入队 (各自的 sessionRunning 独立)
    const rA2 = await postPrompt({ prompt: 'a-second', sessionId: sidA })
    expect(rA2.body.queued).toBe(true)
    expect(rA2.body.queueLength).toBe(1)

    const rB2 = await postPrompt({ prompt: 'b-second', sessionId: sidB })
    expect(rB2.body.queued).toBe(true)
    expect(rB2.body.queueLength).toBe(1)

    // 互不污染: 取消 A 的 queued prompt, B 的队列不应受影响
    const qidA = rA2.body.pending![0].id
    const cancelA = await postCancel({ sessionId: sidA, promptId: qidA })
    expect(cancelA.body.removed).toBe(true)

    const rB3 = await postPrompt({ prompt: 'b-third', sessionId: sidB })
    expect(rB3.body.queueLength).toBe(2) // B 自己的队列仍是 2
  })

  it('running query 抛异常 → 队列仍 drain (可靠性: 不让单条 crash 阻断后续)', async () => {
    let callIdx = 0
    let releaseFirst!: () => void
    const releaseP = new Promise<void>((r) => {
      releaseFirst = r
    })
    hangingQuery.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        // 第一条 query: yield 一次让 for-await 进入 + sessionRunning=true,
        // 然后 await 一个外部信号 — 测试在 r2 入队后再放行, 让 throw 时机
        // 可控. 释放后 generator 抛 → runQueryLoop 的 catch 走 runtime.error
        // emit + finally 清理 → runNextInQueue 的 finally 仍 delete
        // sessionRunning + 递归 drain 启动第二条.
        return (async function* () {
          yield { type: 'noop' }
          await releaseP
          throw new Error('simulated upstream crash')
        })()
      }
      return hangingEvents()
    })

    const r1 = await postPrompt({ prompt: 'first' })
    expect(r1.body.queued).toBe(false)
    const sid = r1.body.sessionId!

    const r2 = await postPrompt({ prompt: 'second', sessionId: sid })
    expect(r2.body.queued).toBe(true)
    expect(r2.body.queueLength).toBe(1)

    // 触发第一条 throw + drain
    releaseFirst()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    // 关键断言: 第二条已被消费 (异常没有阻断 drain)
    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(callIdx).toBe(2)

    // 第三条继续入队 (第二条 hanging 中)
    const r3 = await postPrompt({ prompt: 'third', sessionId: sid })
    expect(r3.body.queued).toBe(true)
  })

  it('FIFO 顺序: pending 数组按提交顺序排列 (5 条排队)', async () => {
    // drain 串行消费的次序由 sessionQueues.shift() (FIFO) 保证;
    // 这里只验证 pending 快照的顺序 — 实际 drain 顺序在 runNextInQueue 里
    // 是从队首 shift, 等价于 pending 列表从前往后消费。
    let releaseFirst!: () => void
    const releaseP = new Promise<void>((r) => {
      releaseFirst = r
    })
    let callIdx = 0
    hangingQuery.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        return (async function* () {
          yield { type: 'noop' }
          await releaseP
        })()
      }
      return hangingEvents()
    })

    const app = buildApp()
    const r1 = await postPrompt({ prompt: 'first' })
    const sid = r1.body.sessionId!

    const queuedTexts = ['second', 'third', 'fourth', 'fifth']
    for (const text of queuedTexts) {
      const r = await postPrompt({ prompt: text, sessionId: sid })
      expect(r.body.queued).toBe(true)
    }

    // 探针 prompt — 入队后用 response 看完整 pending 顺序
    const probeRes = await postPrompt({ prompt: 'probe', sessionId: sid })
    expect(probeRes.body.queued).toBe(true)
    expect(probeRes.body.queueLength).toBe(5) // second + third + fourth + fifth + probe
    expect((probeRes.body.pending ?? []).map((p) => p.text)).toEqual([
      'second',
      'third',
      'fourth',
      'fifth',
      'probe',
    ])

    // 释放第一条 → drain 启动第二条 (至少证明 FIFO drain 触发了, 第二条已被消费)
    releaseFirst()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    expect(callIdx).toBe(2) // first 跑完 + second 已被消费 (FIFO 顺序的最小验证)
  })
})

// ============================================================================
// INBOX: runNextInQueue 双队列消费 + 并发守卫
// ============================================================================
// runNextInQueue 消费顺序 = HTTP 用户 prompt > inbox next-turn。turn 结束
// finally 消费 next-step 合并为下一条 prompt;inbox 注册为 wake handler。
// 复用上面真 TCP 基建 + eventBus 观察 runtime.started 事件序列。
function inboxMsg(id: string, content: string): InboxMessage {
  return {
    id,
    source: { kind: 'subagent', form: 'notice', senderSessionId: 'sess-test' },
    content,
    createdAt: Date.now(),
  }
}

describe('INBOX: runNextInQueue 消费', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hangingQuery.mockImplementation(() => hangingEvents())
    mockTranscriptStore.read.mockResolvedValue({
      meta: { title: '', model: null, permissionMode: 'auto', cwd: '/tmp' },
      messages: [],
    })
    // 清空 inbox,防上一组测试残留
    while (realSessionInbox.consumeNextStep('sess-test')?.length ?? 0 > 0) {
      realSessionInbox.consumeNextStep('sess-test')
    }
    realSessionInbox.consumeNextTurn('sess-test')
  })

  it('inbox next-turn 在无 HTTP 队列时被消费为一条 prompt', async () => {
    let release!: () => void
    const releaseP = new Promise<void>((r) => {
      release = r
    })
    hangingQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: 'noop' }
        await releaseP
      })()
    })

    // 没有任何 HTTP prompt — 直接 inbox.followup
    realSessionInbox.followup('sess-test', inboxMsg('inbox-1', 'inbox content'))

    // waitForMicrotasks 让 wake handler → runNextInQueue → runQueryLoop 链路完成
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    // 第一条 query 是 inbox 消费的内容 (而非空)
    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(1)
    const firstArgs = hangingQuery.mock.calls[0]?.[0] as { prompt?: string }
    expect(firstArgs.prompt).toBe('inbox content')

    // 清理:释放让 query 结束
    release()
    await new Promise((r) => setImmediate(r))
  })

  it('HTTP prompt 优先于 inbox next-turn', async () => {
    let release!: () => void
    const releaseP = new Promise<void>((r) => {
      release = r
    })
    hangingQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: 'noop' }
        await releaseP
      })()
    })

    const app = buildApp()
    // 1) inbox 先入 next-turn
    realSessionInbox.followup('sess-test', inboxMsg('inbox-A', 'from inbox'))

    // 2) wake handler 触发 runNextInQueue;但同时我们立刻经 HTTP 入队,
    //    这条 HTTP 应排在 inbox-A 之后 — 因为 HTTP 入队时 inbox 已经被
    //    consumeNextTurn 取走作为本轮 prompt,而 HTTP push 落在 sessionQueues
    //    作为下一轮 FIFO 队首。
    // 注意:由于 wake handler 同步触发,这里 HTTP POST 可能在 inbox-A 被消费
    // 之前到达 — 但 HTTP 的 wasIdle 判定 `!running && queue.length===0`,
    // 当 inbox-A 已 wake 触发 runNextInQueue 进入同步段(sessionRunning.add)
    // 后, HTTP 入队就走 queued:true.
    const r1 = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'from http', sessionId: 'sess-test' })

    // HTTP 入队:若 inbox wake 抢了 runNextInQueue 入口,HTTP 应当 queued:true
    // (因为本轮 prompt 是 inbox-A)。否则 wasIdle=true 且 HTTP 立即启动。
    // 两种情况下 HTTP 都在 inbox-A 之后消费 — 我们只需要证明"HTTP 排在 inbox 之后"。
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    // 第一轮一定是 inbox (HTTP 总是后入队)
    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(1)
    const firstArgs = hangingQuery.mock.calls[0]?.[0] as { prompt?: string }
    expect(firstArgs.prompt).toBe('from inbox')

    // 释放 inbox turn, finally drain 应该消费 HTTP 那条 (queued=true 路径)
    release()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(2)
    const secondArgs = hangingQuery.mock.calls[1]?.[0] as { prompt?: string }
    expect(secondArgs.prompt).toBe('from http')

    // cleanup
    if (r1.status === 200) {
      // 让第二个 query 也结束 — 第二个是 hangingEvents 不需要 release
    }
  })

  it('turn 结束后 next-step 合并为下一条 prompt', async () => {
    let release!: () => void
    const releaseP = new Promise<void>((r) => {
      release = r
    })
    let callIdx = 0
    hangingQuery.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        return (async function* () {
          yield { type: 'noop' }
          await releaseP
        })()
      }
      return hangingEvents()
    })

    // 第一条 inbox 在 idle 状态下走 next-turn (唤醒 + 立即消费)
    realSessionInbox.followup('sess-test', inboxMsg('inbox-step-1', 'step1 content'))
    // 等第一条 turn 进入 setBusy 状态 (微任务跑完)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))
    expect(realSessionInbox.isBusy('sess-test')).toBe(true)
    // 第二条 inbox 在 busy 状态下自动降级到 next-step (不唤醒)
    realSessionInbox.followup('sess-test', inboxMsg('inbox-step-2', 'step2 content'))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(1)
    const firstArgs = hangingQuery.mock.calls[0]?.[0] as { prompt?: string }
    expect(firstArgs.prompt).toBe('step1 content')

    // 释放第一条 → finally consumeNextStep → 合并为下一条 prompt
    release()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    expect(callIdx).toBe(2)
    const secondArgs = hangingQuery.mock.calls[1]?.[0] as { prompt?: string }
    // 合并: next-step lane 含一条 'step2 content', 应该作为第二条 prompt
    expect(secondArgs.prompt).toBe('step2 content')
  })
})

describe('INBOX: 并发守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hangingQuery.mockImplementation(() => hangingEvents())
    mockTranscriptStore.read.mockResolvedValue({
      meta: { title: '', model: null, permissionMode: 'auto', cwd: '/tmp' },
      messages: [],
    })
    while (realSessionInbox.consumeNextStep('sess-race')?.length ?? 0 > 0) {
      realSessionInbox.consumeNextStep('sess-race')
    }
    realSessionInbox.consumeNextTurn('sess-race')
  })

  it('同一 tick 两次 followup 只起单 turn,第二条作为下一轮消费', async () => {
    let release!: () => void
    const releaseP = new Promise<void>((r) => {
      release = r
    })
    let callIdx = 0
    hangingQuery.mockImplementation(() => {
      callIdx++
      if (callIdx === 1) {
        return (async function* () {
          yield { type: 'noop' }
          await releaseP
        })()
      }
      return hangingEvents()
    })

    // 同一 tick 两次 followup — 第二条应当被 sessionRunning.has 拦截,
    // 进入 next-turn lane,作为第二轮消费。
    realSessionInbox.followup('sess-race', inboxMsg('msgA', 'A content'))
    realSessionInbox.followup('sess-race', inboxMsg('msgB', 'B content'))

    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    // 关键断言:本 sid 只起了一个 query turn
    expect(callIdx).toBe(1)
    const firstArgs = hangingQuery.mock.calls[0]?.[0] as { prompt?: string }
    expect(firstArgs.prompt).toBe('A content')

    // 释放第一条 → finally drain 消费第二条 (next-turn lane 里)
    release()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 20))

    expect(callIdx).toBe(2)
    const secondArgs = hangingQuery.mock.calls[1]?.[0] as { prompt?: string }
    expect(secondArgs.prompt).toBe('B content')
  })
})
