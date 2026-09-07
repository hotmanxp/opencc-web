import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// zai patch (2026-09-07, fix-pre-existing, worktree-dsh): mock 模式从静态
// `sessionInbox.followup` 改为 per-session `getSessionInbox` 工厂返回固定
// mockInbox。原因: taskFactoryBridge.ts:114 走 `getSessionInbox(sid)` per-session
// 工厂, 静态 singleton `sessionInbox` 已 deprecated。源码不再调静态
// `sessionInbox.followup`, spy 永远不触发, 10/25 用例失败。
const followupMock = vi.fn()
const mockInbox = {
  followup: (...args: unknown[]) => followupMock(...args),
  setBusy: vi.fn(),
  clearRunning: vi.fn(),
  setWakeHandler: vi.fn(),
  steer: vi.fn(),
  inject: vi.fn(),
  consumeNextTurn: vi.fn(() => null),
  consumeNextStep: vi.fn(() => []),
  peekNextTurnCount: vi.fn(() => 0),
  peekNextStepCount: vi.fn(() => 0),
  isBusy: vi.fn(() => false),
  promoteNextStepToNextTurn: vi.fn(() => 0),
  resetWakeBudget: vi.fn(),
  wakeFor: vi.fn(),
}
vi.mock('../../../src/server/services/sessionInbox.js', () => ({
  sessionInbox: {},
  getSessionInbox: vi.fn(() => mockInbox),
  setSessionInboxWakeHandler: vi.fn(),
  disposeSessionInbox: vi.fn(),
  listSessionInboxIds: vi.fn(() => []),
}))

import {
  createPoolTask, markTaskStatus, moveTask,
} from '@zn-ai/zn-agent-core'
import {
  startTaskFactoryManagedLoop, stopTaskFactoryManagedLoopForTests,
  __resetStagnantTrackersForTests,
  detectProjectType, suggestInstallCommand,
} from '../../../src/server/services/taskFactoryManagedLoop.js'
import {
  __resetForTests, setTaskFactoryState,
} from '../../../src/server/services/taskFactoryBridge.js'
import {
  __resetForTests as resetFactorySettings,
} from '../../../src/server/services/factorySettings.js'
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
  followupMock.mockClear()
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
  __resetStagnantTrackersForTests()
  __setBackgroundRuntime(null)
})

/** 收集本轮注入的 followup 消息 content 列表（以调度器会话 followup 的实效应答为准）。 */
function injectedContents(
  spy: { mock: { calls: Array<[string, { content: string }]> } },
): string[] {
  return spy.mock.calls.map((args) => String(args[1]?.content ?? ''))
}

describe('taskFactoryManagedLoop', () => {
  it('队列非空时注入 dispatch 指令（不依赖 processing 是否为空，允许多任务并行）', async () => {
    await createPoolTask({ title: 'a' })
    await createPoolTask({ title: 'b' }) // 多个队列任务 → 指令可让调度器并行派发
    const spy = followupMock
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
    const spy = followupMock
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
    const spy = followupMock
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
    const spy = followupMock
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
   *  这段语义标签即代表任务调度器会引导 verifier 走轻量验证。 */
  const QUICK_HINT_MARKER = '<task-verifier-mode value="light">'

  it('queue 含 mode=quick 任务 → dispatch 注入段含 QUICK_VERIFIER_HINT', async () => {
    // 全 quick:单个 quick 任务就触发 hint,多个 quick 同样含 hint
    await createPoolTask({ title: 'q-task-A', mode: 'quick' })
    await createPoolTask({ title: 'q-task-B', mode: 'quick' })
    const spy = followupMock
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const dispatch = contents.find((c) => c.includes('action="dispatch"'))
    expect(dispatch).toBeDefined()
    expect(dispatch).toContain(QUICK_HINT_MARKER)
    // 同时有 quick 队列提示,引导调度器识别
    expect(dispatch).toContain('quick-mode tasks')
  })

  it('queue 全是 mode=full(显式)→ dispatch 注入段不含 QUICK_VERIFIER_HINT', async () => {
    await createPoolTask({ title: 'f-task-A', mode: 'full' })
    await createPoolTask({ title: 'f-task-B', mode: 'full' })
    const spy = followupMock
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
    const spy = followupMock
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
    const spy = followupMock
    startTaskFactoryManagedLoop(20)
    await new Promise((r) => setTimeout(r, 60))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const dispatch = contents.find((c) => c.includes('action="dispatch"'))
    expect(dispatch).toBeDefined()
    expect(dispatch).toContain(QUICK_HINT_MARKER)
  })
})

/**
 * stagnant 告警 (tf-8rvychr0):processing / verifying 任务的 executor / verifier
 * BackgroundTask.eventCount 在 stagnantThresholdMs 内未增长 → 通过
 * injectSupervisorCommand 注入 `<task-alert action="stagnant">`,内容是最近
 * 5 条 TaskEvent 的 JSON 摘要。同任务 stagnantCooldownMs 冷却期内不重复告警,
 * 已终态的子任务从 trackers 移除。
 *
 * 实现策略:
 *  - factory-settings.json 写 stagnantThresholdMs=10ms / stagnantCooldownMs=20s,
 *    让第一次 tick init + 第二次 tick 跨过阈值触发告警;cooldown 大于测试时长
 *    自然保证 cooldown 用例只触发一次。
 *  - BackgroundRuntime stub 暴露可变 eventCount + 可配置 async events 流。
 *  - 用 setInterval(5ms) 让 tick 多次跑,然后用真实 setTimeout 等到所有
 *    microtask 排空。fake timers 在这里不能驱动 async iterator 推进
 *    (vitest fake 推进 setInterval 回调里的 `void tick()` 时,async tick
 *    的 await 链上后续微任务在真实微任务队列里,fake 不感知),所以放弃
 *    fake timers,改用真实 timer + 极小阈值。
 */
describe('taskFactoryManagedLoop — stagnant 告警(tf-8rvychr0)', () => {
  // 极小阈值 + 大 cooldown:threshold 5s(下限)让真实 timer 几次 tick
  // (interval=50ms) 内跨过;cooldown 20s 测试时长内不会二次告警,
  // 简化 case 3 断言。
  const STAGNANT_SETTINGS = {
    stagnantThresholdMs: 5_000,
    stagnantCooldownMs: 20_000,
    maxParallelTasks: 4,
  }
  // stagnant 测试用真实 timer 跨过 5s 阈值,等待时间 5.5–6.5s,
  // 默认 vitest timeout=5s 不够 → 整个 describe 拉到 15s。
  vi.setConfig({ testTimeout: 15_000 })

  function makeEvent(seq: number, type = 'log') {
    return {
      seq,
      eventId: `ev-${seq}`,
      ts: 1_700_000_000_000 + seq,
      type,
      data: { msg: `event-${seq}` },
    }
  }

  function makeBgStub(opts: {
    records: Record<string, { status: string; eventCount: number }>
    events?: Record<string, unknown[]>
  }) {
    const events = opts.events ?? {}
    return {
      get: async (id: string) => opts.records[id] ?? null,
      // zai patch (2026-09-07, fix 🔴-1): events() 语义对齐真实
      // DefaultBackgroundRuntime.events —— 回放历史后,非终态任务的流不
      // 自行结束,只在 signal abort 时返回。旧 stub 回放完直接 return,
      // 掩盖了 collectRecentEvents 在「历史不足 5 条」时的永久挂起 bug。
      events: (id: string, fromSeq = 0, signal?: AbortSignal) =>
        (async function* () {
          const history = events[id] ?? []
          for (const ev of history) {
            if (signal?.aborted) return
            if ((ev as { seq: number }).seq > fromSeq) yield ev
          }
          const rec = opts.records[id]
          const terminal = rec
            ? ['completed', 'failed', 'cancelled', 'killed'].includes(rec.status)
            : false
          if (terminal) return
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        })(),
      cancel: async () => ({ ok: true }),
    }
  }

  it('case 1: 任务 eventCount 3 分钟无增长 → 触发 stagnant 告警', async () => {
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify(STAGNANT_SETTINGS), 'utf-8')
    resetFactorySettings()
    // 空 queue / 1 processing 任务 executor 子任务
    const s = await createPoolTask({ title: 'stagnant-task' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-stuck' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    __setBackgroundRuntime(makeBgStub({
      records: { 'exec-stuck': { status: 'running', eventCount: 0 } },
      events: {
        'exec-stuck': [makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4), makeEvent(5), makeEvent(6)],
      },
    }) as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    const spy = followupMock
    // 真实 timer:threshold=5s,interval=50ms — 5s 后跨过阈值触发告警。
    startTaskFactoryManagedLoop(50)
    await new Promise((r) => setTimeout(r, 5500))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const alert = contents.find((c) => c.includes('<task-alert action="stagnant"'))
    expect(alert).toBeDefined()
    expect(alert).toContain(`id="${s.id}"`)
    expect(alert).toContain('stagnant for')
    expect(alert).toContain('Last event count: 0')
  })

  it('case 2: eventCount 增长 → lastEventAt 重置,不触发告警', async () => {
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify(STAGNANT_SETTINGS), 'utf-8')
    resetFactorySettings()
    const s = await createPoolTask({ title: 'growing-task' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-grow' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    // 每次 tick 都让 eventCount 单调增长 —— tracker.lastEventAt 永远被重置
    let tickCount = 0
    __setBackgroundRuntime({
      get: async () => ({ status: 'running', eventCount: ++tickCount }),
      events: (async function* () { /* 不会被调用 */ }) as never,
      cancel: async () => ({ ok: true }),
    } as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    const spy = followupMock
    startTaskFactoryManagedLoop(50)
    await new Promise((r) => setTimeout(r, 5500))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    // eventCount 持续增长,不应出现 stagnant 告警
    expect(contents.some((c) => c.includes('<task-alert action="stagnant"'))).toBe(false)
  })

  it('case 3: 同一任务 cooldown 期内不重复告警(含 🔴-1 回归:历史不足 5 条不再挂起)', async () => {
    // cooldown=20s 测试时长内不会跨过,threshold=5s。事件历史只有 2 条 ——
    // 旧实现里 collectRecentEvents 会等第 5 个事件永久挂起;修复后靠
    // AbortSignal.timeout(1.5s) 兜底退出,告警仍注入且只 1 次。
    // 等待 7.5s = 5s 阈值 + 1.5s 事件流超时 + 注入缓冲。
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify(STAGNANT_SETTINGS), 'utf-8')
    resetFactorySettings()
    const s = await createPoolTask({ title: 'cooldown-task' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-cd' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    __setBackgroundRuntime(makeBgStub({
      records: { 'exec-cd': { status: 'running', eventCount: 0 } },
      events: {
        'exec-cd': [makeEvent(1), makeEvent(2)],
      },
    }) as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    const spy = followupMock
    startTaskFactoryManagedLoop(50)
    await new Promise((r) => setTimeout(r, 7500))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const alerts = contents.filter((c) => c.includes('<task-alert action="stagnant"'))
    expect(alerts.length).toBe(1)
    // 快照只拿到 2 条历史事件,但告警确实产出了 —— 证明未挂起
    expect(alerts[0]).toContain('Recent 2 TaskEvents')
  })

  it('case 4: 已终态(Completed)子任务从 trackers 移除,不告警', async () => {
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify(STAGNANT_SETTINGS), 'utf-8')
    resetFactorySettings()
    const s = await createPoolTask({ title: 'finished-task' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-fin' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    __setBackgroundRuntime(makeBgStub({
      records: { 'exec-fin': { status: 'completed', eventCount: 5 } },
      events: {},
    }) as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    const spy = followupMock
    startTaskFactoryManagedLoop(50)
    await new Promise((r) => setTimeout(r, 5500))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    expect(contents.some((c) => c.includes('<task-alert action="stagnant"'))).toBe(false)
  })

  it('case 5: 告警内容包含最近 5 条 TaskEvent JSON 摘要', async () => {
    await writeFile(join(dataDir, 'factory-settings.json'), JSON.stringify(STAGNANT_SETTINGS), 'utf-8')
    resetFactorySettings()
    const s = await createPoolTask({ title: 'payload-task' })
    await markTaskStatus(s.id, 'queue-tasks', { status: 'processing', executorTaskId: 'exec-payload' })
    await moveTask(s.id, 'queue-tasks', 'processing-tasks')
    const history = [
      makeEvent(1, 'start'),
      makeEvent(2, 'log'),
      makeEvent(3, 'log'),
      makeEvent(4, 'progress'),
      makeEvent(5, 'progress'),
      makeEvent(6, 'progress'),
      makeEvent(7, 'log'),
    ]
    __setBackgroundRuntime(makeBgStub({
      records: { 'exec-payload': { status: 'running', eventCount: 7 } },
      events: { 'exec-payload': history },
    }) as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    const spy = followupMock
    startTaskFactoryManagedLoop(50)
    await new Promise((r) => setTimeout(r, 5500))
    stopTaskFactoryManagedLoopForTests()
    const contents = injectedContents(spy)
    const alert = contents.find((c) => c.includes('<task-alert action="stagnant"'))
    expect(alert).toBeDefined()
    // 告警里应包含从 seq=3 开始的最近 5 条(seq 3,4,5,6,7)
    expect(alert).toContain('"seq":3')
    expect(alert).toContain('"seq":7')
    expect(alert).toContain('"eventId":"ev-3"')
    expect(alert).toContain('"eventId":"ev-7"')
    expect(alert).toContain('Recent 5 TaskEvents')
    expect(alert).toContain('Last event count: 7')
  })
})

// zai patch (2026-09-05, tf-flofuz1q):detectProjectType + suggestInstallCommand
// 的项目无关检测矩阵 —— 用 mkdtemp 建独立目录,逐类放置标记文件后跑检测。
// 不污染主测 dir,每个 case 自建子目录。
describe('detectProjectType + suggestInstallCommand (2026-09-05 tf-flofuz1q)', () => {
  it('detectProjectType: 空目录 → unknown', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'tf-detect-empty-'))
    try {
      expect(detectProjectType(sub)).toBe('unknown')
    } finally {
      await rm(sub, { recursive: true, force: true })
    }
  })

  it('detectProjectType: 空 cwd → unknown(护栏)', () => {
    expect(detectProjectType('')).toBe('unknown')
  })

  it('detectProjectType: pnpm-lock.yaml 命中 → node-pnpm', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'tf-detect-pnpm-'))
    try {
      await writeFile(join(sub, 'pnpm-lock.yaml'), '', 'utf-8')
      expect(detectProjectType(sub)).toBe('node-pnpm')
    } finally {
      await rm(sub, { recursive: true, force: true })
    }
  })

  it('detectProjectType: package-lock.json 命中 → node-npm', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'tf-detect-npm-'))
    try {
      await writeFile(join(sub, 'package-lock.json'), '', 'utf-8')
      expect(detectProjectType(sub)).toBe('node-npm')
    } finally {
      await rm(sub, { recursive: true, force: true })
    }
  })

  it('detectProjectType: pyproject.toml / requirements.txt / setup.py / Pipfile 任一命中 → python', async () => {
    for (const marker of ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']) {
      const sub = await mkdtemp(join(tmpdir(), `tf-detect-${marker}-`))
      try {
        await writeFile(join(sub, marker), '', 'utf-8')
        expect(detectProjectType(sub)).toBe('python')
      } finally {
        await rm(sub, { recursive: true, force: true })
      }
    }
  })

  it('detectProjectType: go.mod 命中 → go', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'tf-detect-go-'))
    try {
      await writeFile(join(sub, 'go.mod'), '', 'utf-8')
      expect(detectProjectType(sub)).toBe('go')
    } finally {
      await rm(sub, { recursive: true, force: true })
    }
  })

  it('detectProjectType: Cargo.toml 命中 → rust', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'tf-detect-rust-'))
    try {
      await writeFile(join(sub, 'Cargo.toml'), '', 'utf-8')
      expect(detectProjectType(sub)).toBe('rust')
    } finally {
      await rm(sub, { recursive: true, force: true })
    }
  })

  it('detectProjectType: 同时有 pnpm + npm lock → pnpm 优先(node-pnpm)', async () => {
    const sub = await mkdtemp(join(tmpdir(), 'tf-detect-pnpm-prio-'))
    try {
      await writeFile(join(sub, 'pnpm-lock.yaml'), '', 'utf-8')
      await writeFile(join(sub, 'package-lock.json'), '', 'utf-8')
      expect(detectProjectType(sub)).toBe('node-pnpm')
    } finally {
      await rm(sub, { recursive: true, force: true })
    }
  })

  it('detectProjectType: cwd 不存在的路径不抛错 → unknown', () => {
    // 不存在路径:existsSync 全 false → 落到 unknown 而不是抛
    expect(detectProjectType('/__no__such__path__tf_flofuz1q__/')).toBe('unknown')
  })

  it('suggestInstallCommand: node-pnpm → "pnpm install --prefer-offline"', () => {
    expect(suggestInstallCommand('/anywhere', 'node-pnpm')).toBe('pnpm install --prefer-offline')
  })

  it('suggestInstallCommand: node-npm → "npm ci"', () => {
    expect(suggestInstallCommand('/anywhere', 'node-npm')).toBe('npm ci')
  })

  it('suggestInstallCommand: python / go / rust / unknown → null(不硬塞命令)', () => {
    expect(suggestInstallCommand('/anywhere', 'python')).toBeNull()
    expect(suggestInstallCommand('/anywhere', 'go')).toBeNull()
    expect(suggestInstallCommand('/anywhere', 'rust')).toBeNull()
    expect(suggestInstallCommand('/anywhere', 'unknown')).toBeNull()
  })
})

