// packages/zai/src/server/services/backgroundRuntime.test.ts
//
// Regression: HRMSV3-ZN-WEBSITE#668 同根问题 — 派发 sub-agent 后
// job.started.sessionId 永远是 null, 前端 useBackgroundTasks 看不见
// 任务 dock。复现路径:
//   - LLM 派发 sub-agent, AgentTool.call → backgroundRuntime.dispatch(
//       {prompt, metadata:{parentSessionId, ...}})
//   - DefaultBackgroundRuntime.dispatch 把 parentSessionId 写入 task
//   - wrapWithJobStarted.dispatch 立即 emit job.started, sessionId 应来自 task.parentSessionId
//   - 现状: backgroundRuntime.ts:90 传 `() => null` 覆盖默认 hook,
//           所有 job.started.sessionId === null → dock 看不见
//
// 测试分两组:
//  (A) wrapWithJobStarted 单元测 — 验证默认 hook 行为正确 (已经 pass)
//  (B) initBackgroundRuntime 端到端 — mock getRuntime 跳过 agentRuntime 重 init,
//      断言 init 出来的 runtime dispatch 时,emit 的 sessionId === parentSessionId

import { describe, expect, test, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  type AgentRuntime,
  type BackgroundRuntime,
  type RuntimeEvent,
} from '@zn-ai/zai-agent-core'
import { eventBus } from './eventBus.js'
import {
  wrapWithJobStarted,
  initBackgroundRuntime,
  shutdownBackgroundRuntime,
  __resetBackgroundRuntimeForTests,
} from './backgroundRuntime.js'

// ============== (A) wrapWithJobStarted 单元测 ==============

function makeNoopAgent(): AgentRuntime {
  return {
    async *run(): AsyncGenerator<RuntimeEvent> {
      // 空 stream → 任务立即 completed
    },
    async abort() {},
    async listSessions() {
      return []
    },
    async readSession() {
      throw new Error('not used')
    },
    async patchSession() {},
    async removeSession() {},
  } as unknown as AgentRuntime
}

let tmpDir: string
let inner: DefaultBackgroundRuntime | null = null

async function makeInner(): Promise<DefaultBackgroundRuntime> {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-bgr-test-'))
  const store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  inner = new DefaultBackgroundRuntime({
    agentRuntime: makeNoopAgent(),
    store,
    maxConcurrent: 1,
    shutdownTimeoutMs: 200,
  })
  return inner
}

afterEach(async () => {
  if (inner) {
    await inner.shutdown().catch(() => {})
    inner = null
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

describe('wrapWithJobStarted', () => {
  test('dispatch 后 emit job.started, sessionId 取自 task.parentSessionId (默认 hook)', async () => {
    const i = await makeInner()
    const wrapped: BackgroundRuntime = wrapWithJobStarted(i)

    const captured: { type: string; sessionId?: string | null; jobId?: string; kind?: string }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'job.started') {
        captured.push({
          type: e.type,
          sessionId: 'sessionId' in e ? e.sessionId : undefined,
          jobId: 'jobId' in e ? e.jobId : undefined,
          kind: 'kind' in e ? e.kind : undefined,
        })
      }
    })

    const task = await wrapped.dispatch({
      prompt: 'do X',
      metadata: { parentSessionId: 'sess-A', agentType: 'general-purpose' },
    })
    expect(task.parentSessionId).toBe('sess-A')

    expect(captured.length).toBe(1)
    expect(captured[0]?.type).toBe('job.started')
    expect(captured[0]?.jobId).toBe(task.id)
    expect(captured[0]?.kind).toBe('agent_task')
    expect(captured[0]?.sessionId).toBe('sess-A')

    off()
  })

  test('全局任务 (无 parentSessionId) → sessionId 应是 null', async () => {
    const i = await makeInner()
    const wrapped: BackgroundRuntime = wrapWithJobStarted(i)

    const captured: { sessionId?: string | null }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'job.started') {
        captured.push({ sessionId: 'sessionId' in e ? e.sessionId : undefined })
      }
    })

    const task = await wrapped.dispatch({ prompt: 'global task' })
    expect(task.parentSessionId).toBeUndefined()
    expect(captured.length).toBe(1)
    // 全局任务 sessionId 应是 null (而非 undefined), 让前端 isGlobalEvent 判定正确
    expect(captured[0]?.sessionId).toBeNull()

    off()
  })

  test('sessionIdHook 可被注入覆盖 (测试 seam)', async () => {
    const i = await makeInner()
    const wrapped: BackgroundRuntime = wrapWithJobStarted(i, (t) => `custom-${t.id}`)

    const captured: { sessionId?: string | null }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'job.started') {
        captured.push({ sessionId: 'sessionId' in e ? e.sessionId : undefined })
      }
    })

    await wrapped.dispatch({ prompt: 'x', metadata: { parentSessionId: 'sess-A' } })
    expect(captured[0]?.sessionId).toMatch(/^custom-/)

    off()
  })
})

// ============== (B) initBackgroundRuntime 端到端 ==============
//
// mock ./agentRuntime.js 的 getRuntime() 返回 noop, 跳过 modelCaller / MCP
// / plugin loader / memory watcher 等重 init 路径, 只测 initBackgroundRuntime
// 内部的 wrap 行为。

// vi.mock 会被 hoist, 在 test body 里取异步初始化的 innerRuntime 不可用.
// 用 vi.hoisted 把它提前, 并用可空引用注入.
const { innerRegistry } = vi.hoisted(() => ({ innerRegistry: { current: null as DefaultBackgroundRuntime | null } }))

vi.mock('./agentRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentRuntime.js')>()
  return {
    ...actual,
    getRuntime: () => innerRegistry.current,
  }
})

vi.mock('./subagentNotifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subagentNotifier.js')>()
  return {
    ...actual,
    initSubagentNotifier: () => ({
      handle: () => {},
    }),
    getSubagentNotifier: () => ({
      handle: () => {},
    }),
  }
})

describe('initBackgroundRuntime — job.started.sessionId 透传', () => {
  afterEach(async () => {
    await shutdownBackgroundRuntime().catch(() => {})
    __resetBackgroundRuntimeForTests()
    innerRegistry.current = null
    vi.restoreAllMocks()
  })

  test('★ dispatch 带 parentSessionId 的任务, emit job.started.sessionId === parentSessionId', async () => {
    innerRegistry.current = await makeInner()

    const runtime = initBackgroundRuntime()
    expect(runtime).toBeTruthy()

    const captured: { type: string; sessionId?: string | null; jobId?: string }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'job.started') {
        captured.push({
          type: e.type,
          sessionId: 'sessionId' in e ? e.sessionId : undefined,
          jobId: 'jobId' in e ? e.jobId : undefined,
        })
      }
    })

    const task = await runtime.dispatch({
      prompt: 'Implement Task 1: StateChangeBus',
      metadata: { parentSessionId: 'feat-sse-state-push', agentType: 'general-purpose' },
    })

    // 关键断言: init 路径不能丢掉 parentSessionId (bug: 当前是 null)
    expect(captured.length).toBe(1)
    expect(captured[0]?.sessionId).toBe('feat-sse-state-push')
    expect(captured[0]?.jobId).toBe(task.id)

    off()
    // shutdownBackgroundRuntime 在 afterEach 已经清理
  })
})