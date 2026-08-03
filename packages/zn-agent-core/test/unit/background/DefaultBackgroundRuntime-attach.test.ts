import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  type BackgroundTask,
  type TaskEvent,
} from '../../../src/compat/background/index.js'

/**
 * agentTool→SSE 桥接 (mirrorAttachTaskToBg / mirrorAppendBgEvent /
 * mirrorFinalizeBgTask) 的底层契约测试。
 *
 * AgentTool 子代理既不调用 dispatch() 也不走 runOne(),所以这条管道
 * 涉及的所有"外部管理"能力(attach / appendTaskEvent / finalizeTask)在
 * 真实环境只能间接触发,这里直接覆盖实现以保回归。
 */

interface AgentRuntime {
  query(input: unknown): AsyncIterable<unknown>
}

function makeNoopAgent(): AgentRuntime {
  return {
    async *query(): AsyncGenerator<never> {
      // no events; only used because constructor requires agentRuntime
    },
  }
}

let tmpDir: string
let store: JsonTaskStore
let runtime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-attach-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  runtime = new DefaultBackgroundRuntime({
    agentRuntime: makeNoopAgent() as never,
    store,
    maxConcurrent: 1,
    shutdownTimeoutMs: 200,
  })
})

afterEach(async () => {
  await runtime.shutdown().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

describe('attach()', () => {
  it('caller-specified id is registered + persisted + visible via get()', async () => {
    const task = await runtime.attach({
      id: 'agent-xyz',
      input: { prompt: 'list files' },
      metadata: {
        parentSessionId: 'sess-A',
        agentType: 'general-purpose',
        description: 'list files',
      },
    })

    expect(task.id).toBe('agent-xyz')
    expect(task.status).toBe('queued')
    expect(task.input.prompt).toBe('list files')
    expect(task.parentSessionId).toBe('sess-A')
    expect(task.agentType).toBe('general-purpose')
    expect(task.description).toBe('list files')
    expect(task.eventCount).toBe(0)

    // store 也落盘 → 重启后 events() 仍能回放
    expect(await store.load('agent-xyz')).toMatchObject({
      id: 'agent-xyz',
      status: 'queued',
    })

    // get() 走 records 命中
    expect(await runtime.get('agent-xyz')).toMatchObject({ id: 'agent-xyz' })
  })

  it('二次 attach 同 id 幂等返回当前 task', async () => {
    const first = await runtime.attach({
      id: 'agent-dup',
      input: { prompt: 'a' },
      metadata: {},
    })
    const second = await runtime.attach({
      id: 'agent-dup',
      input: { prompt: 'b' },
      metadata: {},
    })
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt) // 不是新 task
    // input 仍是第一次的
    expect(second.input.prompt).toBe('a')
  })
})

describe('appendTaskEvent()', () => {
  it('records event with monotonic seq, persists to store, emits on emitter', async () => {
    await runtime.attach({
      id: 'agent-evt',
      input: { prompt: 'x' },
      metadata: {},
    })

    const collected: TaskEvent[] = []
    const abort = new AbortController()
    // 同步订阅 emitter(测试用 record;实际由 events() SSE path 消费)
    void (async () => {
      // 通过 events() 流订阅一个新生成的任务 —— 这里是 attached 的
      // 由于 attach() 不入 queue,我们需要走 store + emitter 的等价路径
      // 直接订阅 store.readEvents 不拿得到 live tail,所以这里读 store 后
      // 再调单独断言 emitter
      for await (const ev of runtime.events('agent-evt', 0, abort.signal)) {
        collected.push(ev)
      }
    })()

    await new Promise((r) => setTimeout(r, 10))
    await runtime.appendTaskEvent('agent-evt', {
      type: 'assistant',
      eventId: 'e1',
      ts: 1000,
      content: [{ type: 'text', text: 'hi' }],
    })
    await runtime.appendTaskEvent('agent-evt', {
      type: 'tool_use',
      eventId: 'e2',
      ts: 2000,
      toolName: 'Read',
      input: { file_path: '/foo.txt' },
    })

    // 给 events() 一个 microtask 把 live emitter 推过来
    await new Promise((r) => setTimeout(r, 50))
    abort.abort()

    expect(collected.length).toBeGreaterThanOrEqual(2)
    expect(collected[0].seq).toBe(1)
    expect(collected[0].type).toBe('assistant')
    expect(collected[1].seq).toBe(2)
    expect(collected[1].type).toBe('tool_use')

    const persisted = await store.load('agent-evt')
    expect(persisted?.eventCount).toBe(2)

    // 落盘回放(store.readEvents)能再读回这两个事件
    const replayed: TaskEvent[] = []
    for await (const ev of store.readEvents('agent-evt', 0)) {
      replayed.push(ev)
    }
    expect(replayed.length).toBe(2)
    expect(replayed[1].data).toMatchObject({ toolName: 'Read' })
  })

  it('rebuilds record from disk when not in memory (restart resilience)', async () => {
    // 模拟"attach 之后 server 重启":直接 store.save 持久化 task,然后
    // 用一个全新的 runtime 接管 —— records 是空的
    await store.save({
      id: 'agent-restart',
      status: 'queued',
      input: { prompt: 'x' },
      createdAt: 1000,
      eventCount: 0,
    })
    const freshRuntime = new DefaultBackgroundRuntime({
      agentRuntime: makeNoopAgent() as never,
      store,
      maxConcurrent: 1,
      shutdownTimeoutMs: 200,
    })

    // records 没有 → appendTaskEvent 走 ensureRecord 懒重建
    await freshRuntime.appendTaskEvent('agent-restart', {
      type: 'assistant',
      ts: 1500,
      content: [{ type: 'text', text: 'after restart' }],
    })

    const reloaded = await freshRuntime.get('agent-restart')
    expect(reloaded?.eventCount).toBe(1)

    // 再读 disk —— seq 应从持久化的 eventCount + 1 = 1
    const replayed: TaskEvent[] = []
    for await (const ev of store.readEvents('agent-restart', 0)) {
      replayed.push(ev)
    }
    expect(replayed[0].seq).toBe(1)

    await freshRuntime.shutdown()
  })

  it('silent drop + warn when task does not exist anywhere', async () => {
    const original = console.warn
    let warned: string | undefined
    console.warn = (msg: string) => {
      if (msg.includes('appendTaskEvent')) warned = msg
    }
    try {
      await runtime.appendTaskEvent('never-attached', { type: 'assistant' })
      expect(warned).toMatch(/not found/)
    } finally {
      console.warn = original
    }
  })
})

describe('finalizeTask()', () => {
  it('flips status to terminal, sets finishedAt, persists', async () => {
    await runtime.attach({
      id: 'agent-done',
      input: { prompt: 'x' },
      metadata: {},
    })
    // 模拟运行中
    await runtime.appendTaskEvent('agent-done', {
      type: 'assistant',
      ts: Date.now(),
      text: 'work',
    })

    await runtime.finalizeTask('agent-done', 'completed')

    const t = await runtime.get('agent-done')
    expect(t?.status).toBe('completed')
    expect(t?.finishedAt).toBeTypeOf('number')

    const persisted = await store.load('agent-done')
    expect(persisted?.status).toBe('completed')
  })

  it('attaches structured error when status = failed', async () => {
    await runtime.attach({
      id: 'agent-bad',
      input: { prompt: 'x' },
      metadata: {},
    })
    await runtime.finalizeTask('agent-bad', 'failed', {
      message: 'API error',
      category: 'transient',
    })
    const t = await runtime.get('agent-bad')
    expect(t?.status).toBe('failed')
    expect(t?.error).toEqual({
      message: 'API error',
      category: 'transient',
    })
  })

  it('幂等:已 terminal 的 task 再调是 no-op', async () => {
    await runtime.attach({
      id: 'agent-idem',
      input: { prompt: 'x' },
      metadata: {},
    })
    await runtime.finalizeTask('agent-idem', 'completed')
    const first = await runtime.get('agent-idem')
    await runtime.finalizeTask('agent-idem', 'failed', { message: 'late', category: 'internal' })
    const second = await runtime.get('agent-idem')
    // 第二次不该覆盖
    expect(second?.status).toBe('completed')
    expect(second?.finishedAt).toBe(first?.finishedAt)
    expect(second?.error).toBeUndefined()
  })
})

describe('events() replay', () => {
  it('replays events written via appendTaskEvent, then terminates on terminal', async () => {
    await runtime.attach({
      id: 'agent-replay',
      input: { prompt: 'x' },
      metadata: {},
    })
    await runtime.appendTaskEvent('agent-replay', { type: 'message_start' })
    await runtime.appendTaskEvent('agent-replay', { type: 'content_block_delta' })
    await runtime.finalizeTask('agent-replay', 'completed')

    const replayed: TaskEvent[] = []
    for await (const ev of runtime.events('agent-replay', 0)) {
      replayed.push(ev)
    }
    expect(replayed.length).toBe(2)
    expect(replayed[0].type).toBe('message_start')
    expect(replayed[1].type).toBe('content_block_delta')
  })
})

// 在测试期间不污染类型层签名,只是把 BackgroundTask / TaskEvent re-export
// 让上面 import 看起来自然
type _ = BackgroundTask & TaskEvent
