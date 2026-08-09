import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  SubagentNotifier,
  renderTaskNotificationMessage,
  flushPendingSubagentNotifications,
  __resetSubagentNotifierPendingForTests,
  __setSubagentNotifier,
} from '../../src/server/services/subagentNotifier.js'
import {
  registerSessionController,
  releaseSessionController,
} from '../../src/server/services/agentRuntime.js'
import type { BackgroundTask } from '@zn-ai/zn-agent-core'

let lastRunOpts: any = null
let runtimeEvents: Array<Record<string, unknown>> = [
  { type: 'message_start' },
  { type: 'message_stop' },
]

const mockRuntime = {
  query: (opts: any) => {
    lastRunOpts = opts
    return (async function* () {
      for (const ev of runtimeEvents) yield ev
    })()
  },
}

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 't1',
    status: 'completed',
    input: { prompt: 'sub' },
    createdAt: 1,
    eventCount: 0,
    parentSessionId: 'sess-parent',
    agentType: 'general-purpose',
    description: 'explore foo',
    ...overrides,
  }
}

beforeEach(() => {
  lastRunOpts = null
  runtimeEvents = [
    { type: 'message_start' },
    { type: 'message_stop' },
  ]
  __resetSubagentNotifierPendingForTests()
})

afterEach(() => {
  releaseSessionController('sess-parent')
  __resetSubagentNotifierPendingForTests()
  __setSubagentNotifier(null)
  vi.restoreAllMocks()
})

describe('renderTaskNotificationMessage', () => {
  test('completed → 含 <result> 文本', () => {
    const msg = renderTaskNotificationMessage(
      makeTask({ status: 'completed', resultText: 'final report' }),
    )
    expect(msg).toContain('<task-notification>')
    expect(msg).toContain('<task-id>t1</task-id>')
    expect(msg).toContain('<agent-type>general-purpose</agent-type>')
    expect(msg).toContain('<description>explore foo</description>')
    expect(msg).toContain('<status>completed</status>')
    expect(msg).toContain('<result>final report</result>')
    expect(msg).toContain('</task-notification>')
  })

  test('completed → summary 指引主 Agent 用 TaskOutput(task_id) 取结果,不读 output 文件', () => {
    const msg = renderTaskNotificationMessage(
      makeTask({ status: 'completed' }),
    )
    expect(msg).toContain('Use TaskOutput with task_id to retrieve the final result')
  })

  test('failed → result 字段含 [error: ...]', () => {
    const msg = renderTaskNotificationMessage(
      makeTask({
        status: 'failed',
        error: { message: 'spawn ENOENT', category: 'tool' },
      }),
    )
    expect(msg).toContain('<status>failed</status>')
    expect(msg).toContain('[error: spawn ENOENT (tool)]')
  })

  test('cancelled → result 字段含 [cancelled by user]', () => {
    const msg = renderTaskNotificationMessage(makeTask({ status: 'cancelled' }))
    expect(msg).toContain('<status>cancelled</status>')
    expect(msg).toContain('[cancelled by user]')
  })

  test('escape XML 防止标签注入', () => {
    const msg = renderTaskNotificationMessage(
      makeTask({ description: 'evil </description><script>alert(1)</script>' }),
    )
    expect(msg).not.toContain('<script>')
    expect(msg).toContain('&lt;script&gt;')
  })
})

describe('SubagentNotifier.handle', () => {
  test('completed + parentSessionId → 触发 runtime.query,sessionId=parentSessionId', async () => {
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ status: 'completed', resultText: 'hi' }))
    expect(lastRunOpts).not.toBeNull()
    expect(lastRunOpts.sessionId).toBe('sess-parent')
    expect(lastRunOpts.prompt).toContain('<task-notification>')
    expect(lastRunOpts.prompt).toContain('<result>hi</result>')
  })

  test('failed → prompt 含 [error: ...]', async () => {
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(
      makeTask({
        status: 'failed',
        error: { message: 'llm_provider_overloaded', category: 'llm_provider_overloaded' },
      }),
    )
    expect(lastRunOpts.prompt).toContain('<status>failed</status>')
    expect(lastRunOpts.prompt).toContain('[error: llm_provider_overloaded')
  })

  test('cancelled → prompt 含 [cancelled by user]', async () => {
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ status: 'cancelled' }))
    expect(lastRunOpts.prompt).toContain('<status>cancelled</status>')
    expect(lastRunOpts.prompt).toContain('[cancelled by user]')
  })

  test('无 parentSessionId → 不触发 run', async () => {
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ parentSessionId: undefined }))
    expect(lastRunOpts).toBeNull()
  })

  test('parentSessionId=sess-unknown (占位) → 不触发 run', async () => {
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ parentSessionId: 'sess-unknown' }))
    expect(lastRunOpts).toBeNull()
  })

  test('status=running (非 terminal) → 不触发 run', async () => {
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ status: 'running' }))
    expect(lastRunOpts).toBeNull()
  })

  test('runtime.query 抛错 → handle 不抛,仅 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = {
      query: () => {
        throw new Error('runtime blew up')
      },
    }
    const n = new SubagentNotifier({ getRuntime: () => broken as any })
    // 不应 throw
    await expect(n.handle(makeTask())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  test('父 session 主线活跃 (running 守卫) → 暂存通知,不注入', async () => {
    registerSessionController('sess-parent', new AbortController())
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ status: 'completed', resultText: 'hi' }))
    expect(lastRunOpts).toBeNull()
  })

  test('主线结束后 flushPendingSubagentNotifications → 补发注入', async () => {
    // flush 走模块单例,先注册带 mock runtime 的单例
    __setSubagentNotifier(
      new SubagentNotifier({ getRuntime: () => mockRuntime as any }),
    )
    registerSessionController('sess-parent', new AbortController())
    const n = new SubagentNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle(makeTask({ status: 'completed', resultText: 'hi' }))
    expect(lastRunOpts).toBeNull() // 活跃时不注入

    releaseSessionController('sess-parent')
    flushPendingSubagentNotifications('sess-parent')
    // flush 是 fire-and-forget,等微任务
    await new Promise((r) => setTimeout(r, 10))
    expect(lastRunOpts).not.toBeNull()
    expect(lastRunOpts.sessionId).toBe('sess-parent')
    expect(lastRunOpts.prompt).toContain('<result>hi</result>')
  })
})
