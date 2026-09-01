import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPoolTask, markTaskStatus, moveTask,
} from '@zn-ai/zn-agent-core'
import {
  startTaskFactoryManagedLoop, stopTaskFactoryManagedLoopForTests,
} from '../../../src/server/services/taskFactoryManagedLoop.js'
import {
  __resetForTests, setTaskFactoryState,
} from '../../../src/server/services/taskFactoryBridge.js'
import { sessionInbox } from '../../../src/server/services/sessionInbox.js'
import {
  __setBackgroundRuntime, __resetBackgroundRuntimeForTests,
} from '../../../src/server/services/backgroundRuntime.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-loop-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
})

afterAll(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  __resetForTests()
  __resetBackgroundRuntimeForTests()
  await setTaskFactoryState({ managedEnabled: true, supervisorSessionId: 'sess-sup' })
  // tick() 无条件读 getBackgroundRuntime();这里注入一个最小 stub(未知 executor
  // 一律视为不存在, 决不解析为终态), 避免测试依赖真实 background runtime 初始化。
  __setBackgroundRuntime({
    get: async () => null,
    cancel: async () => ({ ok: true }),
  } as unknown as Parameters<typeof __setBackgroundRuntime>[0])
  vi.restoreAllMocks()
})

afterEach(() => {
  stopTaskFactoryManagedLoopForTests()
  __setBackgroundRuntime(null)
})

/** 收集本轮注入的 followup 消息 content 列表（以主管会话 followup 的实效应答为准）。 */
function injectedContents(
  spy: { mock: { calls: Array<[string, { content: string }]> } },
): string[] {
  return spy.mock.calls.map(([, msg]) => String(msg.content))
}

describe('taskFactoryManagedLoop', () => {
  it('队列非空时注入 dispatch 指令（不依赖 processing 是否为空，允许多任务并行）', async () => {
    await createPoolTask({ title: 'a' })
    await createPoolTask({ title: 'b' }) // 多个队列任务 → 指令可让主管并行派发
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20) // 紧凑 interval 便于测试
    await new Promise((r) => setTimeout(r, 60))
    const contents = injectedContents(spy)
    expect(contents.some((c) => c.includes('action="dispatch"'))).toBe(true)
    stopTaskFactoryManagedLoopForTests()
  })

  it('executor 终态且任务仍 processing 时注入 accept 指令', async () => {
    const s = await createPoolTask({ title: 'b' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'a-unknown' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    // executorTaskId 在后台运行时不可解析 → 不注入 accept（避免幽灵验收）；
    // 断言无 accept 注入即可
    const contents = injectedContents(spy)
    expect(contents.some((c) => c.includes('action="accept"'))).toBe(false)
    stopTaskFactoryManagedLoopForTests()
  })
})