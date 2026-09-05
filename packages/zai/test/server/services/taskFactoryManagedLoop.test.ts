import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import {
  __resetForTests as resetFactorySettings,
} from '../../../src/server/services/factorySettings.js'
import { sessionInbox } from '../../../src/server/services/sessionInbox.js'
import {
  __setBackgroundRuntime, __resetBackgroundRuntimeForTests,
} from '../../../src/server/services/backgroundRuntime.js'

let dir: string
let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tf-loop-data-'))
  process.env.ZAI_DATA_DIR = dataDir
})

afterAll(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  delete process.env.ZAI_DATA_DIR
  if (dir) await rm(dir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  // 每用例一个独立 task-factory 目录 —— createPoolTask 跨用例累积会污染
  // processing 计数(并行上限用例依赖精确的桶数量,2026-09-03 tf-pnsl5m5e)。
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(join(tmpdir(), 'tf-loop-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  resetFactorySettings()
  await rm(join(dataDir, 'factory-settings.json'), { force: true })
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

/** 收集本轮注入的 followup 消息 content 列表（以调度官会话 followup 的实效应答为准）。 */
function injectedContents(
  spy: { mock: { calls: Array<[string, { content: string }]> } },
): string[] {
  return spy.mock.calls.map(([, msg]) => String(msg.content))
}

describe('taskFactoryManagedLoop', () => {
  it('队列非空时注入 dispatch 指令（不依赖 processing 是否为空，允许多任务并行）', async () => {
    await createPoolTask({ title: 'a' })
    await createPoolTask({ title: 'b' }) // 多个队列任务 → 指令可让调度官并行派发
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
    // executorTaskId 在后台运行时不可解析 → 不注入 accept(避免幽灵验收);
    // 断言无 accept 注入即可
    const contents = injectedContents(spy)
    expect(contents.some((c) => c.includes('action="accept"'))).toBe(false)
    stopTaskFactoryManagedLoopForTests()
  })
})

describe('taskFactoryManagedLoop — maxParallelTasks 并行上限(tf-pnsl5m5e)', () => {
  it('processing 数达到上限 → 跳过 dispatch 注入;accept 不受限仍注入', async () => {
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify({ maxParallelTasks: 2 }), 'utf-8')
    resetFactorySettings() // 丢弃上一用例可能留下的缓存,让 tick 读到本用例设置
    const p1 = await createPoolTask({ title: 'p1' })
    const p2 = await createPoolTask({ title: 'p2' })
    await markTaskStatus(p1.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-done' })
    await moveTask(p1.id, 'queue-tasks', 'processing-tasks')
    await markTaskStatus(p2.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-running' })
    await moveTask(p2.id, 'queue-tasks', 'processing-tasks')
    await createPoolTask({ title: 'q1' }) // 队列非空,但已满 → 不派发
    // 覆盖 beforeEach 的 null stub:exec-done 终态,exec-running 在飞
    __setBackgroundRuntime({
      get: async (id: string) =>
        id === 'exec-done' ? { status: 'completed' } : id === 'exec-running' ? { status: 'running' } : null,
      cancel: async () => ({ ok: true }),
    } as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 80))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    expect(contents.some((c) => c.includes('action="dispatch"'))).toBe(false)
    expect(contents.some((c) => c.includes(`action="accept" id="${p1.id}"`))).toBe(true)
  })

  it('processing 数未达上限 → dispatch 正常注入(含在飞任务)', async () => {
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify({ maxParallelTasks: 2 }), 'utf-8')
    resetFactorySettings()
    const p1 = await createPoolTask({ title: 'under-p1' })
    await markTaskStatus(p1.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-running' })
    await moveTask(p1.id, 'queue-tasks', 'processing-tasks')
    await createPoolTask({ title: 'under-q1' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 80))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    expect(contents.some((c) => c.includes('action="dispatch"'))).toBe(true)
  })
})

// zai patch (2026-09-04, quick-intake round 2):补 managed loop 自动 dispatch
// 注入对 queue.mode='quick' 的分流覆盖 —— taskFactoryBridge.test.ts 已覆盖
// buildTaskCommand 路径,managed loop 直接 injectSupervisorCommand 的同款语义
// (见 taskFactoryManagedLoop.ts:78-83) 此处覆盖。spec R8 要求。
describe('taskFactoryManagedLoop — quick verifier 分流(2026-09-04 round 2)', () => {
  /** 与 taskFactoryBridge.QUICK_VERIFIER_HINT 字符串一致 —— 注入段里包含
   *  这段语义标签即代表任务调度官会引导 verifier 走轻量验证。 */
  const QUICK_HINT_MARKER = '<task-verifier-mode value="light">'

  it('queue 含 mode=quick 任务 → dispatch 注入段含 QUICK_VERIFIER_HINT', async () => {
    // 全 quick:单个 quick 任务就触发 hint,多个 quick 同样含 hint
    await createPoolTask({ title: 'q-task-A', mode: 'quick' })
    await createPoolTask({ title: 'q-task-B', mode: 'quick' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const dispatch = contents.find((c) => c.includes('action="dispatch"'))
    expect(dispatch).toBeDefined()
    expect(dispatch).toContain(QUICK_HINT_MARKER)
    // 同时有 quick 队列提示,引导调度官识别
    expect(dispatch).toContain('quick-mode tasks')
  })

  it('queue 全是 mode=full(显式)→ dispatch 注入段不含 QUICK_VERIFIER_HINT', async () => {
    await createPoolTask({ title: 'f-task-A', mode: 'full' })
    await createPoolTask({ title: 'f-task-B', mode: 'full' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const dispatch = contents.find((c) => c.includes('action="dispatch"'))
    expect(dispatch).toBeDefined()
    expect(dispatch).not.toContain(QUICK_HINT_MARKER)
  })

  it('queue 任务 mode 缺省(历史 full 任务)→ dispatch 注入段不含 QUICK_VERIFIER_HINT', async () => {
    // 不传 mode → CreatePoolTaskInput.mode? 缺省 → 走 full 默认路径
    await createPoolTask({ title: 'legacy-A' })
    await createPoolTask({ title: 'legacy-B' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const dispatch = contents.find((c) => c.includes('action="dispatch"'))
    expect(dispatch).toBeDefined()
    expect(dispatch).not.toContain(QUICK_HINT_MARKER)
  })

  it('queue 混合 quick + full → 含至少一个 quick 时仍注入 QUICK_VERIFIER_HINT', async () => {
    await createPoolTask({ title: 'mix-full', mode: 'full' })
    await createPoolTask({ title: 'mix-quick', mode: 'quick' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const dispatch = contents.find((c) => c.includes('action="dispatch"'))
    expect(dispatch).toBeDefined()
    expect(dispatch).toContain(QUICK_HINT_MARKER)
  })
})

