import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import {
  BackgroundAgentResultTool,
} from '../../../src/tools/BackgroundAgentResultTool/BackgroundAgentResultTool.js'
import type { LegacyToolContext } from '../../../src/tools/Tool.js'
import {
  setBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../../src/runtime/background/index.js'
import type {
  BackgroundRuntime,
  BackgroundTask,
  DispatchInput,
  TaskEvent,
} from '../../../src/runtime/background/index.js'

/**
 * Mock runtime whose events() is intentionally non-resolving.
 * If BackgroundAgentResultTool's waitMs=0 path ever awaits it,
 * the test will time out — which is exactly the canary we want.
 */
function makeRuntime(task: BackgroundTask | null, opts: { eventsCalls: number[] }): BackgroundRuntime {
  return {
    async dispatch(_input: DispatchInput): Promise<BackgroundTask> {
      throw new Error('not used')
    },
    async get(id: string): Promise<BackgroundTask | null> {
      return task && task.id === id ? task : null
    },
    async list() {
      return task ? [task] : []
    },
    async cancel() {
      return { ok: false }
    },
    events(_id: string, _fromSeq = 0, _signal?: AbortSignal): AsyncIterable<TaskEvent> {
      opts.eventsCalls.push(Date.now())
      return (async function* () {
        await new Promise<never>(() => {})
      })()
    },
    async shutdown() {},
  }
}

function makeTask(overrides: Partial<BackgroundTask> & { id: string; status: BackgroundTask['status'] }): BackgroundTask {
  const base: BackgroundTask = {
    id: overrides.id,
    status: overrides.status,
    input: { prompt: 'do something', cwd: '/tmp', agent: 'general-purpose' },
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: undefined,
    resultText: overrides.resultText,
    error: overrides.error,
    eventCount: 0,
  }
  return { ...base, ...overrides }
}

function makeCtx(): LegacyToolContext {
  return {
    cwd: '/tmp',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/tmp',
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    __runtimeConfig: {} as any,
    __defaultModel: 'test',
    __maxTurns: 1,
    parentSessionId: 'sess-test',
  } as LegacyToolContext
}

let runtime: BackgroundRuntime
let eventsCalls: number[]

beforeEach(() => {
  eventsCalls = []
})

afterEach(() => {
  setBackgroundRuntime(null)
})

describe('BackgroundAgentResultTool — immediate return (waitMs=0)', () => {
  test('waitMs=0 + running task returns status without calling events()', async () => {
    const task = makeTask({ id: 'abc', status: 'running' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(r.isError).toBeFalsy()
    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: running')
    expect(r.output as string).not.toContain('--- output (tail) ---')
  })

  test('waitMs=0 + completed task returns status + resultText without calling events()', async () => {
    const task = makeTask({ id: 'abc', status: 'completed', resultText: 'final answer' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: completed')
    expect(r.output as string).toContain('resultText: final answer')
    expect(r.output as string).not.toContain('--- output (tail) ---')
  })

  test('waitMs=0 + failed task returns isError=true without calling events()', async () => {
    const task = makeTask({
      id: 'abc',
      status: 'failed',
      error: { category: 'llm_provider', message: 'boom' },
    })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(r.isError).toBe(true)
    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: failed')
    expect(r.output as string).toContain('error: boom')
  })

  test('waitMs=0 + cancelled task returns isError=false without calling events()', async () => {
    const task = makeTask({ id: 'abc', status: 'cancelled' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())

    expect(r.isError).toBe(false)
    expect(eventsCalls.length).toBe(0)
    expect(r.output as string).toContain('status: cancelled')
  })

  test('waitMs>0 + running task calls events() with ctx.abortSignal', async () => {
    const calls: { fromSeq?: number; signal?: AbortSignal }[] = []
    const task = makeTask({ id: 'abc', status: 'running' })
    runtime = {
      ...makeRuntime(task, { eventsCalls }),
      events(_id, fromSeq, signal) {
        calls.push({ fromSeq, signal })
        return (async function* () {
          yield {
            seq: 1, id: 'abc', type: 'message_start',
            ts: Date.now(), data: {},
          } as unknown as TaskEvent
          await new Promise<never>(() => {})
        })()
      },
    }
    setBackgroundRuntime(runtime)

    const ac = new AbortController()
    const ctx = { ...makeCtx(), abortSignal: ac.signal }
    const callPromise = BackgroundAgentResultTool.call(
      { shortId: 'abc', waitMs: 50 },
      ctx,
    )
    setTimeout(() => ac.abort(), 100)
    const r = await callPromise

    expect(calls[0]?.signal).toBe(ctx.abortSignal)
    expect(r.output as string).toContain('status: running')
  })

  test('waitMs>0 + already-completed task calls events() and returns full tail output', async () => {
    const task = makeTask({ id: 'abc', status: 'completed', resultText: 'done' })
    runtime = {
      ...makeRuntime(task, { eventsCalls }),
      events(_id, _fromSeq, _signal) {
        return (async function* () {
          yield {
            seq: 1, id: 'abc', type: 'content_block_delta',
            ts: Date.now(),
            data: { delta: { type: 'text_delta', text: 'partial work' } },
          } as unknown as TaskEvent
          yield {
            seq: 2, id: 'abc', type: 'runtime.done',
            ts: Date.now(), data: { text: 'final' },
          } as unknown as TaskEvent
        })()
      },
    }
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 50 }, makeCtx())

    expect(r.output as string).toContain('--- output (tail) ---')
    expect(r.output as string).toContain('partial work')
    expect(r.output as string).toContain('final')
  })

  test('ctx.abortSignal aborts waitMs>0 path within bounded time', async () => {
    const task = makeTask({ id: 'abc', status: 'running' })
    runtime = makeRuntime(task, { eventsCalls })
    setBackgroundRuntime(runtime)

    const ac = new AbortController()
    const ctx = { ...makeCtx(), abortSignal: ac.signal }

    const start = Date.now()
    const p = BackgroundAgentResultTool.call(
      { shortId: 'abc', waitMs: 60000 },
      ctx,
    )
    setTimeout(() => ac.abort(), 100)
    const r = await p
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(r.output as string).toContain('status: running')
  })

  test('shortId not found returns task-not-found with isError=true, no events() call', async () => {
    runtime = makeRuntime(null, { eventsCalls })
    setBackgroundRuntime(runtime)

    const r = await BackgroundAgentResultTool.call({ shortId: 'missing', waitMs: 0 }, makeCtx())

    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('task not found: missing')
    expect(eventsCalls.length).toBe(0)
  })

  test('hasBackgroundRuntime()=false returns the not-initialized error path', async () => {
    setBackgroundRuntime(null)
    expect(hasBackgroundRuntime()).toBe(false)
    const r = await BackgroundAgentResultTool.call({ shortId: 'abc', waitMs: 0 }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('未初始化')
  })
})
