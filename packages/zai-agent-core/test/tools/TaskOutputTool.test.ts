import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TaskOutputTool } from '../../src/tools/TaskOutputTool/TaskOutputTool.js'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  setBackgroundRuntime,
} from '../../src/runtime/background/index.js'
import type { AgentRuntime } from '../../src/runtime/contract.js'
import type { RuntimeEvent } from '../../src/runtime/events.js'

let tmpDir: string
let runtime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-taskoutput-'))
  const store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  const agent: AgentRuntime = {
    async *run(): AsyncGenerator<RuntimeEvent> {},
    async abort() {},
    async listSessions() { return [] },
    async readSession() { throw new Error('not used') },
    async patchSession() {},
    async removeSession() {},
  } as unknown as AgentRuntime
  runtime = new DefaultBackgroundRuntime({
    agentRuntime: agent,
    store,
    shutdownTimeoutMs: 200,
  })
  setBackgroundRuntime(runtime)
})

afterEach(async () => {
  setBackgroundRuntime(null)
  await runtime.shutdown().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

describe('TaskOutputTool schema default', () => {
  test('空输入 transform 后 timeout = 600000ms (10 分钟)', () => {
    // schema 用 .transform() 归一,默认 timeout 在 transform 里设 (避免 .default()
    // 遮蔽用户的 omission)。 空对象能 parse 成功,timeout 在 output 里 = 600000。
    // 调整: 与 upstream opencc 一致, 长 bg-agent 任务下 LLM 不至于 30s 就 timeout
    const parsed = (TaskOutputTool.inputSchema as any).safeParse({})
    expect(parsed.success).toBe(true)
    expect(parsed.data.timeout).toBe(600000)
  })

  test('空输入 transform 后 task_id = "" (空字符串, 而不是必填错误)', () => {
    // 与 opencc 对齐: task_id 设为 optional, transform 内 fallback 链为
    // task_id → bash_id → agentId → ''。safeParse({}) 不会失败; 业务侧
    // (call 实现) 拿空字符串视为非法, 返回 not_ready。
    const parsed = (TaskOutputTool.inputSchema as any).safeParse({})
    expect(parsed.success).toBe(true)
    expect(parsed.data.task_id).toBe('')
  })
})

describe('TaskOutputTool.call', () => {
  test('running 任务 + block=true, timeout>0 → timeout 之前完成则 success', async () => {
    const task = await runtime.dispatch({ prompt: 'p' })
    // 等任务进入 terminal
    for (let i = 0; i < 50; i++) {
      const t = await runtime.get(task.id)
      if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    const r = await (TaskOutputTool.call as any)(
      { task_id: task.id, block: true, timeout: 60000 },
      { abortSignal: new AbortController().signal, state: {} },
    )
    expect(r.isError).toBeFalsy()
    const payload = JSON.parse(r.output)
    expect(payload.retrieval_status).toBe('success')
    expect(payload.task.task_id).toBe(task.id)
  })

  test('未知 task_id → not_ready', async () => {
    const r = await (TaskOutputTool.call as any)(
      { task_id: 'nonexistent', block: false, timeout: 1000 },
      { abortSignal: new AbortController().signal, state: {} },
    )
    const payload = JSON.parse(r.output)
    expect(payload.retrieval_status).toBe('not_ready')
  })
})
