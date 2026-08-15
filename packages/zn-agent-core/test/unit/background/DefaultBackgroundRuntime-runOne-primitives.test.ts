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
 * runOne 的 resultText 提取契约测试(dispatch 路径)。
 *
 * query 出口接线 sdkEventAdapter 后,vendor 事件被翻译成 Anthropic
 * primitives(content_block_delta / message_stop),runOne 不再收到原始
 * `assistant` Message。此测试锁定 runOne 从 text_delta 累积、message_stop
 * 落盘的 resultText 提取逻辑,防止回归导致 SubagentNotifier 的 <result> 与
 * TaskOutput 的 resultText 丢失。
 */

function makePrimitivesAgent() {
  return {
    async *query() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }
      // thinking_delta 不应计入 resultText
      yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考中' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '世界' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } }
      yield { type: 'message_stop' }
    },
  }
}

let tmpDir: string
let store: JsonTaskStore
let runtime: DefaultBackgroundRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bg-runone-primitives-'))
  store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  runtime = new DefaultBackgroundRuntime({
    agentRuntime: makePrimitivesAgent() as never,
    store,
    maxConcurrent: 1,
    shutdownTimeoutMs: 200,
  })
})

afterEach(async () => {
  await runtime.shutdown().catch(() => {})
  await rm(tmpDir, { recursive: true, force: true })
})

describe('runOne resultText(dispatch 路径,primitives 流)', () => {
  it('从 text_delta 累积文本,message_stop 时落为 resultText(排除 thinking_delta)', async () => {
    const task = await runtime.dispatch({
      prompt: 'x',
      metadata: {},
    })

    // dispatch 是 setImmediate 调度 + runOne 异步,轮询等终态
    let t: BackgroundTask | null = null
    for (let i = 0; i < 100; i++) {
      t = await runtime.get(task.id)
      if (t?.status === 'completed') break
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(t?.status).toBe('completed')
    expect(t?.resultText).toBe('你好世界!')
  })
})