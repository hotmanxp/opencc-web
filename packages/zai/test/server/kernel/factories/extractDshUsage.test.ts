/**
 * dsh factory 内部 helper `extractDshUsage` 的单元测试。
 *
 * 验收：
 * - `assistant/chunk` 的 `chunk.type === 'usage'` → 转 opencc 风格
 *   `{ input, cache_creation, cache_read, output }`,写 globalThis
 *   __zaiApiCountLastUsage,供 `getLastContextTokens()` 读出。
 * - `assistant/message.usage` (结构化收尾) → 同上,last-wins 替换。
 * - `assistant/chunk` 其他子类型 (text-delta / reasoning-delta / block-start
 *   / block-end / finish) → null,不污染 slot。
 * - `assistant/message` 没有 usage 字段(adapter 未上报) → null。
 * - 其他 SessionEventType (turn/start / tool/call / tool/result) → null。
 *
 * 注:helper 是 module-private 的 `factories/dsh.ts` 导出,单测直接 import
 * `extractDshUsage` 验证映射正确性。运行时由 `factories/dsh.ts:run()`
 * 在每次 yield 之前调用,结合 `setLastContextUsage` 写 slot。
 */
import { describe, it, expect } from 'vitest'
import { extractDshUsage } from '../../../../src/server/services/kernel/factories/dsh.js'

describe('extractDshUsage', () => {
  it('assistant/chunk (usage chunk) → opencc 风格 usage', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 5,
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'usage',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 30,
            cacheWriteTokens: 20,
          },
        },
      },
    }
    expect(extractDshUsage(event)).toEqual({
      input: 100,
      cache_creation: 20,
      cache_read: 30,
      output: 50,
    })
  })

  it('assistant/chunk (usage chunk) 缺 cache 字段 → 视为 0', () => {
    // dsh-llm-pi-ai mapUsage 仅在 cache > 0 时带 cacheReadTokens / cacheWriteTokens,
    // pi-ai 报 0 时直接 absent。opencc 公式: input + cache_creation + cache_read,
    // 缺字段 → 0,不算入 context(避免被 0 拖累,这是正确语义)。
    const event = {
      type: 'assistant/chunk',
      seq: 5,
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 200, outputTokens: 80 },
        },
      },
    }
    expect(extractDshUsage(event)).toEqual({
      input: 200,
      cache_creation: 0,
      cache_read: 0,
      output: 80,
    })
  })

  it('assistant/message (结构化收尾,带 usage) → opencc 风格 usage', () => {
    const event = {
      type: 'assistant/message',
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'answer' }] },
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
        },
      },
    }
    expect(extractDshUsage(event)).toEqual({
      input: 500,
      cache_creation: 50,
      cache_read: 100,
      output: 200,
    })
  })

  it('assistant/message 无 usage 字段 → null (adapter 未上报时正常)', () => {
    const event = {
      type: 'assistant/message',
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'answer' }] },
      },
    }
    expect(extractDshUsage(event)).toBeNull()
  })

  it('assistant/chunk (text-delta) → null (不污染 slot)', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 5,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hello' } },
    }
    expect(extractDshUsage(event)).toBeNull()
  })

  it('assistant/chunk (reasoning-delta) → null', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 5,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking...' } },
    }
    expect(extractDshUsage(event)).toBeNull()
  })

  it('assistant/chunk (block-end) → null', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 5,
      data: { turn: 1, step: 1, chunk: { type: 'block-end', block: { type: 'text', text: 'final' } } },
    }
    expect(extractDshUsage(event)).toBeNull()
  })

  it('assistant/chunk (finish) → null', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 5,
      data: { turn: 1, step: 1, chunk: { type: 'finish', reason: 'stop' } },
    }
    expect(extractDshUsage(event)).toBeNull()
  })

  it('turn/start → null', () => {
    expect(extractDshUsage({ type: 'turn/start', seq: 1, data: { turn: 1 } })).toBeNull()
  })

  it('turn/end → null', () => {
    expect(
      extractDshUsage({
        type: 'turn/end',
        seq: 4,
        data: { turn: 1, reason: { kind: 'completed' } },
      }),
    ).toBeNull()
  })

  it('tool/call → null', () => {
    expect(
      extractDshUsage({
        type: 'tool/call',
        seq: 5,
        data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' },
      }),
    ).toBeNull()
  })

  it('tool/result → null', () => {
    expect(
      extractDshUsage({
        type: 'tool/result',
        seq: 6,
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: 'ok' }] },
        },
      }),
    ).toBeNull()
  })

  it('data 缺失 (防御性) → null', () => {
    expect(extractDshUsage({ type: 'assistant/chunk', seq: 1, data: undefined })).toBeNull()
  })

  it('usage 字段全 0 (Anthropic warmup 探针) → 返回全 0 对象,非 null', () => {
    // 全 0 不是"缺 usage",而是真实 usage=0 — 应当写 slot,让后续 turn
    // 的 runtime.done 仍能 emit session/projection 帧(context=0 触发
    // 前端的 "—" placeholder,但不阻塞其他逻辑)。
    const event = {
      type: 'assistant/message',
      seq: 1,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '' }] },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    }
    expect(extractDshUsage(event)).toEqual({
      input: 0,
      cache_creation: 0,
      cache_read: 0,
      output: 0,
    })
  })
})