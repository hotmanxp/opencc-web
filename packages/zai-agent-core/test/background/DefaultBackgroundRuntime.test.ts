import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
} from '../../src/runtime/background/index.js'
import type {
  BackgroundRuntime,
} from '../../src/runtime/background/index.js'
import type { AgentRuntime } from '../../src/runtime/contract.js'
import type { RuntimeEvent } from '../../src/runtime/events.js'

let tmpDir: string
let activeRuntime: DefaultBackgroundRuntime | null = null

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-bgruntime-'))
})

afterEach(async () => {
  // 先强制关闭 runtime,确保 background runOne 不再追加 event 文件,清理目录才不冲突。
  if (activeRuntime) {
    await activeRuntime.shutdown().catch(() => {})
    activeRuntime = null
  }
  await rm(tmpDir, { recursive: true, force: true })
})

interface RunController {
  yield: (ev: RuntimeEvent) => void
  finish: () => void
  abort: () => void
  /**
   * 让当前 generator 立刻抛出指定 error（模拟 modelCaller 抛 APIError）.
   * BackgroundRuntime 应当 catch 后按 classifyRetryableError 决策.
   */
  throwError: (err: unknown) => void
}

/**
 * 构造一个 AgentRuntime mock,允许测试控制事件流的时机和中止信号.
 * 也支持让 generator 抛错（模拟上游 LLM SDK 抛 APIError）.
 */
function makeMockAgent(): {
  runtime: AgentRuntime
  controllers: RunController[]
} {
  const controllers: RunController[] = []
  const runtime: AgentRuntime = {
    run() {
      const queue: RuntimeEvent[] = []
      let resolveNext: (() => void) | null = null
      let aborted = false
      let finished = false
      let pendingThrow: unknown = null

      const ctrl: RunController = {
        yield: (ev) => {
          queue.push(ev)
          resolveNext?.()
          resolveNext = null
        },
        finish: () => {
          finished = true
          resolveNext?.()
          resolveNext = null
        },
        abort: () => {
          aborted = true
          resolveNext?.()
          resolveNext = null
        },
        throwError: (err) => {
          pendingThrow = err
          resolveNext?.()
          resolveNext = null
        },
      }
      controllers.push(ctrl)

      async function* gen() {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!
          }
          if (pendingThrow !== null) {
            const e = pendingThrow
            pendingThrow = null
            throw e
          }
          if (aborted || finished) return
          await new Promise<void>((r) => {
            resolveNext = r
          })
        }
      }

      return gen()
    },
    async abort() {},
    async listSessions() {
      return []
    },
    async readSession() {
      throw new Error('not used')
    },
    async patchSession() {},
    async removeSession() {},
  }
  return { runtime, controllers }
}

function makeRuntime(maxConcurrent = 4): {
  runtime: DefaultBackgroundRuntime
  store: JsonTaskStore
  mock: ReturnType<typeof makeMockAgent>
} {
  const store = new JsonTaskStore(tmpDir)
  const mock = makeMockAgent()
  const runtime = new DefaultBackgroundRuntime({
    agentRuntime: mock.runtime,
    store,
    maxConcurrent,
    shutdownTimeoutMs: 200,
  })
  activeRuntime = runtime
  return { runtime, store, mock }
}

describe('DefaultBackgroundRuntime.dispatch', () => {
  test('creates queued task persisted to disk', async () => {
    const { runtime } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'hello' })
    expect(task.status).toBe('queued')
    expect(task.id).toHaveLength(12)
    expect(await runtime.get(task.id)).not.toBeNull()
  })
})

describe('DefaultBackgroundRuntime concurrency', () => {
  test('never exceeds maxConcurrent active tasks', async () => {
    const { runtime, mock } = makeRuntime(2)
    const dispatched = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runtime.dispatch({ prompt: `p${i}` }),
      ),
    )
    // Wait a tick for scheduling
    await new Promise((r) => setTimeout(r, 10))
    expect(mock.controllers.length).toBeLessThanOrEqual(2)
    // Finish all
    finishAll(mock)
    await runtime.shutdown()
    expect(dispatched).toHaveLength(6)
  })
})

describe('DefaultBackgroundRuntime cancel', () => {
  test('cancels a running task and persists cancelled status', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'long' })
    // wait for the controller to appear
    while (mock.controllers.length === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const ctrl = mock.controllers[0]
    ctrl.yield({
      eventId: 'e1',
      sessionId: 's1',
      ts: 1,
      turnIndex: 0,
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'partial' },
    })
    const result = await runtime.cancel(task.id)
    expect(result.ok).toBe(true)
    ctrl.abort() // release the generator
    // Wait for status update
    for (let i = 0; i < 50; i++) {
      const t = await runtime.get(task.id)
      if (t && t.status === 'cancelled') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const final = await runtime.get(task.id)
    expect(final?.status).toBe('cancelled')
  })
})

describe('DefaultBackgroundRuntime events', () => {
  test('replays history and stops for terminal tasks', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })
    while (mock.controllers.length === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const ctrl = mock.controllers[0]
    ctrl.yield({
      eventId: 'e1',
      sessionId: 's1',
      ts: 1,
      turnIndex: 0,
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'a' },
    })
    ctrl.yield({
      eventId: 'e2',
      sessionId: 's1',
      ts: 2,
      turnIndex: 0,
      type: 'runtime.done',
      text: 'done',
    })
    ctrl.finish()
    // Wait for terminal
    for (let i = 0; i < 50; i++) {
      const t = await runtime.get(task.id)
      if (t && t.status === 'completed') break
      await new Promise((r) => setTimeout(r, 20))
    }

    // Replay from beginning
    const events = []
    for await (const ev of runtime.events(task.id)) events.push(ev)
    expect(events).toHaveLength(2)
    expect(events[0].seq).toBe(1)
    expect(events[1].type).toBe('runtime.done')
  })

  test('fromSeq skips history', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })
    while (mock.controllers.length === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const ctrl = mock.controllers[0]
    for (let i = 1; i <= 3; i++) {
      ctrl.yield({
        eventId: `e${i}`,
        sessionId: 's1',
        ts: i,
        turnIndex: 0,
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: String(i) },
      })
    }
    ctrl.finish()
    for (let i = 0; i < 50; i++) {
      const t = await runtime.get(task.id)
      if (t && t.status === 'completed') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const events = []
    for await (const ev of runtime.events(task.id, 2)) events.push(ev)
    expect(events.map((e) => e.seq)).toEqual([3])
  })

  test('live-tail: subscribe and receive new events before completion', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })
    while (mock.controllers.length === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const ctrl = mock.controllers[0]
    const ac = new AbortController()
    const collected: number[] = []
    const consumer = (async () => {
      for await (const ev of runtime.events(task.id, 0, ac.signal)) {
        collected.push(ev.seq)
        if (collected.length >= 2) {
          ac.abort()
          break
        }
      }
    })()

    // give consumer time to subscribe
    await new Promise((r) => setTimeout(r, 20))
    ctrl.yield({
      eventId: 'e1',
      sessionId: 's1',
      ts: 1,
      turnIndex: 0,
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'a' },
    })
    ctrl.yield({
      eventId: 'e2',
      sessionId: 's1',
      ts: 2,
      turnIndex: 0,
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'b' },
    })
    await consumer
    expect(collected).toEqual([1, 2])
    // 释放 generator,让 runOne 干净退出
    ctrl.finish()
    // 等 runOne 退出(处理 store.save)
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('DefaultBackgroundRuntime.shutdown', () => {
  test('aborts running tasks after timeout', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })
    while (mock.controllers.length === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    // shutdown without finishing → should call abort() on controller
    await runtime.shutdown()
    const final = await runtime.get(task.id)
    expect(final?.status).toBe('cancelled')
  })
})

/** 所有 mock controller 都 finish,确保 generator 干净退出。 */
function finishAll(mock: ReturnType<typeof makeMockAgent>) {
  for (const c of mock.controllers) c.finish()
}

/**
 * 在 retry 测试中临时把 baseDelayMs 压到 1ms，避免 10 次重试 * 指数退避等到天荒地老。
 * afterEach 里通过 restoreRetryPolicy 恢复.
 */
import { RETRY_POLICY } from '../../src/runtime/background/retryPolicy.js'

const savedBaseDelay = RETRY_POLICY.baseDelayMs
const savedMaxDelay = RETRY_POLICY.maxDelayMs
function fastRetryPolicy() {
  ;(RETRY_POLICY as { baseDelayMs: number }).baseDelayMs = 1
  ;(RETRY_POLICY as { maxDelayMs: number }).maxDelayMs = 1
}
function restoreRetryPolicy() {
  ;(RETRY_POLICY as { baseDelayMs: number }).baseDelayMs = savedBaseDelay
  ;(RETRY_POLICY as { maxDelayMs: number }).maxDelayMs = savedMaxDelay
}

/** 模拟 Anthropic SDK APIError(status=529, message=...) */
function make529Error() {
  const err = new Error(
    '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
  ) as Error & { status: number }
  err.status = 529
  return err
}

/** 模拟 Anthropic SDK APIError(status=503) */
function make503Error() {
  const err = new Error('service unavailable') as Error & { status: number }
  err.status = 503
  return err
}

/** 模拟 Anthropic SDK APIError(status=401) */
function make401Error() {
  const err = new Error('unauthorized') as Error & { status: number }
  err.status = 401
  return err
}

/** 模拟 Anthropic SDK APIError(status=429, message='limit: 0') */
function make429QuotaError() {
  const err = new Error('limit: 0 for current plan') as Error & {
    status: number
  }
  err.status = 429
  return err
}

/** 等待 task 进入指定 status */
async function waitForStatus(
  runtime: DefaultBackgroundRuntime,
  id: string,
  target: string,
  timeoutMs = 2000,
): Promise<void> {
  for (let i = 0; i < timeoutMs / 10; i++) {
    const t = await runtime.get(id)
    if (t && t.status === target) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for task ${id} to reach status=${target}`)
}

/** 等待第 N 个 controller 创建出来（用于串行触发每轮 attempt 的 throw/yield） */
async function waitForController(
  mock: ReturnType<typeof makeMockAgent>,
  index: number,
  timeoutMs = 5000,
): Promise<void> {
  for (let i = 0; i < timeoutMs / 5; i++) {
    if (mock.controllers.length > index) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for controller[${index}]`)
}

describe('DefaultBackgroundRuntime retry — 529 overloaded', () => {
  beforeEach(() => fastRetryPolicy())
  afterEach(() => restoreRetryPolicy())

  test('529 → 3 retries → 4th attempt success', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    // attempt 1: 抛 529
    await waitForController(mock, 0)
    mock.controllers[0]!.throwError(make529Error())

    // attempt 2: 抛 529
    await waitForController(mock, 1)
    mock.controllers[1]!.throwError(make529Error())

    // attempt 3: 抛 529
    await waitForController(mock, 2)
    mock.controllers[2]!.throwError(make529Error())

    // attempt 4: 成功
    await waitForController(mock, 3)
    mock.controllers[3]!.yield({
      eventId: 'e1',
      sessionId: 's1',
      ts: 1,
      turnIndex: 0,
      type: 'runtime.done',
      text: 'ok',
    })
    mock.controllers[3]!.finish()

    await waitForStatus(runtime, task.id, 'completed')
    const final = await runtime.get(task.id)
    expect(final?.attemptCount).toBe(4)
    expect(final?.error).toBeUndefined()
  })

  test('529 exhausted → status=failed, attemptCount=4, category=llm_provider_overloaded', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    // 串行触发 4 次 throw: 每次等 BackgroundRuntime 创建下一个 controller.
    for (let i = 0; i < 4; i++) {
      await waitForController(mock, i)
      mock.controllers[i]!.throwError(make529Error())
    }

    await waitForStatus(runtime, task.id, 'failed')
    const final = await runtime.get(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.attemptCount).toBe(4)
    expect(final?.error?.attempt).toBe(4)
    expect(final?.error?.category).toBe('llm_provider_overloaded')
  })
})

describe('DefaultBackgroundRuntime retry — 429 quota-exhausted', () => {
  beforeEach(() => fastRetryPolicy())
  afterEach(() => restoreRetryPolicy())

  test('429 quota-exhausted → no retry, status=failed immediately', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    await waitForController(mock, 0)
    mock.controllers[0]!.throwError(make429QuotaError())

    await waitForStatus(runtime, task.id, 'failed')
    const final = await runtime.get(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.attemptCount).toBe(1)
    expect(final?.error?.category).toBe('internal')
    // 等一小段时间确保 retry loop 不会启动
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.controllers.length).toBe(1)
  })
})

describe('DefaultBackgroundRuntime retry — 5xx server', () => {
  beforeEach(() => fastRetryPolicy())
  afterEach(() => restoreRetryPolicy())

  test('5xx → retries up to maxRetries (10) then fails', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    // 首次 + 10 次重试 = 11 次
    for (let i = 0; i < 11; i++) {
      await waitForController(mock, i)
      mock.controllers[i]!.throwError(make503Error())
    }

    await waitForStatus(runtime, task.id, 'failed', 10_000)
    const final = await runtime.get(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.attemptCount).toBe(11)
    expect(final?.error?.attempt).toBe(11)
    expect(final?.error?.category).toBe('llm_provider_server')
  })
})

describe('DefaultBackgroundRuntime retry — non-retryable', () => {
  beforeEach(() => fastRetryPolicy())
  afterEach(() => restoreRetryPolicy())

  test('401 auth → no retry, status=failed immediately', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    await waitForController(mock, 0)
    mock.controllers[0]!.throwError(make401Error())

    await waitForStatus(runtime, task.id, 'failed')
    const final = await runtime.get(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.attemptCount).toBe(1)
    expect(final?.error?.category).toBe('llm_provider_auth')
  })
})

describe('DefaultBackgroundRuntime retry — connection error', () => {
  beforeEach(() => fastRetryPolicy())
  afterEach(() => restoreRetryPolicy())

  test('fetch failed → retryable', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    await waitForController(mock, 0)
    mock.controllers[0]!.throwError(new Error('fetch failed'))

    await waitForController(mock, 1)
    mock.controllers[1]!.yield({
      eventId: 'e1',
      sessionId: 's1',
      ts: 1,
      turnIndex: 0,
      type: 'runtime.done',
      text: 'recovered',
    })
    mock.controllers[1]!.finish()

    await waitForStatus(runtime, task.id, 'completed')
    const final = await runtime.get(task.id)
    expect(final?.attemptCount).toBe(2)
  })
})

describe('DefaultBackgroundRuntime retry — cancel mid-retry', () => {
  beforeEach(() => fastRetryPolicy())
  afterEach(() => restoreRetryPolicy())

  test('cancel during backoff → status=cancelled, no further retry', async () => {
    const { runtime, mock } = makeRuntime()
    const task = await runtime.dispatch({ prompt: 'p' })

    await waitForController(mock, 0)
    // attempt 1: 抛 529，触发 backoff + retry
    mock.controllers[0]!.throwError(make529Error())

    // 等待 attempt 2 启动 → ctrl1 出现（说明 backoff 已结束）
    await waitForController(mock, 1)

    // 在 attempt 2 期间 cancel
    await runtime.cancel(task.id)
    mock.controllers[1]!.abort() // 释放 generator

    await waitForStatus(runtime, task.id, 'cancelled')
    // 等一会确保不会再启动 attempt 3
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.controllers.length).toBeLessThanOrEqual(2)
  })
})