/**
 * 真实链路集成测试:zai LLM 调用 TaskStopTool(通过 KillShell 别名 +
 * shell_id 旧参数)终止 zai 后台 agent 任务。
 *
 * 这条路径模拟的是 zai runtime toolExecution 完整链路:
 *   raw { shell_id, reason }
 *     →  TaskStopInputSchema.safeParse       (toolExecution.ts:137)
 *     →  findToolByName(registry, 'KillShell') (opencc-internals/Tool.ts)
 *     →  tool.call(parsed, ctx)                (zai tool body)
 *     →  BackgroundRuntime.cancel(task_id, reason)
 *
 * 唯一被"绕开"的环节是"由 LLM 决定调 KillShell";这条路径其余全部走的是
 * 真实现 - 是 LLM 调过来之后 zai runtime 一定走的代码。
 */
import { describe, expect, test, afterEach } from 'vitest'
import { getZaiRuntimeTools } from '../../../src/tools/index.js'
import { findToolByName } from '../../../src/opencc-internals/Tool.js'
import { TaskStopInputSchema } from '../../../src/tools/TaskStopTool/schema.js'
import {
  setBackgroundRuntime,
  getBackgroundRuntime,
  hasBackgroundRuntime,
  type BackgroundRuntime,
  type BackgroundTask,
} from '../../../src/runtime/background/index.js'

afterEach(() => {
  setBackgroundRuntime(null)
})

function makeRunningTask(id: string): BackgroundTask {
  return {
    id,
    status: 'running',
    input: { prompt: 'example long-running bg agent', cwd: '/tmp', agent: 'general-purpose' },
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: undefined,
    resultText: undefined,
    error: undefined,
    eventCount: 0,
  }
}

interface CancelCall {
  taskId: string
  reason?: string
}

function makeRuntime(task: BackgroundTask, calls: CancelCall[]): BackgroundRuntime {
  return {
    async dispatch() {
      throw new Error('not used')
    },
    async get(id: string) {
      return id === task.id ? task : null
    },
    async list() {
      return [task]
    },
    async cancel(id: string, reason?: string) {
      calls.push({ taskId: id, reason })
      return id === task.id ? { ok: true } : { ok: false }
    },
    events() {
      return (async function* () {})()
    },
    async shutdown() {},
  }
}

describe('zai LLM call: KillShell alias + shell_id legacy → terminate bg agent', () => {
  test('end-to-end: legacy { shell_id, reason } cancels BackgroundRuntime task', async () => {
    const task = makeRunningTask('bg-uuid-XYZ-9999')
    const cancelCalls: CancelCall[] = []
    setBackgroundRuntime(makeRuntime(task, cancelCalls))

    // ---- 步骤 1: schema safeParse ----
    const raw = { shell_id: 'bg-uuid-XYZ-9999', reason: 'user aborted' }
    const parsed = TaskStopInputSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data).toEqual({
      task_id: 'bg-uuid-XYZ-9999',
      reason: 'user aborted',
    })

    // ---- 步骤 2: findToolByName via alias ----
    const registry = getZaiRuntimeTools()
    const tool = findToolByName(registry, 'KillShell')
    expect(tool).toBeDefined()
    expect((tool as unknown as { name: string }).name).toBe('TaskStop')

    // ---- 步骤 3: tool.call → BackgroundRuntime.cancel ----
    const r = await tool!.call(parsed.data, {} as any)

    // ---- 断言 ----
    expect(r).toBeDefined()
    const data = typeof r.data === 'string' ? r.data : JSON.stringify(r)
    expect(data).toContain('task stopped: bg-uuid-XYZ-9999')

    // BackgroundRuntime.cancel 真的被调过一次,且参数透传正确
    expect(cancelCalls).toEqual([
      { taskId: 'bg-uuid-XYZ-9999', reason: 'user aborted' },
    ])
  })

  test('canonical { task_id } 同样工作(主路径不被 alias 路径绕过)', async () => {
    const task = makeRunningTask('canonical-id')
    const cancelCalls: CancelCall[] = []
    setBackgroundRuntime(makeRuntime(task, cancelCalls))

    const parsed = TaskStopInputSchema.safeParse({ task_id: 'canonical-id' })
    expect(parsed.success).toBe(true)
    const tool = findToolByName(getZaiRuntimeTools(), 'TaskStop')
    expect((tool as unknown as { name: string }).name).toBe('TaskStop')

    await tool!.call(parsed.data!, {} as any)
    expect(cancelCalls).toEqual([{ taskId: 'canonical-id', reason: undefined }])
  })

  test('KillShell alias 误指不存在的 task 不抛异常,返回 task-not-found 错误', async () => {
    setBackgroundRuntime(
      makeRuntime(makeRunningTask('real-task'), []),
    )
    // 真实 task 是 real-task,但 LLM 给了不存在的 id
    const parsed = TaskStopInputSchema.safeParse({ shell_id: 'ghost-id' })
    const tool = findToolByName(getZaiRuntimeTools(), 'KillShell')!
    const r = await tool.call(parsed.data!, {} as any)

    expect(r.isError).toBe(true)
    const data = typeof r.data === 'string' ? r.data : JSON.stringify(r)
    expect(data).toContain('task not found')
  })

  test('同时提供 task_id 和 shell_id 时 canonical 优先', async () => {
    const task = makeRunningTask('canon-wins')
    const cancelCalls: CancelCall[] = []
    setBackgroundRuntime(makeRuntime(task, cancelCalls))

    const parsed = TaskStopInputSchema.safeParse({
      task_id: 'canon-wins',
      shell_id: 'legacy-loses',
      reason: 'priority test',
    })
    expect(parsed.data).toEqual({
      task_id: 'canon-wins',
      reason: 'priority test',
    })

    const tool = findToolByName(getZaiRuntimeTools(), 'KillShell')!
    await tool.call(parsed.data!, {} as any)
    expect(cancelCalls).toEqual([
      { taskId: 'canon-wins', reason: 'priority test' },
    ])
  })
})
