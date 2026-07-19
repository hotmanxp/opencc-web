/**
 * 集成测试:用 opencc 风格的别名(`BashOutput` / `AgentOutput` / `KillShell`)
 * + 旧参数(`bash_id` / `agentId` / `shell_id` / `wait_up_to`)调 TaskOutputTool /
 * TaskStopTool,验证归一化 + aliases 完整链路。
 *
 * 这部分测试对应 opencc 上游:
 *   src/tools/TaskOutputTool/TaskOutputTool.tsx:151   aliases: ['AgentOutputTool', 'BashOutputTool']
 *   src/tools/TaskStopTool/TaskStopTool.ts:43        aliases: ['KillShell']
 *   src/utils/api.ts:717-732                         Normalize legacy parameter names
 */
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import type { LegacyToolContext } from '../../../src/tools/Tool.js'
import {
  setBackgroundRuntime,
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../../src/runtime/background/index.js'
import type {
  BackgroundRuntime,
  BackgroundTask,
  DispatchInput,
  TaskEvent,
} from '../../../src/runtime/background/index.js'
import {
  TaskOutputTool,
} from '../../../src/tools/TaskOutputTool/TaskOutputTool.js'
import { TaskOutputInputSchema } from '../../../src/tools/TaskOutputTool/schema.js'
import {
  TaskStopTool,
} from '../../../src/tools/TaskStopTool/TaskStopTool.js'
import { TaskStopInputSchema } from '../../../src/tools/TaskStopTool/schema.js'
import { wrapAsOpenccTool } from '../../../src/tools/legacyAdapter.js'

function makeCtx(): LegacyToolContext {
  return {
    cwd: '/tmp',
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: '/tmp',
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    __runtimeConfig: {} as any,
    __defaultModel: 'test',
    __maxTurns: 1,
    parentSessionId: 'sess-test',
  } as LegacyToolContext
}

function makeRuntime(task: BackgroundTask | null): BackgroundRuntime {
  return {
    async dispatch(_input: DispatchInput): Promise<BackgroundTask> {
      throw new Error('not used')
    },
    async get(id: string): Promise<BackgroundTask | null> {
      return task && task.id === id ? task : null
    },
    async list() {
      return task ? [task] : []
    },
    async cancel() {
      return { ok: true }
    },
    events(_id: string): AsyncIterable<TaskEvent> {
      return (async function* () {
        // Empty — task doesn't reach event-read path in these tests.
      })()
    },
    async shutdown() {},
  }
}

function makeTask(id: string, status: BackgroundTask['status']): BackgroundTask {
  return {
    id,
    status,
    input: { prompt: 'p', cwd: '/tmp', agent: 'general-purpose' },
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: undefined,
    resultText: undefined,
    error: undefined,
    eventCount: 0,
  }
}

afterEach(() => {
  setBackgroundRuntime(null)
})

describe('TaskOutputTool — legacy input normalization end-to-end', () => {
  test('call() with bash_id (BashOutputTool legacy) reaches task lookup', async () => {
    const task = makeTask('abc', 'completed')
    task.resultText = 'legacy bash output'
    setBackgroundRuntime(makeRuntime(task))

    // No task_id — uses legacy bash_id alias.
    // NOTE: zai runtime (toolExecution.ts:137) safeParse's input BEFORE call(),
    // so we mirror that here to exercise the end-to-end schema → call path.
    const rawInput = { bash_id: 'abc', block: false }
    const parsedInput = TaskOutputInputSchema.safeParse(rawInput)
    expect(parsedInput.success).toBe(true)
    const r = await TaskOutputTool.call(
      parsedInput.data as never,
      makeCtx(),
    )
    // BackgroundRuntime not initialized in this test → not_ready path.
    // But after setting it, we expect successful retrieval.
    expect(hasBackgroundRuntime()).toBe(true)
    const parsed = JSON.parse(r.output as string)
    expect(parsed.retrieval_status).toBe('success')
    expect(parsed.task.task_id).toBe('abc')
    expect(parsed.task.status).toBe('completed')
  })

  test('call() with agentId (AgentOutputTool legacy) reaches task lookup', async () => {
    const task = makeTask('xyz', 'completed')
    task.resultText = 'legacy agent output'
    setBackgroundRuntime(makeRuntime(task))

    const r = await TaskOutputTool.call(
      TaskOutputInputSchema.parse({ agentId: 'xyz', block: false }) as never,
      makeCtx(),
    )
    const parsed = JSON.parse(r.output as string)
    expect(parsed.retrieval_status).toBe('success')
    expect(parsed.task.task_id).toBe('xyz')
  })

  test('call() with wait_up_to (seconds) is accepted without throwing', async () => {
    // Use a non-existent task so the path is "not_ready" — avoids events() hang.
    setBackgroundRuntime(makeRuntime(null))

    const r = await TaskOutputTool.call(
      TaskOutputInputSchema.parse({ task_id: 'missing', wait_up_to: 0, block: false }) as never,
      makeCtx(),
    )
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.output as string)
    expect(parsed.retrieval_status).toBe('not_ready')
  })
})

describe('TaskStopTool — legacy shell_id normalization end-to-end', () => {
  test('call() with shell_id (KillShell legacy) reaches task lookup', async () => {
    const task = makeTask('s1', 'running')
    setBackgroundRuntime(makeRuntime(task))

    const r = await TaskStopTool.call(
      TaskStopInputSchema.parse({ shell_id: 's1', reason: 'user aborted' }) as never,
      makeCtx(),
    )
    expect(r.isError).toBe(false)
    const parsed = JSON.parse(r.output as string)
    expect(parsed.task_id).toBe('s1')
    expect(parsed.message).toContain('stopped')
  })

  test('call() with empty input → empty task_id → task-not-found', async () => {
    setBackgroundRuntime(makeRuntime(null))
    const r = await TaskStopTool.call(TaskStopInputSchema.parse({}) as never, makeCtx())
    expect(r.isError).toBe(true)
    const parsed = JSON.parse(r.output as string)
    expect(parsed.message).toContain('task not found')
  })
})

describe('wrapAsOpenccTool — aliases survive wrap', () => {
  test('TaskOutputTool wraps with BashOutput + AgentOutput aliases', () => {
    const wrapped = wrapAsOpenccTool(TaskOutputTool) as unknown as {
      name: string
      aliases?: string[]
    }
    expect(wrapped.name).toBe('TaskOutput')
    expect(wrapped.aliases).toContain('BashOutput')
    expect(wrapped.aliases).toContain('AgentOutput')
  })

  test('TaskStopTool wraps with KillShell alias', () => {
    const wrapped = wrapAsOpenccTool(TaskStopTool) as unknown as {
      name: string
      aliases?: string[]
    }
    expect(wrapped.name).toBe('TaskStop')
    expect(wrapped.aliases).toContain('KillShell')
  })
})