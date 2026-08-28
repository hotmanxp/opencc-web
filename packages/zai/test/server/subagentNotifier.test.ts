import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// mock 必须早于被测模块 import 生效 —— vitest 会 hoist vi.mock 到文件顶部,
// 但显式写在 import 前更安全。
const followupMock = vi.fn()
vi.mock('../../src/server/services/sessionInbox.js', () => ({
  sessionInbox: {
    followup: (...args: unknown[]) => followupMock(...args),
  },
}))
// subagentNotifier 顶部 import getCoreRuntime(默认值)—— mock 掉避免
// 测试拉起整个 agentRuntime / core bundle。默认 'default'(注入照常走)。
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getCoreRuntime: () => 'default',
}))

import {
  SubagentNotifier,
  renderTaskNotificationMessage,
  __setSubagentNotifier,
} from '../../src/server/services/subagentNotifier.js'
import type { BackgroundTask } from '@zn-ai/zn-agent-core'

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
  followupMock.mockReset()
})

afterEach(() => {
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
  test('completed + parentSessionId → sessionInbox.followup 收到正确 content + parentSessionId', async () => {
    const n = new SubagentNotifier()
    await n.handle(makeTask({ status: 'completed', resultText: 'hi' }))
    expect(followupMock).toHaveBeenCalledTimes(1)
    const [sessionId, msg] = followupMock.mock.calls[0] as [string, {
      id: string
      source: { kind: string; form: string; senderSessionId?: string; agentType?: string }
      content: string
      createdAt: number
    }]
    expect(sessionId).toBe('sess-parent')
    expect(msg.id).toBe('bg-t1')
    expect(msg.source.kind).toBe('subagent')
    expect(msg.source.form).toBe('notice')
    expect(msg.source.senderSessionId).toBe('sess-parent')
    expect(msg.source.agentType).toBe('general-purpose')
    expect(typeof msg.createdAt).toBe('number')
    expect(msg.content).toContain('<task-notification>')
    expect(msg.content).toContain('<task-id>t1</task-id>')
    expect(msg.content).toContain('<status>completed</status>')
    expect(msg.content).toContain('<result>hi</result>')
  })

  test('failed → content 含 [error: ...]', async () => {
    const n = new SubagentNotifier()
    await n.handle(
      makeTask({
        status: 'failed',
        error: { message: 'llm_provider_overloaded', category: 'llm_provider_overloaded' },
      }),
    )
    expect(followupMock).toHaveBeenCalledTimes(1)
    const [, msg] = followupMock.mock.calls[0] as [string, { content: string }]
    expect(msg.content).toContain('<status>failed</status>')
    expect(msg.content).toContain('[error: llm_provider_overloaded')
  })

  test('cancelled → content 含 [cancelled by user]', async () => {
    const n = new SubagentNotifier()
    await n.handle(makeTask({ status: 'cancelled' }))
    expect(followupMock).toHaveBeenCalledTimes(1)
    const [, msg] = followupMock.mock.calls[0] as [string, { content: string }]
    expect(msg.content).toContain('<status>cancelled</status>')
    expect(msg.content).toContain('[cancelled by user]')
  })

  test('无 parentSessionId → 不投递 followup', async () => {
    const n = new SubagentNotifier()
    await n.handle(makeTask({ parentSessionId: undefined }))
    expect(followupMock).not.toHaveBeenCalled()
  })

  test('parentSessionId=sess-unknown (占位) → 不投递 followup', async () => {
    const n = new SubagentNotifier()
    await n.handle(makeTask({ parentSessionId: 'sess-unknown' }))
    expect(followupMock).not.toHaveBeenCalled()
  })

  test('status=running (非 terminal) → 不投递 followup', async () => {
    const n = new SubagentNotifier()
    await n.handle(makeTask({ status: 'running' }))
    expect(followupMock).not.toHaveBeenCalled()
  })

  test('inproc 运行时 → 不投递 followup(通知由 vendor print 环 drain 原生投递)', async () => {
    const n = new SubagentNotifier({ getCore: () => 'inproc' })
    await n.handle(makeTask({ status: 'completed', resultText: 'hi' }))
    expect(followupMock).not.toHaveBeenCalled()
  })

  test('spawn 运行时 → 仍投递 followup(子进程环不共享 bundle 队列)', async () => {
    const n = new SubagentNotifier({ getCore: () => 'spawn' })
    await n.handle(makeTask())
    expect(followupMock).toHaveBeenCalledTimes(1)
  })

  test('sessionInbox.followup 抛错 → handle 不抛,仅 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    followupMock.mockImplementationOnce(() => {
      throw new Error('inbox blew up')
    })
    const n = new SubagentNotifier()
    // 不应 throw
    await expect(n.handle(makeTask())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
