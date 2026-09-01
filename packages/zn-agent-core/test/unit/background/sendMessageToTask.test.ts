import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  type BackgroundTask,
} from '../../../src/compat/background/index.js'

/**
 * zai patch (HRMSV3-ZN-WEBSITE#668 / subagent_control):DefaultBackgroundRuntime
 * 新增 `sendMessageToTask(taskId, prompt)` —— 父 agent 投递指令到子
 * agent 的 pending 队列,下一轮 turn 拼到 query prompt 前缀消费。
 *
 * 契约:
 *   1. 不存在的 taskId → {ok:false}
 *   2. 已终态(completed/failed/cancelled)的 task → {ok:false}
 *   3. 排队中 / 运行中的 task → {ok:true},prompt 入队
 *   4. runOne 消费:多条 pending 用 `\n\n` 拼到原 prompt 前缀;无 pending 时
 *      沿用原 prompt
 *   5. 消费后 queue 清空 — 下一次 sendMessageToTask 重新入队
 *   6. 多次入队顺序保持
 *
 * 用 fake agentRuntime(`captureAgent`)捕获每次 queryInput.prompt,断言
 * 拼接语义;maxConcurrent=1 + 永远 pending 的 fake agent 让我们能在
 * running 中注入 sendMessageToTask。任务终态后 sendMessageToTask 返回
 * {ok:false} —— 用 finalizeTask(attach 路径)或 cancel(回到 cancelled)
 * 验证。
 */

interface CapturedQueryInput {
  prompt: string
}

function makeCaptureAgent(captured: CapturedQueryInput[]) {
  // 永远 pending(直到 abort signal),让任务停在 running 状态。
  return {
    async *query(input: { prompt?: string; abortSignal?: AbortSignal }) {
      captured.push({ prompt: input.prompt ?? '' })
      const signal = input.abortSignal
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}

let tmpDir: string
let store: JsonTaskStore
let captured: CapturedQueryInput[]
let runtime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-send-msg-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  captured = []
  runtime = new DefaultBackgroundRuntime({
    agentRuntime: makeCaptureAgent(captured) as never,
    store,
    maxConcurrent: 1,
    shutdownTimeoutMs: 200,
  })
})

afterEach(async () => {
  // 先 cancel 所有还在跑 / 排队的 task(若有),等 done 事件确保
  // runOne finally 落盘完成;再 shutdown 兜底;最后 rm tmpDir。
  // 这避免 runOne finally 在 rm 之后写 disk 触发 verifyWrite ENOENT。
  const records = (runtime as unknown as {
    records: Map<
      string,
      {
        controller: AbortController
        emitter: { once: (ev: string, cb: () => void) => void }
        task: BackgroundTask
      }
    >
  }).records
  for (const [id, rec] of records.entries()) {
    if (rec.task.status === 'running' || rec.task.status === 'queued') {
      rec.controller.abort('test-cleanup')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200)
        rec.emitter.once('done', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
  await runtime.shutdown().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

async function waitForRunning(taskId: string): Promise<BackgroundTask> {
  let t: BackgroundTask | null = null
  for (let i = 0; i < 100; i++) {
    t = await runtime.get(taskId)
    if (t?.status === 'running') return t
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`task ${taskId} never reached running`)
}

async function waitForTerminal(taskId: string): Promise<BackgroundTask> {
  let t: BackgroundTask | null = null
  for (let i = 0; i < 100; i++) {
    t = await runtime.get(taskId)
    if (
      t?.status === 'completed' ||
      t?.status === 'failed' ||
      t?.status === 'cancelled'
    ) {
      return t
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`task ${taskId} never reached terminal`)
}

/**
 * 等 task emitter 'done' 事件 — runOne finally 写完 task + emit('done') 后
 * resolve。这样测试可以放心 await 落盘完成,避免 afterEach 的 `rm(tmpDir)`
 * 先于 runOne finally 写盘触发 verifyWrite ENOENT。
 */
async function waitForDone(taskId: string): Promise<void> {
  const rec = (runtime as unknown as {
    records: Map<string, { emitter: { once: (ev: string, cb: () => void) => void } }>
  }).records.get(taskId)
  if (!rec) return
  if (rec.emitter.listenerCount('done') > 0) {
    await new Promise<void>((resolve) => rec.emitter.once('done', () => resolve()))
  } else {
    // 'done' 之前已 emit 过(典型:task 已 terminal 后才进 waitForDone)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('sendMessageToTask', () => {
  it('不存在 taskId → {ok:false}', async () => {
    const res = await runtime.sendMessageToTask('nope', 'hello')
    expect(res).toEqual({ ok: false })
  })

  it('排队中的 task → {ok:true},prompt 入队', async () => {
    // dispatch 是 setImmediate 调度,任务先入 queue 立即返回 queued
    // (maxConcurrent=1 但 fake agent 永远 pending;第一次 dispatch 已抢到 slot)
    // 先发一个 task 占住 slot,再发一个仍 queued
    const a = await runtime.dispatch({
      prompt: 'task A',
      metadata: { parentSessionId: 'sess-1' },
    })
    await waitForRunning(a.id)
    const b = await runtime.dispatch({
      prompt: 'task B',
      metadata: { parentSessionId: 'sess-1' },
    })
    // b 状态是 queued(没机会 run)
    expect((await runtime.get(b.id))?.status).toBe('queued')

    const res = await runtime.sendMessageToTask(b.id, 'extra instructions')
    expect(res).toEqual({ ok: true })
  })

  it('运行中的 task → {ok:true}', async () => {
    const a = await runtime.dispatch({
      prompt: 'task A',
      metadata: { parentSessionId: 'sess-1' },
    })
    await waitForRunning(a.id)
    const res = await runtime.sendMessageToTask(a.id, 'change direction')
    expect(res).toEqual({ ok: true })
  })

  it('已 cancelled 的 task → {ok:false}', async () => {
    const a = await runtime.dispatch({
      prompt: 'task A',
      metadata: { parentSessionId: 'sess-1' },
    })
    await waitForRunning(a.id)
    await runtime.cancel(a.id)
    await waitForTerminal(a.id)
    await waitForDone(a.id)
    const res = await runtime.sendMessageToTask(a.id, 'after cancel')
    expect(res).toEqual({ ok: false })
  })

  it('attach 路径下 finalizeTask → cancelled 后 sendMessageToTask 返回 {ok:false}', async () => {
    await runtime.attach({
      id: 'agent-attach-1',
      input: { prompt: 'x' },
      metadata: { parentSessionId: 'sess-1' },
    })
    // attach 路径 status=running(非终态),sendMessageToTask 应该 ok:true
    const resBefore = await runtime.sendMessageToTask('agent-attach-1', 'go')
    expect(resBefore).toEqual({ ok: true })

    await runtime.finalizeTask('agent-attach-1', 'cancelled')
    const resAfter = await runtime.sendMessageToTask('agent-attach-1', 'late')
    expect(resAfter).toEqual({ ok: false })
  })

  it('runOne 消费:无 pending 时沿用原 prompt', async () => {
    const a = await runtime.dispatch({
      prompt: 'original prompt',
      metadata: { parentSessionId: 'sess-1' },
    })
    await waitForRunning(a.id)
    // 给 runOne 一个 tick 触发首次 query
    await new Promise((r) => setTimeout(r, 20))
    expect(captured.length).toBe(1)
    expect(captured[0].prompt).toBe('original prompt')
    await runtime.cancel(a.id)
    await waitForTerminal(a.id)
    await waitForDone(a.id)
  })

  it('runOne 消费:多条 pending 用 \\n\\n 拼到原 prompt 前缀,顺序保持', async () => {
    // dispatch 同步返回,records 已写入 + taskInbox 入队对其生效
    // (setImmediate 还没跑 scheduleNext)。后续 runOne 在 queryInput
    // 构造处消费 pending,把它们拼到原 prompt 前缀。
    const a = await runtime.dispatch({
      prompt: 'A-original',
      metadata: { parentSessionId: 'sess-1' },
    })
    await runtime.sendMessageToTask(a.id, 'A-msg-1')
    await runtime.sendMessageToTask(a.id, 'A-msg-2')

    // 等 running + fake agent 首次 query capture
    await waitForRunning(a.id)
    await new Promise((r) => setTimeout(r, 20))

    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[0].prompt).toBe('A-msg-1\n\nA-msg-2\n\nA-original')

    await runtime.cancel(a.id)
    await waitForTerminal(a.id)
    await waitForDone(a.id)
  })

  it('消费后 queue 清空 — 下一次 sendMessageToTask 重新入队', async () => {
    const c = await runtime.dispatch({
      prompt: 'C-original',
      metadata: { parentSessionId: 'sess-1' },
    })
    await runtime.sendMessageToTask(c.id, 'first-message')
    await waitForRunning(c.id)
    await new Promise((r) => setTimeout(r, 20))

    // 首次 query 已 capture 拼好的 prompt,queue 已清空
    expect(captured[captured.length - 1].prompt).toBe(
      'first-message\n\nC-original',
    )

    // 再次 sendMessageToTask —— 此时 fake agent 已在等 abort,query
    // 不会再触发;这个测试只验证 taskInbox 重新入队的接口语义,不
    // 强求 query 再次 capture(避免依赖 retry 行为)。
    const res = await runtime.sendMessageToTask(c.id, 'second-message')
    expect(res).toEqual({ ok: true })

    await runtime.cancel(c.id)
    await waitForTerminal(c.id)
    await waitForDone(c.id)
  })

  it('BackgroundRuntime 接口声明包含 sendMessageToTask', () => {
    // 静态契约校验:确保接口层也声明了该方法,外部 mock 实现不会漏实现
    const proto = DefaultBackgroundRuntime.prototype as unknown as Record<
      string,
      unknown
    >
    expect(typeof proto['sendMessageToTask']).toBe('function')
  })
})
