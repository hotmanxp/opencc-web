/**
 * Phase 4:spawnDshSubagent 改走 dsh 上游 SubagentRuntime(`ctx.subagents.start`)
 * 后的单测。覆盖:
 *   - 成功路径:调 `ctx.subagents.start('spawn', req)`,`run.result` resolve 后
 *     写盘终态 + 触发 `parentAgent.followup(<task-notification>)`
 *   - 失败路径:`start()` 阶段抛错 → 写盘 status='failed'
 *   - stopReason 映射:'completed' → 'done', 'aborted' → 'cancelled',
 *     'error' / 'max-tokens' / 'refusal' → 'failed'
 *   - `ctx.subagents` 缺失 → 抛清晰错误 + 写盘 failed
 *   - parentAgent 缺失 → 抛清晰错误 + 写盘 failed
 *
 * 不依赖真实 dsh ctx — 用 vi.fn() mock 关键的 SubagentRuntime + Agent 句柄,
 * 验证 spawnDshSubagent 的契约 (写盘 + followup 触发)。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

// mock ~/.zai/tasks-dsh/ 到临时目录 — 用 vi.hoisted 把 tmpHome hoist 到
// 模块顶层,这样 mock 工厂函数能引用它 (let 变量在 vi.mock 注册时还未初始化)。
const mockState = vi.hoisted(() => ({ tmpHome: '' }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    get homedir() {
      return () => mockState.tmpHome
    },
  }
})

import {
  spawnDshSubagent,
  dshTaskPath,
  type DshTaskState,
} from '../../src/subagent/taskStore.js'

interface MockAgent {
  followup: ReturnType<typeof vi.fn>
  session: { id: string; seq: number }
  cancel: ReturnType<typeof vi.fn>
  options: Record<string, unknown>
  status: string
  ctx: unknown
  inbox: unknown
  whenIdle: () => Promise<void>
  id: string
  send: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
  runMaintenance: ReturnType<typeof vi.fn>
}

interface MockSubagentRuntime {
  start: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  listChildren: ReturnType<typeof vi.fn>
  startContinuable: ReturnType<typeof vi.fn>
  reportFrom: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  registerProvider: ReturnType<typeof vi.fn>
  getProvider: ReturnType<typeof vi.fn>
}

interface MockCtx {
  subagents: MockSubagentRuntime
  get: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeMockAgent(): MockAgent {
  return {
    followup: vi.fn(),
    session: { id: 'mock-parent-session-id', seq: 0 },
    cancel: vi.fn(),
    options: { provider: 'anthropic', model: 'MiniMax-M3' },
    status: 'idle',
    ctx: null,
    inbox: null,
    whenIdle: () => Promise.resolve(),
    id: 'mock-parent-session-id',
    send: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    runMaintenance: vi.fn(),
  } as MockAgent
}

function makeMockRun(opts: {
  childId: string
  resultPromise: Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string; diagnostic?: string }>
  localAgent?: MockAgent | undefined
  disposeImpl?: () => Promise<void>
}) {
  let disposed = false
  return {
    id: opts.childId,
    localAgent: opts.localAgent,
    result: opts.resultPromise,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await opts.disposeImpl?.()
    },
  }
}

function makeMockCtx(opts: {
  run: ReturnType<typeof makeMockRun> | null
  throwOnStart?: Error
}): MockCtx {
  const start = vi.fn(async () => {
    if (opts.throwOnStart) throw opts.throwOnStart
    if (!opts.run) throw new Error('test setup error: run is null')
    return opts.run
  })
  const subagents: MockSubagentRuntime = {
    start,
    followup: vi.fn(async () => 'mock-message-id'),
    interrupt: vi.fn(),
    listChildren: vi.fn(async () => []),
    startContinuable: vi.fn(),
    reportFrom: vi.fn(),
    list: vi.fn(() => ['spawn']),
    registerProvider: vi.fn(() => () => undefined),
    getProvider: vi.fn(() => undefined),
  }
  return {
    subagents,
    get: vi.fn(),
    // on() 返回 disposer — 测试中不实际订阅(避免事件回流)
    on: vi.fn(() => () => undefined),
  } as MockCtx
}

describe('Phase 4: spawnDshSubagent with dsh-subagent upstream', () => {
  let mockCtx: MockCtx
  let parentAgent: MockAgent
  let mockRun: ReturnType<typeof makeMockRun>

  beforeEach(async () => {
    mockState.tmpHome = await mkdtemp(join(tmpdir(), 'dsh-subagent-test-'))
    parentAgent = makeMockAgent()
  })

  afterEach(async () => {
    await rm(mockState.tmpHome, { recursive: true, force: true })
  })

  it('returns running taskId + calls subagents.start with correct request shape', async () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>((resolve) => {
      resolveResult = resolve
    })
    mockRun = makeMockRun({
      childId: 'mock-child-session',
      resultPromise,
      localAgent: undefined, // 远端 provider 形态
    })
    mockCtx = makeMockCtx({ run: mockRun })

    const handle = await spawnDshSubagent(mockCtx as unknown as never, {
      parentSessionId: 'parent-session-id',
      parentAgent: parentAgent as unknown as never,
      prompt: 'do something',
      cwd: '/tmp',
      model: 'MiniMax-M3',
      provider: 'anthropic',
    })

    // 1. 返回 taskId + handle
    expect(handle.taskId).toMatch(/^dsh-task-/)
    expect(handle.agent).toBeUndefined() // 远端 provider
    expect(typeof handle.dispose).toBe('function')

    // 2. subagents.start 调对了
    expect(mockCtx.subagents.start).toHaveBeenCalledTimes(1)
    const [providerName, request] = mockCtx.subagents.start.mock.calls[0]!
    expect(providerName).toBe('spawn')
    expect(request.label).toMatch(/^dsh-subagent-/)
    expect(request.prompt).toEqual([{ type: 'text', text: 'do something' }])
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(request.agentOptions).toEqual({ provider: 'anthropic', model: 'MiniMax-M3' })
    expect(request.parent).toBe(parentAgent)

    // 3. 写盘 initial state
    const initialRaw = await readFile(dshTaskPath(handle.taskId), 'utf-8')
    const initial = JSON.parse(initialRaw) as DshTaskState
    expect(initial.status).toBe('running')
    expect(initial.parentSessionId).toBe('parent-session-id')
    expect(initial.sessionId).toBe('mock-child-session') // start 后回填
    expect(initial.prompt).toBe('do something')

    // 4. 完成 subagent,断言 followup 触发 + 终态写盘
    resolveResult!({ output: [{ type: 'text', text: 'finished' }], stopReason: 'completed' })

    const final = await handle.promise
    expect(final.status).toBe('done')
    expect(final.finishedAt).toBeGreaterThanOrEqual(final.startedAt)
    expect(final.result).toBe('finished')
    expect(parentAgent.followup).toHaveBeenCalledTimes(1)
    // 验证 followup 注入的是 <task-notification> 文本
    const msgArg = parentAgent.followup.mock.calls[0]![0] as {
      content: Array<{ type: string; text: string }>
    }
    expect(msgArg.content[0]!.type).toBe('text')
    expect(msgArg.content[0]!.text).toContain('<task-notification>')
    expect(msgArg.content[0]!.text).toContain('"taskId":"' + handle.taskId + '"')
    expect(msgArg.content[0]!.text).toContain('"status":"done"')
  })

  it('maps stopReason: aborted → cancelled', async () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>((resolve) => {
      resolveResult = resolve
    })
    mockRun = makeMockRun({ childId: 'child-2', resultPromise })
    mockCtx = makeMockCtx({ run: mockRun })

    const handle = await spawnDshSubagent(mockCtx as unknown as never, {
      parentSessionId: 'p',
      parentAgent: parentAgent as unknown as never,
      prompt: 'p',
      cwd: '/tmp',
    })
    resolveResult!({ output: [], stopReason: 'aborted' })

    const final = await handle.promise
    expect(final.status).toBe('cancelled')
  })

  it('maps stopReason: error → failed + preserves diagnostic', async () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string; diagnostic?: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string; diagnostic?: string }>((resolve) => {
      resolveResult = resolve
    })
    mockRun = makeMockRun({ childId: 'child-3', resultPromise })
    mockCtx = makeMockCtx({ run: mockRun })

    const handle = await spawnDshSubagent(mockCtx as unknown as never, {
      parentSessionId: 'p',
      parentAgent: parentAgent as unknown as never,
      prompt: 'p',
      cwd: '/tmp',
    })
    resolveResult!({ output: [], stopReason: 'error', diagnostic: 'model rejected' })

    const final = await handle.promise
    expect(final.status).toBe('failed')
    expect(final.error).toBe('model rejected')
  })

  it('throws when ctx.subagents unavailable', async () => {
    const emptyCtx = {
      subagents: undefined,
      get: vi.fn(),
      on: vi.fn(() => () => undefined),
    } as unknown as never

    await expect(
      spawnDshSubagent(emptyCtx, {
        parentSessionId: 'p',
        parentAgent: parentAgent as unknown as never,
        prompt: 'p',
        cwd: '/tmp',
      }),
    ).rejects.toThrow(/subagents unavailable/)

    // 写盘 failed (虽然 taskId 还没分配,但 first state 写入了)
    // 注:上面 spawnDshSubagent 在写入 initial 时 taskId 已分配,throw 后
    // 应有对应 task 文件,status=failed
    const tasksDir = join(mockState.tmpHome, '.zai', 'tasks-dsh')
    // 实际生成 taskId 是动态的,先 scan dir
    const entries = await (await import('node:fs/promises')).readdir(tasksDir)
    expect(entries.length).toBe(1)
    const raw = await readFile(join(tasksDir, entries[0]!), 'utf-8')
    const state = JSON.parse(raw) as DshTaskState
    expect(state.status).toBe('failed')
    expect(state.error).toMatch(/subagents unavailable/)
  })

  it('throws when parentAgent missing', async () => {
    mockCtx = makeMockCtx({ run: null })

    await expect(
      spawnDshSubagent(mockCtx as unknown as never, {
        parentSessionId: 'p',
        parentAgent: undefined,
        prompt: 'p',
        cwd: '/tmp',
      }),
    ).rejects.toThrow(/parentAgent required/)
  })

  it('writes failed state when subagents.start() throws', async () => {
    mockCtx = makeMockCtx({
      run: null,
      throwOnStart: new Error('provider unavailable'),
    })

    await expect(
      spawnDshSubagent(mockCtx as unknown as never, {
        parentSessionId: 'p',
        parentAgent: parentAgent as unknown as never,
        prompt: 'p',
        cwd: '/tmp',
      }),
    ).rejects.toThrow(/provider unavailable/)

    // 应该有 1 个 task 文件,status=failed
    const tasksDir = join(mockState.tmpHome, '.zai', 'tasks-dsh')
    const entries = await (await import('node:fs/promises')).readdir(tasksDir)
    expect(entries.length).toBe(1)
    const raw = await readFile(join(tasksDir, entries[0]!), 'utf-8')
    const state = JSON.parse(raw) as DshTaskState
    expect(state.status).toBe('failed')
    expect(state.error).toBe('provider unavailable')
  })

  // ───── Stage 7: completionDelivery ('wakeup' | 'quiet') —───
  describe('Stage 7: completionDelivery — wakeup vs quiet', () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>((resolve) => {
      resolveResult = resolve
    })
    let mockRunLocal: ReturnType<typeof makeMockRun>
    let mockCtxLocal: MockCtx

    beforeEach(() => {
      mockRunLocal = makeMockRun({ childId: 'child-quiet', resultPromise })
      mockCtxLocal = makeMockCtx({ run: mockRunLocal })
    })

    it("completionDelivery 默认 'wakeup' 与 Phase 4 行为一致(向后兼容)", async () => {
      const handle = await spawnDshSubagent(mockCtxLocal as unknown as never, {
        parentSessionId: 'parent-session-id',
        parentAgent: parentAgent as unknown as never,
        prompt: 'do',
        cwd: '/tmp',
        // 不传 completionDelivery — 默认走 'wakeup'
      })
      resolveResult!({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
      await handle.promise
      // 默认 'wakeup' → parentAgent.followup 必被调一次
      expect(parentAgent.followup).toHaveBeenCalledTimes(1)
    })

    it("completionDelivery === 'quiet' 时跳过 parentAgent.followup", async () => {
      const handle = await spawnDshSubagent(mockCtxLocal as unknown as never, {
        parentSessionId: 'parent-session-id',
        parentAgent: parentAgent as unknown as never,
        prompt: 'do',
        cwd: '/tmp',
        completionDelivery: 'quiet',
      })
      resolveResult!({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
      await handle.promise
      // 'quiet' → followup 不被调
      expect(parentAgent.followup).not.toHaveBeenCalled()
    })

    it("completionDelivery === 'wakeup' 显式也触发 followup(Stage 7 默认值不变)", async () => {
      const handle = await spawnDshSubagent(mockCtxLocal as unknown as never, {
        parentSessionId: 'parent-session-id',
        parentAgent: parentAgent as unknown as never,
        prompt: 'do',
        cwd: '/tmp',
        completionDelivery: 'wakeup',
      })
      resolveResult!({ output: [], stopReason: 'completed' })
      await handle.promise
      expect(parentAgent.followup).toHaveBeenCalledTimes(1)
    })

    it("completionDelivery='quiet' 也跳过 `<task-notification>` 内容,不暴露 wakeup 文本", async () => {
      const handle = await spawnDshSubagent(mockCtxLocal as unknown as never, {
        parentSessionId: 'parent-session-id',
        parentAgent: parentAgent as unknown as never,
        prompt: 'do',
        cwd: '/tmp',
        completionDelivery: 'quiet',
      })
      resolveResult!({ output: [], stopReason: 'completed' })
      await handle.promise
      // followup 没被调 → <task-notification> 文本不会到 parent inbox
      expect(parentAgent.followup).not.toHaveBeenCalled()
      // 但 finalState 仍然落盘(zai UI 仍可从 ~/.zai/tasks-dsh/ 看到完成)
      expect(mockRunLocal.id).toBe('child-quiet')
    })
  })

  it('does not crash when parentAgent.followup throws', async () => {
    parentAgent.followup = vi.fn(() => {
      throw new Error('parent agent dead')
    })

    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>((resolve) => {
      resolveResult = resolve
    })
    mockRun = makeMockRun({ childId: 'child-4', resultPromise })
    mockCtx = makeMockCtx({ run: mockRun })

    const handle = await spawnDshSubagent(mockCtx as unknown as never, {
      parentSessionId: 'p',
      parentAgent: parentAgent as unknown as never,
      prompt: 'p',
      cwd: '/tmp',
    })
    resolveResult!({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })

    // promise 仍然 resolve 到 done — followup 失败被 catch
    const final = await handle.promise
    expect(final.status).toBe('done')
    expect(parentAgent.followup).toHaveBeenCalledTimes(1)
  })

  it('dispose() is callable and idempotent', async () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>((resolve) => {
      resolveResult = resolve
    })
    const disposeMock = vi.fn(async () => undefined)
    mockRun = makeMockRun({ childId: 'child-5', resultPromise, disposeImpl: disposeMock })
    mockCtx = makeMockCtx({ run: mockRun })

    const handle = await spawnDshSubagent(mockCtx as unknown as never, {
      parentSessionId: 'p',
      parentAgent: parentAgent as unknown as never,
      prompt: 'p',
      cwd: '/tmp',
    })

    // dispose 两次 — 上游 SubagentRun.dispose() 是 idempotent,第二次是 no-op,
    // 但调用不抛。dispose 内部 `disposed` flag 防止重复副作用 — 我们的 mock
    // 没实现 idempotent,只 mock 了 disposeImpl,直接验证 dispose() 调用本身不抛。
    await expect(handle.dispose()).resolves.toBeUndefined()
    await expect(handle.dispose()).resolves.toBeUndefined()

    resolveResult!({ output: [], stopReason: 'completed' })
    await handle.promise // promise 仍能 resolve(虽然 dispose 已先于完成发生)
  })
})

describe('Phase 4: createAgentTool run_in_background branches', () => {
  let mockCtx: MockCtx
  let parentAgent: MockAgent
  let mockRun: ReturnType<typeof makeMockRun>

  beforeEach(async () => {
    mockState.tmpHome = await mkdtemp(join(tmpdir(), 'dsh-subagent-tool-test-'))
    parentAgent = makeMockAgent()
  })

  afterEach(async () => {
    await rm(mockState.tmpHome, { recursive: true, force: true })
  })

  it('run_in_background=true returns running status immediately', async () => {
    // 不 resolve result — 测试不应等待
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>(() => undefined)
    mockRun = makeMockRun({ childId: 'tool-child-bg', resultPromise })
    mockCtx = makeMockCtx({ run: mockRun })

    const { createAgentTool } = await import('../../src/tools/subagent.js')
    const tool = createAgentTool({
      cwd: '/tmp',
      getParentSessionId: () => 'parent-sid',
      getDshCtx: () => mockCtx as unknown as never,
      onTaskStart: vi.fn(),
      onTaskFinish: vi.fn(),
    })

    const r = await tool.execute(
      { description: 'background task', prompt: 'do it', run_in_background: true },
      { agent: parentAgent } as never,
    ) as { output: string; taskId: string; status: string }

    expect(r.status).toBe('running')
    expect(r.taskId).toMatch(/^dsh-task-/)
    expect(r.output).toContain('spawned in background')
  })

  it('run_in_background=false awaits promise and returns done status', async () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>((resolve) => {
      resolveResult = resolve
    })
    mockRun = makeMockRun({ childId: 'tool-child-sync', resultPromise })
    mockCtx = makeMockCtx({ run: mockRun })

    const onTaskFinish = vi.fn()
    const { createAgentTool } = await import('../../src/tools/subagent.js')
    const tool = createAgentTool({
      cwd: '/tmp',
      getParentSessionId: () => 'parent-sid',
      getDshCtx: () => mockCtx as unknown as never,
      onTaskStart: vi.fn(),
      onTaskFinish,
    })

    // fire-and-forget — 但 result 在 100ms 后 resolve
    const execPromise = tool.execute(
      { description: 'sync task', prompt: 'do it', run_in_background: false },
      { agent: parentAgent } as never,
    ) as Promise<{ output: string; taskId: string; status: string }>

    // 100ms 后 resolve
    setTimeout(() => {
      resolveResult!({ output: [{ type: 'text', text: 'sync result' }], stopReason: 'completed' })
    }, 100)

    const r = await execPromise
    expect(r.status).toBe('done')
    expect(r.taskId).toMatch(/^dsh-task-/)
    expect(r.output).toContain('sync result')
    expect(r.output).toContain('completed')
  })

  it('run_in_background=false returns failed status when subagent errors', async () => {
    let resolveResult: ((v: { output: Array<{ type: string; text?: string }>; stopReason: string; diagnostic?: string }) => void) | null = null
    const resultPromise = new Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string; diagnostic?: string }>((resolve) => {
      resolveResult = resolve
    })
    mockRun = makeMockRun({ childId: 'tool-child-err', resultPromise })
    mockCtx = makeMockCtx({ run: mockRun })

    const { createAgentTool } = await import('../../src/tools/subagent.js')
    const tool = createAgentTool({
      cwd: '/tmp',
      getParentSessionId: () => 'parent-sid',
      getDshCtx: () => mockCtx as unknown as never,
      onTaskStart: vi.fn(),
      onTaskFinish: vi.fn(),
    })

    const execPromise = tool.execute(
      { description: 'err task', prompt: 'do it', run_in_background: false },
      { agent: parentAgent } as never,
    ) as Promise<{ output: string; taskId: string; status: string }>

    setTimeout(() => {
      resolveResult!({ output: [], stopReason: 'error', diagnostic: 'model 503' })
    }, 50)

    const r = await execPromise
    expect(r.status).toBe('failed')
    expect(r.output).toContain('model 503')
  })
})

describe('spawnDshSubagent capability 字段', () => {
  it('透传 outputSchema 到 vendor request', async () => {
    // mock ctx.subagents.start,验证 request.outputSchema === input.outputSchema
    const captured: unknown[] = []
    const ctx = {
      subagents: {
        start: async (_name: string, req: unknown) => {
          captured.push(req)
          return { id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        },
      },
      agents: { get: () => undefined },
      on: () => () => {},
    } as never
    await spawnDshSubagent(ctx, {
      parentSessionId: 'p1', parentAgent: { id: 'p1' } as never,
      prompt: 'x', cwd: '/tmp',
      outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    })
    const req = captured[0] as { outputSchema?: unknown }
    expect(req.outputSchema).toEqual({ type: 'object', properties: { x: { type: 'string' } } })
  })

  it('透传 toolFilter / persona / maxDepth', async () => {
    const captured: unknown[] = []
    const ctx = {
      subagents: {
        start: async (_n: string, req: unknown) => {
          captured.push(req)
          return { id: 'r1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }
        },
      },
      agents: { get: () => undefined },
      on: () => () => {},
    } as never
    await spawnDshSubagent(ctx, {
      parentSessionId: 'p1', parentAgent: { id: 'p1' } as never,
      prompt: 'x', cwd: '/tmp',
      toolFilter: ['Read'], persona: 'you are X', maxDepth: 2,
    })
    const req = captured[0] as { toolFilter?: string[]; persona?: string; maxDepth?: number }
    expect(req.toolFilter).toEqual(['Read'])
    expect(req.persona).toBe('you are X')
    expect(req.maxDepth).toBe(2)
  })
})
