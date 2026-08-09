import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  type BackgroundTask,
} from '../../../src/compat/background/index.js'

/**
 * resultText 兜底捕获契约测试。
 *
 * 真实环境 (zai AgentTool run_in_background) 走 attach + appendTaskEvent +
 * finalizeTask 桥接路径,消息流由 AgentTool 的 runAgent() 驱动。zai runtime.query
 * 的 vendor 流在 minimax keep-alive 下永不发 runtime.done,runOne 里只认
 * runtime.done 的 resultText 提取拿不到值 —— 必须在 appendTaskEvent / finalizeTask
 * 路径兜底,把最后一条 assistant text 作为 resultText 供 SubagentNotifier 使用。
 */

function makeNoopAgent() {
  return {
    async *query(): AsyncGenerator<never> {
      // no events; only used because constructor requires agentRuntime
    },
  }
}

let tmpDir: string
let store: JsonTaskStore
let runtime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-result-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  runtime = new DefaultBackgroundRuntime({
    agentRuntime: makeNoopAgent() as never,
    store,
    maxConcurrent: 1,
    shutdownTimeoutMs: 200,
  })
})

afterEach(async () => {
  await runtime.shutdown().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

describe('resultText 兜底捕获 (attach/finalize 路径)', () => {
  it('appendTaskEvent 收到 assistant text, completed 后 resultText 取最后一条 text', async () => {
    await runtime.attach({
      id: 'agent-rt',
      input: { prompt: 'x' },
      metadata: {},
    })
    await runtime.appendTaskEvent('agent-rt', {
      type: 'assistant',
      eventId: 'a1',
      message: { content: [{ type: 'text', text: 'interim text' }] },
    })
    await runtime.appendTaskEvent('agent-rt', {
      type: 'assistant',
      eventId: 'a2',
      message: {
        content: [
          { type: 'thinking', thinking: 'thinking not a result' },
          { type: 'text', text: 'final report' },
        ],
      },
    })
    // 只有 tool_use 的 assistant 消息不应污染 resultText
    await runtime.appendTaskEvent('agent-rt', {
      type: 'assistant',
      eventId: 'a3',
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    })

    await runtime.finalizeTask('agent-rt', 'completed')

    const t: BackgroundTask | null = await runtime.get('agent-rt')
    expect(t?.status).toBe('completed')
    expect(t?.resultText).toBe('final report')
  })
})
