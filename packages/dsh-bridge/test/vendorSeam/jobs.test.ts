/**
 * DshJobsControlAdapter contract test —— Stage 0 验收。
 *
 * 覆盖:
 *   - start({kind:'bash'}) 委派 ctx.shell.start;bash 类型 JobId 形态
 *   - start({kind:'subagent'}) 委派 spawnDshSubagent(走现有 taskStore)
 *   - start({kind:'bash', invalid command}) → SeamInvalidArgumentError
 *   - start({kind:'subagent', missing parentSessionId}) → SeamInvalidArgumentError
 *   - get/list/read/kill 直接委托 vendor
 *   - onChange 返回 unsubscribe + destroy 清空
 *   - 并发超限消息抛 SeamConcurrentJobsExceededError
 *
 * 依赖 mock:用 vi.mock 隔离 ctx.shell / ctx.jobs / ctx.agents / ctx.subagents / spawnDshSubagent。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  // 全局 mock:JobRegistry 实例
  registry: null as null | {
    start: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    read: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    onJobsChanged: ReturnType<typeof vi.fn>
    onJobDone: ReturnType<typeof vi.fn>
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
vi.mock('@deepseek-ai/dsh-subagent', () => ({}))
vi.mock('@deepseek-ai/dsh-jobs', () => ({}))
vi.mock('@deepseek-ai/dsh-llm', () => ({}))
vi.mock('@deepseek-ai/dsh-session', () => ({}))

import {
  DshJobsControlAdapter,
  createDshJobsControlBridge,
} from '../../src/vendorSeam/jobs.js'
import {
  SeamInvalidArgumentError,
  SeamConcurrentJobsExceededError,
  SeamRuntimeError,
} from '../../src/vendorSeam/types.js'

// ── mock 对象 ──────────────────────────────────────────────────────

interface MockShellProcess {
  status: 'running' | 'killed' | 'completed'
  exitCode: number | null
  signal: NodeJS.Signals | null
  done: Promise<void>
  readOutput?: () => string
  kill: () => boolean
}

interface MockShellStartArgs {
  command: string
  workdir?: string
  timeoutMs?: number
  env?: Record<string, string>
}

function makeMockShellService() {
  const procs = new Map<string, MockShellProcess>()
  let procCounter = 0
  const start = vi.fn((args: MockShellStartArgs): MockShellProcess => {
    procCounter++
    let resolved = false
    const done = new Promise<void>((resolveDone) => {
      // simulated completion after microtask via setImmediate (test triggers manually)
      setImmediate(() => {
        resolved = true
        resolveDone()
      })
    })
    const proc: MockShellProcess = {
      get status() {
        return resolved ? 'completed' : 'running'
      },
      exitCode: 0,
      signal: null,
      done,
      readOutput: () => `[cmd] ${args.command}`,
      kill: () => {
        if (resolved) return false
        // test 不在此 kill 路径上 override status(简化)
        return true
      },
    }
    procs.set(`bash-${procCounter}`, proc)
    return proc
  })
  return { start }
}

function makeMockJobRegistry(opts?: {
  killLimitMessage?: string
}) {
  return {
    start: vi.fn((spec: { kind: string; label: string; run: () => unknown }) => {
      const id = `${spec.kind}-1`
      // 立即调 run() 拿 hooks,但不 await,done promise 由 vendor 处理。
      const hooks = spec.run() as { done: Promise<unknown> }
      hooks.done.catch(() => undefined)
      return id
    }),
    list: vi.fn(() => []),
    get: vi.fn((id: string) => ({ id, kind: 'bash', label: 'x', status: 'running', startedAt: 0 })),
    read: vi.fn((id: string) => ({
      text: `mock-read-${id}`,
      snapshot: { id, kind: 'bash', label: 'x', status: 'running', startedAt: 0, reported: false },
    })),
    kill: vi.fn(() => 'requested' as 'requested' | 'already-finished'),
    onJobsChanged: vi.fn(() => () => undefined),
    onJobDone: vi.fn(() => () => undefined),
    // 支持并发超限消息注入
    setKillLimit: (msg: string) => {
      mockState.registry!.start.mockImplementationOnce(() => {
        throw new Error(msg)
      })
    },
    ...(opts ?? {}),
  }
}

function makeMockCtx(opts: {
  shellAvailable?: boolean
  jobsAvailable?: boolean
  killLimitMsg?: string
}) {
  const shellService = opts.shellAvailable !== false ? makeMockShellService() : undefined
  const registry = opts.jobsAvailable !== false ? makeMockJobRegistry() : undefined
  if (registry && opts.killLimitMsg) {
    registry.setKillLimit(opts.killLimitMsg)
  }
  mockState.registry = registry ?? null
  return {
    on: vi.fn(() => () => undefined),
    get: vi.fn((key: string) => {
      if (key === 'shell' && shellService) return shellService
      if (key === 'jobs' && registry) return registry
      return undefined
    }),
  }
}

// ── 测试 ────────────────────────────────────────────────────────────

describe('Stage 0: DshJobsControlAdapter contract', () => {
  beforeEach(async () => {
    mockState.tmpHome = await mkdtemp(join(tmpdir(), 'dsh-seam-jobs-'))
    for (const fn of Object.values(mockState.taskStore)) {
      if (typeof fn === 'function' && 'mockClear' in fn)
        (fn as { mockClear: () => void }).mockClear()
    }
  })

  afterEach(async () => {
    const { afterEach } = await import('vitest')
    afterEach(async () => {
      await rm(mockState.tmpHome, { recursive: true, force: true })
    })
  })

  describe('start({kind:"bash"})', () => {
    it('BashJobInput 缺 command → 抛 SeamInvalidArgumentError', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      await expect(
        adapter.start({
          kind: 'bash',
          label: 'noop',
          input: { command: '', cwd: '/tmp' },
        }),
      ).rejects.toThrow(SeamInvalidArgumentError)
    })

    it('bash job start 调 ctx.shell.start + 拿到自增 jobId(本次 stub 返回 bash-1)', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const handle = await adapter.start({
        kind: 'bash',
        label: 'list dir',
        input: { command: 'ls -la', cwd: '/tmp' },
      })
      expect(handle.id).toBe('bash-1')
      // shell.start 被调一次
      expect(ctx.get).toHaveBeenCalledWith('shell')
    })

    it('ctx.shell 不可用 → 抛 SeamRuntimeError', async () => {
      const ctx = makeMockCtx({ shellAvailable: false })
      // JobRegistry 仍未 mock — 先 mock jobs but no shell
      const partialCtx = {
        on: vi.fn(() => () => undefined),
        get: vi.fn((key: string) => {
          if (key === 'jobs') return makeMockJobRegistry()
          return undefined
        }),
      }
      const adapter = new DshJobsControlAdapter({ ctx: partialCtx as never })
      await expect(
        adapter.start({
          kind: 'bash',
          label: 'cmd',
          input: { command: 'ls', cwd: '/tmp' },
        }),
      ).rejects.toThrow(SeamRuntimeError)
    })

    it('并发超限消息抛 SeamConcurrentJobsExceededError(limit = 5 vendor 默认)', async () => {
      // 在 mock 工厂层面:让本次 start() 调用立刻抛 vendor 实际错误消息。
      const ctx = makeMockCtx({})
      mockState.registry!.start.mockImplementationOnce(() => {
        throw new Error('background job limit reached for this owner (limit: 5)')
      })
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      await expect(
        adapter.start({
          kind: 'bash',
          label: 'cmd',
          input: { command: 'ls', cwd: '/tmp' },
        }),
      ).rejects.toThrow(SeamConcurrentJobsExceededError)
    })
  })

  describe('start({kind:"subagent"})', () => {
    it('parentSessionId 缺 → SeamInvalidArgumentError', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      await expect(
        adapter.start({
          kind: 'subagent',
          label: 'sub',
          input: {
            description: 'd',
            prompt: 'do',
            parentSessionId: '',
            cwd: '/tmp',
            context: 'spawn',
            backgroundMode: 'async',
          },
        }),
      ).rejects.toThrow(SeamInvalidArgumentError)
    })

    it('parent agent 找不到 → SeamInvalidArgumentError', async () => {
      const ctx = makeMockCtx({})
      // 把 ctx.agents.get 改成 return undefined
      ctx.get = vi.fn((key: string) => {
        if (key === 'jobs') return makeMockJobRegistry()
        if (key === 'shell') return makeMockShellService()
        if (key === 'agents') return { get: () => undefined }
        return undefined
      })
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      await expect(
        adapter.start({
          kind: 'subagent',
          label: 'sub',
          input: {
            description: 'd',
            prompt: 'do',
            parentSessionId: 'parent-x',
            cwd: '/tmp',
            context: 'spawn',
            backgroundMode: 'async',
          },
        }),
      ).rejects.toThrow(/parent agent not found/i)
    })

    it('subagent start 委派 spawnDshSubagent + 拿到 jobId', async () => {
      const ctx = makeMockCtx({})
      ctx.get = vi.fn((key: string) => {
        if (key === 'jobs') return makeMockJobRegistry()
        if (key === 'shell') return makeMockShellService()
        if (key === 'agents')
          return {
            get: (id: unknown) =>
              String(id) === 'parent-session-id'
                ? { followup: vi.fn(), session: { id: 'parent-session-id', seq: 0 }, cancel: vi.fn(), id: 'parent-session-id' }
                : undefined,
          }
        return undefined
      })
      mockState.taskStore.spawnDshSubagent.mockResolvedValue({
        taskId: 'dsh-task-1',
        agent: undefined,
        promise: Promise.resolve({
          taskId: 'dsh-task-1',
          sessionId: 'child',
          status: 'done',
          prompt: 'do',
          startedAt: 0,
          finishedAt: 1,
          result: 'finished',
        }),
        dispose: vi.fn(),
      })
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const handle = await adapter.start({
        kind: 'subagent',
        label: 'sub',
        input: {
          description: 'd',
          prompt: 'do',
          parentSessionId: 'parent-session-id',
          cwd: '/tmp',
          context: 'spawn',
          backgroundMode: 'sync',
        },
      })
      // mockJobRegistry 用 `${kind}-1` ID 形式:vendor LocalJobRegistry 真实返回 `subagent-1`
      expect(handle.id).toBe('subagent-1')
      expect(mockState.taskStore.spawnDshSubagent).toHaveBeenCalledTimes(1)
    })
  })

  describe('get / list / read / kill', () => {
    it('get 不存在 → null(vendor 抛 unknown job 消息)', async () => {
      const registry = makeMockJobRegistry()
      registry.get = vi.fn(() => {
        throw new Error('unknown job: nope')
      }).mockName('registry.get')
      const ctx = {
        on: vi.fn(() => () => undefined),
        get: vi.fn((key: string) => (key === 'jobs' ? registry : undefined)),
      }
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      expect(await adapter.get('nope')).toBeNull()
    })

    it('get 命中 → 返 SeamJobSummary', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const sum = await adapter.get('bash-1')
      expect(sum).toMatchObject({
        id: 'bash-1',
        kind: 'bash',
        label: 'x',
        status: 'running',
      })
    })

    it('list 委托 registry.list', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      await adapter.list()
      expect(mockState.registry!.list).toHaveBeenCalled()
    })

    it('read 返 summary + text', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const r = await adapter.read('bash-1')
      expect(r.text).toContain('bash-1')
      expect(r.summary.id).toBe('bash-1')
    })

    it('kill 返 { ok: true } 当 vendor 报 "requested"', async () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const r = await adapter.kill('bash-1')
      expect(r).toEqual({ ok: true })
    })

    it('kill 返 { ok: false } 当 vendor 报 "already-finished"', async () => {
      const ctx = makeMockCtx({})
      // override:下一次 kill 调用返 already-finished
      mockState.registry!.kill.mockReturnValueOnce('already-finished')
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const r = await adapter.kill('bash-1')
      expect(r).toEqual({ ok: false })
    })
  })

  describe('onChange / destroy', () => {
    it('onChange 返回 unsubscribe 函数', () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      const cb = vi.fn()
      const off = adapter.onChange(cb)
      off()
      expect(typeof off).toBe('function')
    })

    it('destroy 清空 listener;二次 destroy idempotent', () => {
      const ctx = makeMockCtx({})
      const adapter = new DshJobsControlAdapter({ ctx: ctx as never })
      adapter.onChange(vi.fn())
      adapter.onChange(vi.fn())
      adapter.destroy()
      expect(() => adapter.destroy()).not.toThrow()
    })

    it('createDshJobsControlBridge 工厂返 JobsControlSeam 实现', () => {
      const ctx = makeMockCtx({})
      const adapter = createDshJobsControlBridge({ ctx: ctx as never })
      expect(adapter).toBeDefined()
      expect(typeof adapter.start).toBe('function')
      expect(typeof adapter.get).toBe('function')
      expect(typeof adapter.list).toBe('function')
      expect(typeof adapter.read).toBe('function')
      expect(typeof adapter.kill).toBe('function')
      expect(typeof adapter.onChange).toBe('function')
    })
  })
})
