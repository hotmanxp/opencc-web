import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
} from '../../../src/compat/background/index.js'
import {
  setBackgroundRuntime,
} from '../../../src/compat/background/registry.js'
import {
  subagentControlTool,
  wrapSubagentControlAsOpencc,
} from '../../../src/compat/tools/opencc/subagentControl.js'
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
 *   - list_agents 的 sessionId 走 ALS 优先 / globalThis 兜底;两者都拿不到
 *     → 直接拒绝,不返回全量(否则跨会话泄漏)
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
  it('name/description 结构正确', () => {
    expect(subagentControlTool.name).toBe('subagent_control')
    expect(typeof subagentControlTool.description).toBe('string')
  })

  it('inputSchema 是 zod 且接受三个 action', () => {
    const schema = subagentControlTool.inputSchema as z.ZodTypeAny
    for (const action of ['send_message', 'interrupt_agent', 'list_agents']) {
      expect(schema.safeParse({ action }).success).toBe(true)
    }
  })

  it('inputSchema 拒绝未知 action', () => {
    const schema = subagentControlTool.inputSchema as z.ZodTypeAny
    expect(schema.safeParse({ action: 'nope' }).success).toBe(false)
  })
})

describe('subagent_control 无 BackgroundRuntime', () => {
  beforeEach(() => {
    // 模拟纯 core 单测环境:既无 globalThis bridge,也无 module registry
    setBackgroundRuntime(null)
    delete (globalThis as Record<string, unknown>)['__zaiBackgroundRuntime']
  })

  it('send_message → [error] BackgroundRuntime 未初始化', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'send_message', task_id: 't1', message: 'hi' },
      {},
    )
    expect(output).toMatch(/BackgroundRuntime 未初始化/)
  })

  it('interrupt_agent → [error] BackgroundRuntime 未初始化', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'interrupt_agent', task_id: 't1' },
      {},
    )
    expect(output).toMatch(/BackgroundRuntime 未初始化/)
  })

  it('list_agents → [error] BackgroundRuntime 未初始化', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'list_agents' },
      {},
    )
    expect(output).toMatch(/BackgroundRuntime 未初始化/)
  })
})

describe('subagent_control send_message', () => {
  it('正常调用 → 透传给 bg.sendMessageToTask', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'send_message', task_id: 't1', message: 'hello' },
      {},
    )
    expect(output).toBe('ok')
    expect(fake.sendMessageToTask).toHaveBeenCalledTimes(1)
    expect(fake.sendMessageToTask).toHaveBeenCalledWith('t1', 'hello')
  })

  it('bg 返回 {ok:false} → 不报成功', async () => {
    fake.sendMessageToTask.mockResolvedValueOnce({ ok: false })
    const { output } = await subagentControlTool.call(
      { action: 'send_message', task_id: 't1', message: 'hi' },
      {},
    )
    expect(output).not.toBe('ok')
  })

  it('缺 task_id → [error] 且不调 bg', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'send_message', message: 'hi' },
      {},
    )
    expect(output).toMatch(/task_id/)
    expect(fake.sendMessageToTask).not.toHaveBeenCalled()
  })

  it('缺 message → [error]', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'send_message', task_id: 't1' },
      {},
    )
    expect(output).toMatch(/message/)
  })

  it('bg 抛错 → [error] 携带原始 message', async () => {
    fake.sendMessageToTask.mockRejectedValueOnce(new Error('boom'))
    const { output } = await subagentControlTool.call(
      { action: 'send_message', task_id: 't1', message: 'hi' },
      {},
    )
    expect(output).toMatch(/boom/)
  })
})

describe('subagent_control interrupt_agent', () => {
  it('正常调用 → 透传给 bg.cancel', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'interrupt_agent', task_id: 't1' },
      {},
    )
    expect(output).toBe('ok')
    expect(fake.cancel).toHaveBeenCalledTimes(1)
    expect(fake.cancel).toHaveBeenCalledWith('t1')
  })

  it('缺 task_id → [error]', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'interrupt_agent' },
      {},
    )
    expect(output).toMatch(/task_id/)
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
    const { output } = await subagentControlTool.call(
      { action: 'list_agents' },
      {},
    )
    expect(output).toContain('task_id=t1')
    expect(output).toContain('status=running')
    expect(output).toContain('do thing')
    // 不同 session 的任务不应出现
    expect(output).not.toContain('t-other')
    // bg.list 无 filter 参数;parentSessionId 在 client 端 filter
    expect(fake.list).toHaveBeenCalledWith()
  })

  it('SDK ALS 的 sessionId 优先于进程级 globalThis(并发 session 不串)', async () => {
    // Regression: `__zaiCurrentSessionId` 是进程级单例,任何 session 发
    // prompt 都会覆写它。并发两个 session 时,A 的 list_agents 若只读
    // globalThis 就会解析到 B 的 sessionId —— 既泄漏 B 的 agent,
    // 又看不见自己的。
    //
    // 生产的包裹点是 vendor 的 runWithSdkContext(createOpenccRuntime-impl
    // 每轮 stream.next() 都在其中),不是 compat/runWithSessionId。
    const { runWithSdkContext } = await import(
      '../../../src/opencc-src/bootstrap/state.js'
    )
    // 故意把 globalThis 设成"别的 session"
    ;(globalThis as Record<string, unknown>)['__zaiCurrentSessionId'] = 'sess-B'
    fake.list.mockResolvedValueOnce([
      {
        id: 't-mine',
        status: 'running',
        input: { prompt: 'x' },
        createdAt: 0,
        eventCount: 0,
        parentSessionId: 'sess-A',
      },
      {
        id: 't-theirs',
        status: 'running',
        input: { prompt: 'y' },
        createdAt: 0,
        eventCount: 0,
        parentSessionId: 'sess-B',
      },
    ] as BackgroundTask[])

    const { output } = await runWithSdkContext(
      {
        sessionId: 'sess-A',
        sessionProjectDir: null,
        cwd: process.cwd(),
        originalCwd: process.cwd(),
      } as never,
      () => subagentControlTool.call({ action: 'list_agents' }, {}),
    )
    // ALS 赢了:拿到 A 自己的 agent,看不到 B 的
    expect(output).toContain('task_id=t-mine')
    expect(output).not.toContain('t-theirs')
  })

  it('无 sessionId → 拒绝列出,而不是退化成全量(防跨会话泄漏)', async () => {
    fake.list.mockResolvedValueOnce([
      {
        id: 't-other-session',
        status: 'running',
        input: { prompt: 'y' },
        createdAt: 0,
        eventCount: 0,
        parentSessionId: 'sess-SOMEONE-ELSE',
      },
    ] as BackgroundTask[])
    const { output } = await subagentControlTool.call(
      { action: 'list_agents' },
      {},
    )
    expect(output).toMatch(/解析不到当前 sessionId/)
    // 关键: 绝不能把别的 session 的 task_id 吐给模型
    expect(output).not.toContain('t-other-session')
    // 解析不到 session 时连 bg.list 都不该调
    expect(fake.list).not.toHaveBeenCalled()
  })

  it('空列表 → 明确告知无后台 agent', async () => {
    ;(globalThis as Record<string, unknown>)['__zaiCurrentSessionId'] = 'sess-A'
    fake.list.mockResolvedValueOnce([] as BackgroundTask[])
    const { output } = await subagentControlTool.call(
      { action: 'list_agents' },
      {},
    )
    expect(output).toMatch(/没有后台子 agent/)
  })

  it('description 缺省时该列不出现', async () => {
    ;(globalThis as Record<string, unknown>)['__zaiCurrentSessionId'] = 'sess-A'
    fake.list.mockResolvedValueOnce([
      {
        id: 't3',
        status: 'failed',
        input: { prompt: 'z' },
        createdAt: 0,
        eventCount: 0,
        parentSessionId: 'sess-A',
      },
    ] as BackgroundTask[])
    const { output } = await subagentControlTool.call(
      { action: 'list_agents' },
      {},
    )
    expect(output).toContain('task_id=t3')
    expect(output).toContain('status=failed')
    // 渲染行是 `task_id=X status=Y` —— 无 description 时不带尾部 " —"
    expect(output).not.toMatch(/status=failed\s+—/)
  })
})

describe('subagent_control opencc 包装', () => {
  it('name 透传给 vendor(inputSchema 刻意换成 v4,见下方回归测试)', () => {
    const wrapped = wrapSubagentControlAsOpencc() as {
      name: string
      inputSchema: unknown
    }
    expect(wrapped.name).toBe('subagent_control')
  })

  it('call 走 zai executor 并把 output 包进 ToolResult.data', async () => {
    fake.list.mockResolvedValueOnce([] as BackgroundTask[])
    const wrapped = wrapSubagentControlAsOpencc() as {
      call: (a: unknown, c: unknown) => Promise<{ data?: { output?: string } }>
    }
    const res = await wrapped.call({ action: 'list_agents' }, {})
    expect(res.data?.output).toMatch(/没有后台子 agent/)
  })

  it('mapToolResultToToolResultBlockParam 直接透传 output 文本(不 JSON.stringify)', () => {
    const wrapped = wrapSubagentControlAsOpencc() as {
      mapToolResultToToolResultBlockParam: (
        d: unknown,
        id: string,
      ) => { content: Array<{ text: string }> }
    }
    const block = wrapped.mapToolResultToToolResultBlockParam(
      { output: '1. task_id=t1 status=running' },
      'tu_1',
    )
    expect(block.content[0]!.text).toBe('1. task_id=t1 status=running')
  })

  it('inputSchema 是 zod v4(有 _zod.def),否则 opencc 序列化时炸 def', () => {
    // Regression: zai-native makeTool 产出的 schema 是 zod v3(只有 _def),
    // 而 opencc 的 zodToJsonSchema 走 zod/v4 的 toJSONSchema,读
    // `schema._zod.def` —— v3 schema 进池会让每次 API 请求抛
    // "Cannot read properties of undefined (reading 'def')"。
    const wrapped = wrapSubagentControlAsOpencc() as {
      inputSchema: { _zod?: { def?: unknown } }
    }
    expect(wrapped.inputSchema._zod?.def).toBeDefined()
  })

  it('v4 schema 能被 zod/v4 toJSONSchema 转成 JSON Schema', async () => {
    const { toJSONSchema } = await import('zod/v4')
    const wrapped = wrapSubagentControlAsOpencc() as {
      inputSchema: Parameters<typeof toJSONSchema>[0]
    }
    const json = toJSONSchema(wrapped.inputSchema)
    expect(json.properties).toHaveProperty('action')
    expect(json.properties).toHaveProperty('task_id')
    expect(json.properties).toHaveProperty('message')
  })

  it('非法 action → [error] 前缀,不是抛异常', async () => {
    const { output } = await subagentControlTool.call(
      { action: 'not_a_real_action' },
      {},
    )
    expect(output).toMatch(/^\[error\]/)
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
