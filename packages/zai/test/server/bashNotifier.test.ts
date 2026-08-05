import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  BashNotifier,
  BASH_NOTIFY_PLACEHOLDER,
} from '../../src/server/services/bashNotifier.js'
import type { BashTaskInfo } from '@zn-ai/zn-agent-core/bashTracker'

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
  runtimeEvents = [
    { type: 'message_start' },
    { type: 'message_stop' },
  ]
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BashNotifier.handle', () => {
  test('completed + 有效 sessionId → 触发占位 query,isMeta=true', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask() })
    expect(lastRunOpts).not.toBeNull()
    expect(lastRunOpts.sessionId).toBe('sess-parent')
    expect(lastRunOpts.prompt).toBe(BASH_NOTIFY_PLACEHOLDER)
    expect(lastRunOpts.isMeta).toBe(true)
  })

  test('failed / killed → 同样触发占位 query', async () => {
    const n = new BashNotifier({ getRuntime: () => mockRuntime as any })
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ status: 'failed', exitCode: 1 }) })
    expect(lastRunOpts).not.toBeNull()
    await n.handle({ sessionId: 'sess-parent', task: makeTask({ status: 'killed' }) })
    expect(lastRunOpts).not.toBeNull()
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