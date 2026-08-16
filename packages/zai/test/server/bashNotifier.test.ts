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

const mockRuntime = {
  query: (opts: any) => {
    lastRunOpts = opts
    queryCalls += 1
    return (async function* () {
      for (const ev of runtimeEvents) yield ev
    })()
  },
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
  test('completed + 有效 sessionId → 触发通知 query,携带 <task-notification> 内容', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    expect(lastRunOpts).not.toBeNull()
    expect(lastRunOpts.sessionId).toBe('sess-parent')
    expect(lastRunOpts.prompt).toContain('<task-notification>')
    expect(lastRunOpts.prompt).toContain('<task-id>bash-1</task-id>')
    expect(lastRunOpts.prompt).toContain('<status>completed</status>')
    // 不再依赖 vendor commandQueue drain:真实通知内容直接作为 prompt,
    // 而不是占位引导(isMeta 保持 UI 隐藏)。
    expect(lastRunOpts.isMeta).toBe(true)
  })

  test('failed / killed → 同样触发通知 query,summary 反映失败', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({
      sessionId: 'sess-parent',
      task: makeTask({ status: 'failed', exitCode: 1 }),
    })
    expect(lastRunOpts.prompt).toContain('<status>failed</status>')
    expect(lastRunOpts.prompt).toContain('failed with exit code 1')
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ status: 'killed' }) })
    expect(lastRunOpts.prompt).toContain('<status>killed</status>')
    expect(lastRunOpts.prompt).toContain('was stopped')
  })

  test('status=running (非 terminal) → 不触发 query', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ status: 'running' }) })
    expect(lastRunOpts).toBeNull()
  })

  test('sessionId 为空字符串 → 不触发 query', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: '', task: makeTask() })
    expect(lastRunOpts).toBeNull()
  })

  test('sessionId=sess-unknown (父 session 占位) → 不触发 query', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-unknown', task: makeTask() })
    expect(lastRunOpts).toBeNull()
  })

  test('isBackgrounded=false (前台命令完成) → 不触发 query', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({
      sessionId: 'sess-parent',
      task: makeTask({ isBackgrounded: false }),
    })
    expect(lastRunOpts).toBeNull()
  })

  test('主线有活跃 query (running 守卫) → 通知暂存,不另起 query', async () => {
    registerSessionController('sess-parent', new AbortController())
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    // 主线活跃时绝不并行起 query
    expect(lastRunOpts).toBeNull()
    expect(queryCalls).toBe(0)
  })

  test('主线结束后 flushPendingBashNotifications → 补发注入通知', async () => {
    // flush 走模块单例,先注册带 mock runtime 的单例
    __setBashNotifier(new BashNotifier({ getRuntime: () => mockRuntime as any }))
    registerSessionController('sess-parent', new AbortController())
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    expect(queryCalls).toBe(0)
    // 主线结束(idle),flush 补发 → 通知 query 起来,内容完整
    releaseSessionController('sess-parent')
    flushPendingBashNotifications('sess-parent')
    // flush 是 fire-and-forget,等微任务
    await new Promise((r) => setTimeout(r, 10))
    expect(queryCalls).toBe(1)
    expect(lastRunOpts.sessionId).toBe('sess-parent')
    expect(lastRunOpts.prompt).toContain('<task-id>bash-1</task-id>')
  })

  test('主线活跃时多个通知全部暂存,flush 后逐个补发(通知 query 之间不并行)', async () => {
    __setBashNotifier(new BashNotifier({ getRuntime: () => mockRuntime as any }))
    registerSessionController('sess-parent', new AbortController())
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ taskId: 't1' }) })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ taskId: 't2' }) })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ taskId: 't3' }) })
    expect(queryCalls).toBe(0)
    releaseSessionController('sess-parent')
    flushPendingBashNotifications('sess-parent')
    await new Promise((r) => setTimeout(r, 10))
    // 3 条通知串行补发,互不并行
    expect(queryCalls).toBe(3)
  })

  test('runtime.query 抛错 → handle 不抛,仅 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = {
      query: () => {
        throw new Error('runtime blew up')
      },
    }
    const n = new BashNotifier({ getRuntime: () => broken as any })
    await expect(n.handle({ sessionId: 'sess-parent', task: makeTask() })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
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
