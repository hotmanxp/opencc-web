import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BashNotifier,
  renderBashNotificationMessage,
  flushPendingBashNotifications,
  __resetBashNotifierPendingForTests,
  __setBashNotifier,
} from '../../src/server/services/bashNotifier.js'
import {
  registerSessionController,
  releaseSessionController,
} from '../../src/server/services/agentRuntime.js'
import type { BashTaskInfo } from '@zn-ai/zn-agent-core'

let lastRunOpts: any = null
let queryCalls = 0
let runtimeEvents: Array<Record<string, unknown>> = [
  { type: 'message_start' },
  { type: 'message_stop' },
]

// B7 (dsh-009/010): mock 从 getRuntime().query 改为 getKernelAdapter().run;
// run() 内部走真实 translateRuntimeEvents (factory 行为同步)。
const { translateRuntimeEvents } = await import('../../src/server/services/translation.js')

const mockAdapter = {
  kernel: 'opencc',
  start: async () => {},
  shutdown: async () => {},
  createSession: async (opts: any) => ({ kernel: 'opencc', sessionId: opts.sessionId ?? 'sess-parent', cwd: opts.cwd ?? '/tmp' }),
  resumeSession: async (opts: any) => ({ kernel: 'opencc', sessionId: opts.sessionId, cwd: opts.cwd ?? '/tmp' }),
  listSessions: async () => [],
  deleteSession: async () => {},
  run: (opts: any) => {
    lastRunOpts = opts
    queryCalls += 1
    const rawStream = (async function* () {
      for (const ev of runtimeEvents) yield ev
    })()
    return translateRuntimeEvents(rawStream, opts.session?.sessionId ?? 'sess-parent')
  },
  abort: async () => {},
  patchTranscript: async () => {},
  readTranscript: async function* () {},
  onAsk: () => () => {},
  onApprove: () => () => {},
  subscribeState: () => () => {},
  enqueue: async () => {},
  metrics: () => ({
    activeSessions: 0,
    totalTurns: 0,
    totalToolCalls: 0,
    totalApiRequests: 0,
    startedAt: Date.now(),
  }),
}

function makeTask(overrides: Partial<BashTaskInfo> = {}): BashTaskInfo {
  return {
    taskId: 'bash-1',
    sessionId: 'sess-parent',
    command: 'npm run build',
    description: 'build',
    startedAt: 1,
    status: 'completed',
    stdout: '',
    stderr: '',
    isBackgrounded: true,
    notified: false,
    ...overrides,
  }
}

beforeEach(() => {
  lastRunOpts = null
  queryCalls = 0
  runtimeEvents = [
    { type: 'message_start' },
    { type: 'message_stop' },
  ]
})

afterEach(() => {
  releaseSessionController('sess-parent')
  __resetBashNotifierPendingForTests()
  __setBashNotifier(null)
  vi.restoreAllMocks()
})

describe('BashNotifier.handle', () => {
  // zai patch (2026-08-22): BashNotifier 不再自动注入 <task-notification> 触发
  // 新 turn。handle() 是 no-op,只保留入参守卫避免静默吞掉异常。
  // UI 仍通过 stateBridge 'bash_task.changed' SSE 推送任务状态。
  test('任何合法入参都不触发 adapter.run(已禁用自动注入)', async () => {
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    expect(lastRunOpts).toBeNull()
    expect(queryCalls).toBe(0)
  })

  test('failed / killed → 同样 no-op,不触发 query', async () => {
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({
      sessionId: 'sess-parent',
      task: makeTask({ status: 'failed', exitCode: 1 }),
    })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ status: 'killed' }) })
    expect(lastRunOpts).toBeNull()
    expect(queryCalls).toBe(0)
  })

  test('status=running (非 terminal) → 不触发 query', async () => {
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ status: 'running' }) })
    expect(lastRunOpts).toBeNull()
  })

  test('sessionId 为空字符串 → 不触发 query', async () => {
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: '', task: makeTask() })
    expect(lastRunOpts).toBeNull()
  })

  test('sessionId=sess-unknown (父 session 占位) → 不触发 query', async () => {
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: 'sess-unknown', task: makeTask() })
    expect(lastRunOpts).toBeNull()
  })

  test('isBackgrounded=false (前台命令完成) → 不触发 query', async () => {
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({
      sessionId: 'sess-parent',
      task: makeTask({ isBackgrounded: false }),
    })
    expect(lastRunOpts).toBeNull()
  })

  test('主线有活跃 query → 仍 no-op(已禁用,守卫随之失效)', async () => {
    registerSessionController('sess-parent', new AbortController())
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    expect(lastRunOpts).toBeNull()
    expect(queryCalls).toBe(0)
  })

  test('主线结束后 flushPendingBashNotifications → 仅清 pending,不补发', async () => {
    __setBashNotifier(new BashNotifier({ getKernelAdapter: () => mockAdapter as any }))
    registerSessionController('sess-parent', new AbortController())
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    expect(queryCalls).toBe(0)
    releaseSessionController('sess-parent')
    flushPendingBashNotifications('sess-parent')
    await new Promise((r) => setTimeout(r, 10))
    // 关键断言:flush 后**没有**任何 query 起来。
    expect(queryCalls).toBe(0)
    expect(lastRunOpts).toBeNull()
  })

  test('主线活跃时多个通知全部被丢弃,flush 后不补发', async () => {
    __setBashNotifier(new BashNotifier({ getKernelAdapter: () => mockAdapter as any }))
    registerSessionController('sess-parent', new AbortController())
    const n = new BashNotifier({ getKernelAdapter: () => mockAdapter as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ taskId: 't1' }) })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ taskId: 't2' }) })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ taskId: 't3' }) })
    expect(queryCalls).toBe(0)
    releaseSessionController('sess-parent')
    flushPendingBashNotifications('sess-parent')
    await new Promise((r) => setTimeout(r, 10))
    // 3 个通知全部被丢弃,无任何 query
    expect(queryCalls).toBe(0)
  })
})

describe('renderBashNotificationMessage', () => {
  test('包含 task-id / status / summary 并带"不续跑主任务"引导', () => {
    const msg = renderBashNotificationMessage(makeTask())
    expect(msg).toContain('<task-notification>')
    expect(msg).toContain('<task-id>bash-1</task-id>')
    expect(msg).toContain('<status>completed</status>')
    expect(msg).toContain('Background command "build" completed')
    expect(msg).toContain('do not resume, restart, or continue the main task')
  })

  test('exitCode 反映在 summary', () => {
    const msg = renderBashNotificationMessage(
      makeTask({ status: 'failed', exitCode: 137 }),
    )
    expect(msg).toContain('failed with exit code 137')
  })
})
