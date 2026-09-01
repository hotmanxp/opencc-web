import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
} from '../../../src/compat/background/index.js'

/**
 * cancelByParentSession 契约测试 —— ESC / /api/agent/abort 用它终止某个
 * 父会话派生的全部未结束后台任务,否则后台 agent 会继续跑、继续向共享
 * API key 发请求。
 */

function makeQueryAgent() {
  // dispatch 路径的 agentRuntime.query: 永远 pending(不产事件、不结束),
  // 模拟一个"正在跑"的后台任务。abort signal 到达时结束流。
  return {
    async *query(input: { abortSignal?: AbortSignal }) {
      const signal = input.abortSignal
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return
    },
  }
}

let tmpDir: string
let store: JsonTaskStore
let runtime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-cancel-by-session-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  runtime = new DefaultBackgroundRuntime({
    agentRuntime: makeQueryAgent() as never,
    store,
    maxConcurrent: 10,
    shutdownTimeoutMs: 500,
  })
})

afterEach(async () => {
  await runtime.shutdown().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

describe('cancelByParentSession', () => {
  it('取消 dispatch 路径中属于该父会话的未完成任务', async () => {
    const a = await runtime.dispatch({
      prompt: 'task A',
      metadata: { parentSessionId: 'sess-A' },
    })
    const b = await runtime.dispatch({
      prompt: 'task B',
      metadata: { parentSessionId: 'sess-A' },
    })
    const c = await runtime.dispatch({
      prompt: 'task C',
      metadata: { parentSessionId: 'sess-B' },
    })

    // 让任务跑起来(dispatch 是 setImmediate 调度)
    await new Promise((r) => setTimeout(r, 20))

    const result = await runtime.cancelByParentSession('sess-A')
    expect(result.cancelled).toBe(2)

    // 等 A/B 的终态落地(cancelByParentSession 只 abort,终态由 runOne finally 异步写)
    for (let i = 0; i < 50; i++) {
      const ta = await runtime.get(a.id)
      const tb = await runtime.get(b.id)
      if (ta?.status === 'cancelled' && tb?.status === 'cancelled') break
      await new Promise((r) => setTimeout(r, 10))
    }

    const tA = await runtime.get(a.id)
    const tB = await runtime.get(b.id)
    const tC = await runtime.get(c.id)

    expect(tA?.status).toBe('cancelled')
    expect(tB?.status).toBe('cancelled')
    expect(tC?.status).not.toBe('cancelled')
  })

  it('取消 attach 路径(外部管理子代理)中属于该父会话的任务', async () => {
    await runtime.attach({
      id: 'sub-1',
      input: { prompt: 'x' },
      metadata: { parentSessionId: 'sess-A' },
    })
    await runtime.attach({
      id: 'sub-2',
      input: { prompt: 'y' },
      metadata: { parentSessionId: 'sess-B' },
    })

    const result = await runtime.cancelByParentSession('sess-A')
    expect(result.cancelled).toBe(1)

    // attach 路径的终态由 caller 通过 finalizeTask 标记;cancelByParentSession
    // 只 abort controller,这里验证 controller 已被 abort 的信号会传给后续
    // finalizeTask 的判定。attach 任务本身 status 仍 running(外部管理),
    // 但 cancel 后应能正常 finalize 为 cancelled。
    await runtime.finalizeTask('sub-1', 'cancelled', { message: 'cancelled', category: 'internal' })
    const t = await runtime.get('sub-1')
    expect(t?.status).toBe('cancelled')
  })

  it('已结束任务不重复取消', async () => {
    const a = await runtime.dispatch({
      prompt: 'A',
      metadata: { parentSessionId: 'sess-A' },
    })
    await runtime.cancelByParentSession('sess-A')
    // runOne 的 finally 异步把任务标 cancelled;轮询等终态落地
    for (let i = 0; i < 50; i++) {
      if ((await runtime.get(a.id))?.status === 'cancelled') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const second = await runtime.cancelByParentSession('sess-A')
    expect(second.cancelled).toBe(0)
    expect((await runtime.get(a.id))?.status).toBe('cancelled')
  })

  it('无匹配任务时返回 0', async () => {
    await runtime.dispatch({ prompt: 'x', metadata: { parentSessionId: 'sess-B' } })
    const result = await runtime.cancelByParentSession('sess-NOPE')
    expect(result.cancelled).toBe(0)
  })
})
