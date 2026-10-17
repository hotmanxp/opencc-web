/**
 * 回归测试 — 已删会话不得再被队列车道拉起新 turn (wb-011)。
 *
 * 缺陷(残留项):`runNextInQueue` 的 `finally`(`routes/agent.ts:1062`)无条件
 * `void runNextInQueue(sid)`。会话被 DELETE 后,正在跑的那一轮照样走完
 * finally,车道于是**再拉起一轮完整 LLM 调用**去消费队列里的排队消息。
 *
 * 复活路径本身已经被 `isSessionDeleted` 双层守卫挡住
 * (`sessionFacade-impl.ts:278/291` 的 append/patchSession,
 *  `sessionStorage.ts:1783` 的 appendEntry),所以**磁盘上不会复活** ——
 * 这一条剩下的唯一后果就是烧一次 token。已知条目 #11 的文档自己就把
 * 「runNextInQueue 需加守卫」列为第二道防线待办,这里是它的未完成尾巴。
 *
 * 修法:DELETE 在 arm `markSessionDeleted`(core,写端守卫)的同时,把 sid
 * 记进本模块的 `deletedSessions` 并清掉它的排队车道;`runNextInQueue` 入口
 * 查一次。两处 arm 点同在 DELETE 路由,不存在「一个走全局、一个走 ALS」
 * 的分裂。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const hangingQuery = vi.fn()

const mockTranscriptStore = {
  read: vi.fn(),
  patch: vi.fn(async () => {}),
  list: vi.fn(async () => ({ sessions: [] })),
  append: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => true),
}

vi.mock('../../src/server/services/agentRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/services/agentRuntime.js')>()
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
    // DELETE 会调它;返回 false 表示"没有 controller 可中断",让测试自己
    // 控制 queryLoop 的结束时机(否则 DELETE 后的时序不可测)。
    abortSessionController: () => false,
    listSkills: vi.fn(async () => []),
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

vi.mock('../../src/lib/resolveModel.js', () => ({
  resolveModel: vi.fn(() => ({ model: 'MiniMax-M3', source: 'mock' })),
}))

import agentRouter, {
  __clearSessionRunningForTests,
  __resetSessionRunningForTests,
} from '../../src/server/routes/agent.js'

async function* hangingEvents(): AsyncGenerator<never> {
  await new Promise(() => {})
}

function buildApp(): express.Express {
  const app = express()
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'tmp' }
  app.use(express.json())
  app.use('/api', agentRouter)
  return app
}

/** 等若干帧,让 fire-and-forget 的 finally → runNextInQueue 有机会跑。 */
async function settle(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('wb-011: 已删会话不得再被队列车道拉起新 turn', () => {
  let sid = ''

  beforeEach(() => {
    vi.clearAllMocks()
    __resetSessionRunningForTests()
    mockTranscriptStore.read.mockResolvedValue({
      meta: { title: '', model: null, permissionMode: 'auto', cwd: '/tmp' },
      messages: [],
    })
    hangingQuery.mockImplementation(() => hangingEvents())
    sid = ''
  })

  afterEach(() => {
    if (sid) __clearSessionRunningForTests(sid)
    __resetSessionRunningForTests()
  })

  it('会话删除后,正在跑的那轮走完 finally 不得再起第二轮 LLM 调用', async () => {
    // 第一轮挂起, 第二轮进队列 —— 与 agent.queue.test.ts 的 FIFO 场景同构。
    let releaseFirst!: () => void
    const releaseP = new Promise<void>((r) => { releaseFirst = r })
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
    const r1 = await request(app).post('/api/agent/prompt').send({ prompt: 'first' })
    expect(r1.status).toBe(200)
    sid = r1.body.sessionId
    const r2 = await request(app).post('/api/agent/prompt').send({ prompt: 'second', sessionId: sid })
    expect(r2.body.queued).toBe(true)
    expect(r2.body.queueLength).toBe(1)

    await settle()
    expect(hangingQuery.mock.calls.length).toBe(1)

    // 真 DELETE 路由:arm markSessionDeleted(core 写端守卫)+ 记 sid + 清车道。
    const del = await request(app).delete(`/api/agent/sessions/${sid}`)
    expect(del.status).toBe(200)
    expect(mockTranscriptStore.remove).toHaveBeenCalled()

    // 放行第一轮 → for-await 退出 → runQueryLoop finally →
    // `void runNextInQueue(sid)`(routes/agent.ts:1062)
    releaseFirst()
    await settle()

    // 判据:不再有第二次 LLM 调用。修复前这里会是 2。
    expect(hangingQuery.mock.calls.length).toBe(1)
  })

  it('未删除的会话照常 drain(守卫不能误杀正常队列)', async () => {
    let releaseFirst!: () => void
    const releaseP = new Promise<void>((r) => { releaseFirst = r })
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
    const r1 = await request(app).post('/api/agent/prompt').send({ prompt: 'first' })
    sid = r1.body.sessionId
    await request(app).post('/api/agent/prompt').send({ prompt: 'second', sessionId: sid })
    await settle()

    releaseFirst()
    await settle(150)

    // 未删除 → 第二轮必须照常起来(否则这条守卫把功能改没了)
    expect(hangingQuery.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
