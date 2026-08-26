import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
} from '../../../src/compat/background/index.js'
import {
  setBackgroundRuntime,
} from '../../../src/compat/background/registry.js'
import { subagentControlTool } from '../../../src/compat/tools/opencc/subagentControl.js'
import type { BackgroundTask } from '../../../src/compat/background/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * zai patch (HRMSV3-ZN-WEBSITE#668 / subagent_control):主对话工具
 * `subagent_control` 单测。覆盖三件套:
 *   send_message     → bg.sendMessageToTask(taskId, prompt)
 *   interrupt_agent  → bg.cancel(taskId)
 *   list_agents      → bg.list({parentSessionId}) / bg.list()
 *
 * 关键边界:
 *   - 无 bg(纯 core 单测未初始化) → 所有 action 返回 no-op
 *     (error 信息标识原因,模型可读)
 *   - list_agents 优先用 `__zaiCurrentSessionId` 桥;无桥时退化为 bg.list()
 *   - send_message / interrupt_agent 缺 task_id → {ok:false, error}
 *   - send_message 缺 message → {ok:false, error}
 */

interface FakeRuntime {
  sendMessageToTask: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
}

let fake: FakeRuntime
let tmpDir: string
let store: JsonTaskStore
let realRuntime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-ctrl-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  // 用 fake vi.fn 跑最快的契约断言,不需要真 JsonTaskStore;realRuntime
  // 只在 `背景:接真实 runtime 的集成测`中用。
  fake = {
    sendMessageToTask: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
    list: vi.fn(async () => []),
  }
  setBackgroundRuntime(fake as unknown as DefaultBackgroundRuntime)
  // 清掉 __zaiBackgroundRuntime,确保走 module registry 分支
  delete (globalThis as Record<string, unknown>)['__zaiBackgroundRuntime']
  delete (globalThis as Record<string, unknown>)['__zaiCurrentSessionId']
})

afterEach(async () => {
  setBackgroundRuntime(null)
  delete (globalThis as Record<string, unknown>)['__zaiBackgroundRuntime']
  delete (globalThis as Record<string, unknown>)['__zaiCurrentSessionId']
  if (realRuntime) {
    await realRuntime.shutdown().catch(() => {})
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('subagent_control 工具 schema', () => {
  it('name/description/parameters 结构正确', () => {
    expect(subagentControlTool.name).toBe('subagent_control')
    expect(typeof subagentControlTool.description).toBe('string')
    expect(subagentControlTool.parameters.action.enum).toEqual([
      'send_message',
      'interrupt_agent',
      'list_agents',
    ])
    expect(subagentControlTool.parameters.action.required).toBe(true)
    expect(typeof subagentControlTool.parameters.task_id.description).toBe('string')
    expect(typeof subagentControlTool.parameters.message.description).toBe('string')
  })
})

describe('subagent_control 无 BackgroundRuntime', () => {
  beforeEach(() => {
    // 模拟纯 core 单测环境:既无 globalThis bridge,也无 module registry
    setBackgroundRuntime(null)
    delete (globalThis as Record<string, unknown>)['__zaiBackgroundRuntime']
  })

  it('send_message → {ok:false, error:...}', async () => {
    const res = await subagentControlTool.execute(
      { action: 'send_message', task_id: 't1', message: 'hi' },
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/BackgroundRuntime 未初始化/)
  })

  it('interrupt_agent → {ok:false, error:...}', async () => {
    const res = await subagentControlTool.execute(
      { action: 'interrupt_agent', task_id: 't1' },
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/BackgroundRuntime 未初始化/)
  })

  it('list_agents → {ok:false, error:...}', async () => {
    const res = await subagentControlTool.execute(
      { action: 'list_agents' },
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/BackgroundRuntime 未初始化/)
  })
})

describe('subagent_control send_message', () => {
  it('正常调用 → 透传给 bg.sendMessageToTask', async () => {
    const res = await subagentControlTool.execute(
      { action: 'send_message', task_id: 't1', message: 'hello' },
      {},
    )
    expect(res.ok).toBe(true)
    expect(fake.sendMessageToTask).toHaveBeenCalledTimes(1)
    expect(fake.sendMessageToTask).toHaveBeenCalledWith('t1', 'hello')
  })

  it('bg 返回 {ok:false} → 透传 {ok:false}', async () => {
    fake.sendMessageToTask.mockResolvedValueOnce({ ok: false })
    const res = await subagentControlTool.execute(
      { action: 'send_message', task_id: 't1', message: 'hi' },
      {},
    )
    expect(res.ok).toBe(false)
  })

  it('缺 task_id → {ok:false, error}', async () => {
    const res = await subagentControlTool.execute(
      { action: 'send_message', message: 'hi' } as never,
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/task_id/)
    expect(fake.sendMessageToTask).not.toHaveBeenCalled()
  })

  it('缺 message → {ok:false, error}', async () => {
    const res = await subagentControlTool.execute(
      { action: 'send_message', task_id: 't1' } as never,
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/message/)
  })

  it('bg 抛错 → {ok:false, error}', async () => {
    fake.sendMessageToTask.mockRejectedValueOnce(new Error('boom'))
    const res = await subagentControlTool.execute(
      { action: 'send_message', task_id: 't1', message: 'hi' },
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})

describe('subagent_control interrupt_agent', () => {
  it('正常调用 → 透传给 bg.cancel', async () => {
    const res = await subagentControlTool.execute(
      { action: 'interrupt_agent', task_id: 't1' },
      {},
    )
    expect(res.ok).toBe(true)
    expect(fake.cancel).toHaveBeenCalledTimes(1)
    expect(fake.cancel).toHaveBeenCalledWith('t1')
  })

  it('缺 task_id → {ok:false, error}', async () => {
    const res = await subagentControlTool.execute(
      { action: 'interrupt_agent' } as never,
      {},
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/task_id/)
  })
})

describe('subagent_control list_agents', () => {
  it('有 currentSessionId → bg.list() 后 client 端 filter parentSessionId', async () => {
    ;(globalThis as Record<string, unknown>)['__zaiCurrentSessionId'] = 'sess-A'
    fake.list.mockResolvedValueOnce([
      {
        id: 't1',
        status: 'running',
        input: { prompt: 'x' },
        createdAt: 0,
        eventCount: 0,
        description: 'do thing',
        parentSessionId: 'sess-A',
      },
      {
        id: 't-other',
        status: 'completed',
        input: { prompt: 'y' },
        createdAt: 0,
        eventCount: 0,
        parentSessionId: 'sess-B', // 不同 session,被 filter 掉
      },
    ] as BackgroundTask[])
    const res = await subagentControlTool.execute(
      { action: 'list_agents' },
      {},
    )
    expect(res.agents).toEqual([
      { id: 't1', status: 'running', description: 'do thing' },
    ])
    // bg.list 无 filter 参数;parentSessionId 在 client 端 filter
    expect(fake.list).toHaveBeenCalledWith()
  })

  it('无 currentSessionId → 退化为 bg.list() 输出全量', async () => {
    fake.list.mockResolvedValueOnce([
      {
        id: 't2',
        status: 'completed',
        input: { prompt: 'y' },
        createdAt: 0,
        eventCount: 0,
      },
    ] as BackgroundTask[])
    const res = await subagentControlTool.execute(
      { action: 'list_agents' },
      {},
    )
    expect(res.agents).toEqual([{ id: 't2', status: 'completed' }])
    expect(fake.list).toHaveBeenCalledWith()
  })

  it('description 缺省时不输出该字段', async () => {
    fake.list.mockResolvedValueOnce([
      {
        id: 't3',
        status: 'failed',
        input: { prompt: 'z' },
        createdAt: 0,
        eventCount: 0,
      },
    ] as BackgroundTask[])
    const res = await subagentControlTool.execute(
      { action: 'list_agents' },
      {},
    )
    expect(res.agents).toEqual([{ id: 't3', status: 'failed' }])
    expect(res.agents?.[0]).not.toHaveProperty('description')
  })
})

describe('subagent_control 集成: 真实 DefaultBackgroundRuntime', () => {
  it('send_message → runOne 拼接 prompt 前缀', async () => {
    const captured: string[] = []
    const captureAgent = {
      async *query(input: { prompt?: string; abortSignal?: AbortSignal }) {
        captured.push(input.prompt ?? '')
        const signal = input.abortSignal
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    realRuntime = new DefaultBackgroundRuntime({
      agentRuntime: captureAgent as never,
      store,
      maxConcurrent: 1,
      shutdownTimeoutMs: 200,
    })
    setBackgroundRuntime(realRuntime)

    const dispatched = await realRuntime.dispatch({
      prompt: 'ORIGINAL',
      metadata: { parentSessionId: 'sess-A' },
    })
    // dispatch 同步返回;runOne 在 setImmediate 调度。taskInbox 在
    // runOne 启动 queryInput 构造时消费,所以在 running 前入队即可。
    await realRuntime.sendMessageToTask(dispatched.id, 'INJECTED')

    // 等 running + 首次 query capture
    let t: BackgroundTask | null = null
    for (let i = 0; i < 100; i++) {
      t = await realRuntime.get(dispatched.id)
      if (t?.status === 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 20))

    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[captured.length - 1]).toBe('INJECTED\n\nORIGINAL')

    await realRuntime.cancel(dispatched.id)
    // 等 runOne finally 写盘完成,避免 afterEach rm(tmpDir) 抢先
    // 触发 JsonTaskStore.verifyWrite ENOENT
    for (let i = 0; i < 100; i++) {
      const t = await realRuntime.get(dispatched.id)
      if (t?.status === 'cancelled') break
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 50))
  })
})
