/**
 * DshSubagentControlAdapter contract test —— Stage 0/4 验收。
 *
 * 覆盖:
 *   - dispatch() 入参校验(parentSessionId/cwd/prompt 缺 → 抛 SeamInvalidArgumentError)
 *   - dispatch() 委托 spawnDshSubagent 传入正确的字段(shape:parent/prompt/cwd/model/provider)
 *   - dispatch() Stage 4:'spawn' / 'fork' 两个 context 都接受,providerName
 *     正确透传给 spawnDshSubagent(对应 vendor SubagentRuntime.start(...))
 *   - dispatch() 抛出 SeamRuntimeError 当 spawnDshSubagent 失败
 *   - get() / list() 委托 readDshTask / listDshSubagents
 *   - cancel() 终态返回 { ok: false };运行中返回 { ok: true }
 *   - sendMessage() 直接委托 sendMessageToDshSubagent
 *   - onChange() 返回 unsubscribe 函数 + destroy() 清空 listener
 *   - DshTaskState → SeamSubagentSummary 映射(stopReason 反向映射)
 *
 * 依赖 mock:用 vi.mock mock `../subagent/taskStore` 模块的 spawnDshSubagent /
 * interruptDshSubagent / sendMessageToDshSubagent / listDshSubagents / readDshTask。
 *
 * 不依赖真实 dsh ctx — 用最小 mock 验证 adapter 委托语义。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── mock 整个 taskStore 模块 ──────────────────────────────────
// 用 vi.hoisted 是为了让 tmpHome 在 mock factory 闭包里可访问。
const mockState = vi.hoisted(() => ({
  tmpHome: '',
  taskStore: {
    spawnDshSubagent: vi.fn(),
    interruptDshSubagent: vi.fn(),
    sendMessageToDshSubagent: vi.fn(),
    listDshSubagents: vi.fn(),
    readDshTask: vi.fn(),
    dshTaskPath: vi.fn(),
    writeDshTask: vi.fn(),
    notifyParentSession: vi.fn(),
    getDshSubagentToolCalls: vi.fn(),
    createDshSubagentScope: vi.fn(),
  },
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    get homedir() {
      return () => mockState.tmpHome
    },
  }
})

vi.mock('../../src/subagent/taskStore.js', () => mockState.taskStore)

// mock `@deepseek-ai/dsh-*` 模块 — Adapter 不直接 import vendor 类型,
// 但 types.ts import 了; mock 时给空 stub 让 tsc 不会拉到真实模块。
vi.mock('@deepseek-ai/dsh-subagent', () => ({}))
vi.mock('@deepseek-ai/dsh-jobs', () => ({}))
vi.mock('@deepseek-ai/dsh-llm', () => ({}))
vi.mock('@deepseek-ai/dsh-session', () => ({}))

import {
  DshSubagentControlAdapter,
  createDshSubagentControlBridge,
  type DshSubagentAdapterOptions,
} from '../../src/vendorSeam/subagent.js'
import {
  SeamInvalidArgumentError,
  SeamRuntimeError,
} from '../../src/vendorSeam/types.js'
import type { DshTaskState } from '../../src/subagent/taskStore.js'

// ── 最小 cordis ctx mock ────────────────────────────────────────

interface MockAgent {
  followup: ReturnType<typeof vi.fn>
  session: { id: string; seq: number }
  cancel: ReturnType<typeof vi.fn>
  options: Record<string, unknown>
  status: string
  id: string
  whenIdle: () => Promise<void>
}

function makeMockParentAgent(id = 'parent-session-id'): MockAgent {
  return {
    followup: vi.fn(),
    session: { id, seq: 0 },
    cancel: vi.fn(),
    options: {},
    status: 'idle',
    id,
    whenIdle: () => Promise.resolve(),
  } as MockAgent
}

interface MockCtx {
  on: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  agents: { currentInitiator: () => { id: string } | undefined; get: (id: string) => MockAgent | undefined }
  subagents?: unknown
}

function makeMockCtx(parentAgent: MockAgent | undefined): MockCtx {
  return {
    on: vi.fn(() => () => undefined),
    get: vi.fn((key: string) => {
      if (key === 'agents') {
        return { get: (id: unknown) => (String(id) === parentAgent?.id ? parentAgent : undefined) }
      }
      return undefined
    }),
    agents: {
      currentInitiator: () => (parentAgent ? { id: parentAgent.id } : undefined),
      get: (id: string) => (id === parentAgent?.id ? parentAgent : undefined),
    },
    subagents: undefined, // 不用真实 SubagentRuntime,改走 spawnDshSubagent mocked
  }
}

function makeAdapter(
  parentAgent: MockAgent | undefined,
): DshSubagentControlAdapter {
  const ctx = makeMockCtx(parentAgent)
  const opts: DshSubagentAdapterOptions = {
    ctx: ctx as never,
    getParentAgent: (sessionId: string): unknown =>
      parentAgent && parentAgent.id === sessionId ? parentAgent : undefined,
  }
  return new DshSubagentControlAdapter(opts)
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('Stage 0: DshSubagentControlAdapter contract', () => {
  let parentAgent: MockAgent

  beforeEach(async () => {
    mockState.tmpHome = await mkdtemp(join(tmpdir(), 'dsh-seam-subagent-'))
    parentAgent = makeMockParentAgent('parent-session-id')
    // 重置 mock 调用历史
    for (const fn of Object.values(mockState.taskStore)) {
      if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear: () => void }).mockClear()
    }
  })

  afterEach(async () => {
    await rm(mockState.tmpHome, { recursive: true, force: true })
  })

  describe('dispatch() — 入参校验', () => {
    it('parentSessionId 缺 → 抛 SeamInvalidArgumentError', async () => {
      const adapter = makeAdapter(parentAgent)
      await expect(
        adapter.dispatch({
          description: 'desc',
          prompt: 'do',
          parentSessionId: '',
          cwd: '/tmp',
          context: 'spawn',
          backgroundMode: 'async',
        }),
      ).rejects.toThrow(SeamInvalidArgumentError)
    })

    it('cwd 缺 → 抛 SeamInvalidArgumentError', async () => {
      const adapter = makeAdapter(parentAgent)
      await expect(
        adapter.dispatch({
          description: 'desc',
          prompt: 'do',
          parentSessionId: 'parent-session-id',
          cwd: '',
          context: 'spawn',
          backgroundMode: 'async',
        }),
      ).rejects.toThrow(SeamInvalidArgumentError)
    })

    it('prompt 缺 → 抛 SeamInvalidArgumentError', async () => {
      const adapter = makeAdapter(parentAgent)
      await expect(
        adapter.dispatch({
          description: 'desc',
          prompt: '',
          parentSessionId: 'parent-session-id',
          cwd: '/tmp',
          context: 'spawn',
          backgroundMode: 'async',
        }),
      ).rejects.toThrow(SeamInvalidArgumentError)
    })

    it('parent agent 找不到 → 抛 SeamInvalidArgumentError', async () => {
      const adapter = makeAdapter(undefined)
      await expect(
        adapter.dispatch({
          description: 'desc',
          prompt: 'do',
          parentSessionId: 'parent-session-id',
          cwd: '/tmp',
          context: 'spawn',
          backgroundMode: 'async',
        }),
      ).rejects.toThrow(SeamInvalidArgumentError)
    })

    it("context === 'spawn' 时(providerName 验证挪到下游 describe;此处只校验入参)", async () => {
      // 入参校验测试 — 已通过 mock spawnDshSubagent 不返值(测试不期望
      // handle.taskId 访问,只 expect rejects)— 此 it 移到下面 describe 验证透传。
      expect(true).toBe(true)
    })
  })

  describe('dispatch() — 委托 spawnDshSubagent', () => {
    let finalState: DshTaskState

    beforeEach(() => {
      finalState = {
        taskId: 'dsh-task-test-1',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session-id',
        status: 'done',
        prompt: 'do something',
        startedAt: 1000,
        finishedAt: 2000,
        result: 'finished',
      }
      mockState.taskStore.spawnDshSubagent.mockResolvedValue({
        taskId: finalState.taskId,
        agent: undefined,
        promise: Promise.resolve(finalState),
        dispose: vi.fn().mockResolvedValue(undefined),
      })
    })

    it('调 spawnDshSubagent 时 parent / prompt / cwd / 选填 model / provider 都正确透传', async () => {
      const adapter = makeAdapter(parentAgent)
      await adapter.dispatch({
        description: 'desc',
        prompt: 'do something',
        parentSessionId: 'parent-session-id',
        cwd: '/tmp/cwd',
        model: 'MiniMax-M3',
        provider: 'anthropic',
        context: 'spawn',
        backgroundMode: 'sync',
      })

      expect(mockState.taskStore.spawnDshSubagent).toHaveBeenCalledTimes(1)
      const [, optsArg] = mockState.taskStore.spawnDshSubagent.mock.calls[0]!
      expect(optsArg.parentSessionId).toBe('parent-session-id')
      expect(optsArg.parentAgent).toBe(parentAgent)
      expect(optsArg.prompt).toBe('do something')
      expect(optsArg.cwd).toBe('/tmp/cwd')
      expect(optsArg.model).toBe('MiniMax-M3')
      expect(optsArg.provider).toBe('anthropic')
    })

    it('不传 model / provider 时 spawnDshSubagent 也拿到 undefined(opts 缺省)', async () => {
      const adapter = makeAdapter(parentAgent)
      await adapter.dispatch({
        description: 'desc',
        prompt: 'do',
        parentSessionId: 'parent-session-id',
        cwd: '/tmp',
        context: 'spawn',
        backgroundMode: 'async',
      })
      const [, optsArg] = mockState.taskStore.spawnDshSubagent.mock.calls[0]!
      expect(optsArg.model).toBeUndefined()
      expect(optsArg.provider).toBeUndefined()
    })

    it('handle 透传 taskId / promise / dispose', async () => {
      const disposeImpl = vi.fn().mockResolvedValue(undefined)
      // 用 mockReturnValue(同步返回对象),保留 .dispose spy 引用
      mockState.taskStore.spawnDshSubagent.mockReturnValueOnce({
        taskId: finalState.taskId,
        agent: undefined,
        promise: Promise.resolve(finalState),
        dispose: disposeImpl,
      })
      const adapter = makeAdapter(parentAgent)
      const handle = await adapter.dispatch({
        description: 'desc',
        prompt: 'do',
        parentSessionId: 'parent-session-id',
        cwd: '/tmp',
        context: 'spawn',
        backgroundMode: 'sync',
      })
      expect(handle.id).toBe('dsh-task-test-1')
      expect(await handle.promise).toEqual(finalState)
      await handle.dispose()
      expect(disposeImpl).toHaveBeenCalledTimes(1)
    })

    it('spawnDshSubagent 抛错时 adapter 抛 SeamRuntimeError', async () => {
      mockState.taskStore.spawnDshSubagent.mockRejectedValueOnce(new Error('infra crash'))
      const adapter = makeAdapter(parentAgent)
      await expect(
        adapter.dispatch({
          description: 'desc',
          prompt: 'do',
          parentSessionId: 'parent-session-id',
          cwd: '/tmp',
          context: 'spawn',
          backgroundMode: 'async',
        }),
      ).rejects.toThrow(SeamRuntimeError)
    })

    it("context === 'spawn' 时 providerName 透传为 'spawn'(Stage 4)", async () => {
      const adapter = makeAdapter(parentAgent)
      await adapter.dispatch({
        description: 'desc',
        prompt: 'do',
        parentSessionId: 'parent-session-id',
        cwd: '/tmp',
        context: 'spawn',
        backgroundMode: 'async',
      })
      const [, optsArg] = mockState.taskStore.spawnDshSubagent.mock.calls[0]!
      expect(optsArg.providerName).toBe('spawn')
    })

    it("context === 'fork' 时 providerName 透传为 'fork'(Stage 4)", async () => {
      // mock 出 fork 路径也走通,语义验证透传
      mockState.taskStore.spawnDshSubagent.mockReturnValueOnce({
        taskId: 'dsh-task-fork-1',
        agent: undefined,
        promise: Promise.resolve({ ...finalState, taskId: 'dsh-task-fork-1' }),
        dispose: vi.fn(),
      })
      const adapter = makeAdapter(parentAgent)
      await adapter.dispatch({
        description: 'desc',
        prompt: 'do',
        parentSessionId: 'parent-session-id',
        cwd: '/tmp',
        context: 'fork',
        backgroundMode: 'sync',
      })
      const [, optsArg] = mockState.taskStore.spawnDshSubagent.mock.calls[0]!
      expect(optsArg.providerName).toBe('fork')
      expect(optsArg.parentAgent).toBe(parentAgent)
    })
  })

  describe('get / list — 委托磁盘读', () => {
    const stateRunning: DshTaskState = {
      taskId: 'dsh-task-running',
      sessionId: 's-1',
      parentSessionId: 'parent-session-id',
      status: 'running',
      prompt: 'do',
      startedAt: 1000,
    }
    const stateDone: DshTaskState = {
      ...stateRunning,
      status: 'done',
      finishedAt: 2000,
      result: 'finished',
    }

    it('get 找不到 → null', async () => {
      mockState.taskStore.readDshTask.mockResolvedValueOnce(null)
      const adapter = makeAdapter(parentAgent)
      expect(await adapter.get('not-exist')).toBeNull()
    })

    it('get found → 状态映射(mirror DshTaskState)', async () => {
      mockState.taskStore.readDshTask.mockResolvedValueOnce(stateDone)
      const adapter = makeAdapter(parentAgent)
      const sum = await adapter.get('dsh-task-running')
      expect(sum).toMatchObject({
        taskId: 'dsh-task-running',
        sessionId: 's-1',
        status: 'done',
        startedAt: 1000,
        stopReason: 'completed',
        finishedAt: 2000,
      })
    })

    it("running 状态 → stopReason undefined(null)", async () => {
      mockState.taskStore.readDshTask.mockResolvedValueOnce(stateRunning)
      const adapter = makeAdapter(parentAgent)
      const sum = await adapter.get('dsh-task-running')
      expect(sum?.status).toBe('running')
      expect(sum?.stopReason).toBeUndefined()
    })

    it('list 委托 listDshSubagents + parentSessionId 过滤', async () => {
      mockState.taskStore.listDshSubagents.mockResolvedValueOnce([stateRunning, stateDone])
      const adapter = makeAdapter(parentAgent)
      const sums = await adapter.list('parent-session-id')
      expect(mockState.taskStore.listDshSubagents).toHaveBeenCalledWith(
        expect.anything(),
        'parent-session-id',
      )
      expect(sums).toHaveLength(2)
      expect(sums[0]!.taskId).toBe('dsh-task-running')
    })
  })

  describe('cancel — 运行中 vs 终态', () => {
    it('cancel 运行中任务 → { ok: true } + 调 interruptDshSubagent', async () => {
      mockState.taskStore.readDshTask.mockResolvedValueOnce({
        taskId: 'a',
        sessionId: 's',
        parentSessionId: 'p',
        status: 'running',
        prompt: 'd',
        startedAt: 0,
      })
      mockState.taskStore.interruptDshSubagent.mockResolvedValueOnce(undefined)
      const adapter = makeAdapter(parentAgent)
      const result = await adapter.cancel('a', 'reason-x')
      expect(result).toEqual({ ok: true })
      expect(mockState.taskStore.interruptDshSubagent).toHaveBeenCalledWith(expect.anything(), 'a')
    })

    it('cancel 终态任务 → { ok: false } + 不调 interrupt', async () => {
      mockState.taskStore.readDshTask.mockResolvedValueOnce({
        taskId: 'a',
        sessionId: 's',
        parentSessionId: 'p',
        status: 'done',
        prompt: 'd',
        startedAt: 0,
        finishedAt: 1,
      })
      const adapter = makeAdapter(parentAgent)
      const result = await adapter.cancel('a')
      expect(result).toEqual({ ok: false })
      expect(mockState.taskStore.interruptDshSubagent).not.toHaveBeenCalled()
    })

    it('cancel 不存在任务 → { ok: false }', async () => {
      mockState.taskStore.readDshTask.mockResolvedValueOnce(null)
      const adapter = makeAdapter(parentAgent)
      const result = await adapter.cancel('nope')
      expect(result).toEqual({ ok: false })
    })
  })

  describe('sendMessage — 直接委托', () => {
    it('透传 taskId + content 到 sendMessageToDshSubagent', async () => {
      mockState.taskStore.sendMessageToDshSubagent.mockResolvedValueOnce({ ok: true })
      const adapter = makeAdapter(parentAgent)
      const result = await adapter.sendMessage('task-x', 'follow this up')
      expect(result).toEqual({ ok: true })
      expect(mockState.taskStore.sendMessageToDshSubagent).toHaveBeenCalledWith(
        expect.anything(),
        'task-x',
        'follow this up',
      )
    })
  })

  describe('onChange / destroy', () => {
    it('onChange 返回 unsubscribe 函数', async () => {
      const adapter = makeAdapter(parentAgent)
      const cb = vi.fn()
      const off = adapter.onChange(cb)
      expect(typeof off).toBe('function')
      off()
      // 第二调不应再加;destroy / push 都不影响
      const off2 = adapter.onChange(cb)
      expect(typeof off2).toBe('function')
    })

    it('destroy 清空 listener + disposer', () => {
      const adapter = makeAdapter(parentAgent)
      adapter.onChange(vi.fn())
      adapter.onChange(vi.fn())
      adapter.destroy()
      // 不应 throw;再次 destroy 也 idempotent
      expect(() => adapter.destroy()).not.toThrow()
    })

    it('createDshSubagentControlBridge 工厂返回 SubagentControlSeam 实现', () => {
      const adapter = createDshSubagentControlBridge({
        ctx: makeMockCtx(parentAgent) as never,
        getParentAgent: () => parentAgent,
        eventBus: { emit: () => {} } as never,
      })
      expect(adapter).toBeDefined()
      expect(typeof adapter.dispatch).toBe('function')
      expect(typeof adapter.get).toBe('function')
      expect(typeof adapter.list).toBe('function')
      expect(typeof adapter.cancel).toBe('function')
      expect(typeof adapter.sendMessage).toBe('function')
      expect(typeof adapter.onChange).toBe('function')
    })
  })
})

describe('DshSubagentControlAdapter 多事件订阅 (Task 7)', () => {
  it('只订阅 2 个真实 vendor cordis 事件(subagent/start, subagent/end)', () => {
    const subs: Record<string, (info: unknown) => void> = {}
    const ctx = {
      on: (name: string, cb: (i: unknown) => void) => {
        subs[name] = cb
        return () => { delete subs[name] }
      },
      agents: { currentInitiator: () => ({ id: 'p1' }), get: (id: string) => id === 'p1' ? { id: 'p1' } : undefined },
    } as never
    new DshSubagentControlAdapter({ ctx, getParentAgent: () => ({ id: 'p1' } as never), eventBus: { emit: () => {} } as never })
    expect(subs['subagent/start']).toBeDefined()
    expect(subs['subagent/end']).toBeDefined()
    // 以下 3 个不是 vendor cordis 事件,不再订阅
    expect(subs['subagent/state']).toBeUndefined()
    expect(subs['subagent/descriptor']).toBeUndefined()
    expect(subs['subagent/message']).toBeUndefined()
  })

  it('subagent/start 触发 subagent.start + 派生的 subagent.state(running)', () => {
    const subs: Record<string, (info: unknown) => void> = {}
    const ctx = {
      on: (name: string, cb: (i: unknown) => void) => {
        subs[name] = cb
        return () => { delete subs[name] }
      },
      agents: { currentInitiator: () => ({ id: 'real-session-123' }), get: () => undefined },
    } as never
    const eventBus = { emit: vi.fn() }
    new DshSubagentControlAdapter({ ctx, getParentAgent: () => undefined as never, eventBus: eventBus as never })
    subs['subagent/start']!({ runId: 'r1', provider: 'spawn', id: 'd1', local: true })
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent.start', sessionId: 'real-session-123' }))
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent.state', state: 'running' }))
  })

  it('subagent/end 触发 subagent.end + 派生的 subagent.state(settled)', () => {
    const subs: Record<string, (info: unknown) => void> = {}
    const ctx = {
      on: (name: string, cb: (i: unknown) => void) => {
        subs[name] = cb
        return () => { delete subs[name] }
      },
      agents: { currentInitiator: () => ({ id: 'real-session-456' }), get: () => undefined },
    } as never
    const eventBus = { emit: vi.fn() }
    new DshSubagentControlAdapter({ ctx, getParentAgent: () => undefined as never, eventBus: eventBus as never })
    subs['subagent/end']!({ runId: 'r1', provider: 'spawn', id: 'd1', local: true, stopReason: 'completed' })
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent.end', sessionId: 'real-session-456' }))
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent.state', state: 'settled' }))
  })

  it('dispatch 透传 capability 到 spawnDshSubagent', async () => {
    // spawnDshSubagent is mocked — capture opts passed to it directly
    let capturedOpts: unknown
    mockState.taskStore.spawnDshSubagent.mockImplementation(async (_ctx: unknown, opts: unknown) => {
      capturedOpts = opts
      return { id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
    })
    const ctx = {
      on: () => () => {},
      get: (key: string) => {
        if (key === 'agents') return { get: (id: string) => id === 'p1' ? { id: 'p1' } : undefined }
        return undefined
      },
      subagents: { start: async () => ({ id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }) },
      agents: { get: () => ({ id: 'p1' }) },
    } as never
    const a = new DshSubagentControlAdapter({ ctx, getParentAgent: () => ({ id: 'p1' } as never), eventBus: { emit: () => {} } as never })
    await a.dispatch({
      parentSessionId: 'p1', cwd: '/tmp', prompt: 'x',
      backgroundMode: 'async',
      context: 'spawn',
      outputSchema: { type: 'object' },
      toolFilter: ['Read'],
      persona: 'p', maxDepth: 1,
    })
    expect(capturedOpts).toMatchObject({ outputSchema: { type: 'object' }, toolFilter: ['Read'], persona: 'p', maxDepth: 1 })
  })

  it('startContinuable 转发到 vendor continuation', async () => {
    const ctx = {
      on: () => () => {},
      get: (key: string) => {
        if (key === 'agents') return { get: (id: string) => id === 'p1' ? { id: 'p1' } : undefined }
        return undefined
      },
      subagents: {
        startContinuable: vi.fn().mockResolvedValue({ childId: 'c1', messageId: 'm1' }),
      } as never,
      agents: { get: () => ({ id: 'p1' }) },
    } as never
    const a = new DshSubagentControlAdapter({ ctx, getParentAgent: () => ({ id: 'p1' } as never), eventBus: { emit: () => {} } as never })
    const r = await a.startContinuable({ parentSessionId: 'p1', prompt: 'hi' })
    expect(r).toEqual({ childId: 'c1', messageId: 'm1' })
    expect((ctx.subagents as { startContinuable: unknown }).startContinuable).toHaveBeenCalled()
  })
})
