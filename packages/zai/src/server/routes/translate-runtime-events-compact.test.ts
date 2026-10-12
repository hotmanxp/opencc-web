import { describe, expect, test } from 'vitest'
import { translateRuntimeEvents } from './agent.js'

// 压缩边界事件接线 (2026-10-12)。
//
// 回归背景: vendor 把压缩边界以 `system` + `subtype:'compact_boundary'` 的
// Message 形式 yield 出来 (opencc-src/query.ts 的
// `for (const message of postCompactMessages) yield message`), adapter
// (compat/runtime/sdkEventAdapter.ts:109) 明确放行并直通成 RuntimeEvent,
// 但 translator 一直没有 case 'system' —— 事件落到 `default: break` 被静默
// 丢弃, 这就是"压缩时 UI 毫无反应"的根因。

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const it of items) yield it
    },
  }
}

async function collect(events: Array<Record<string, unknown>>, sid = 'sess-compact') {
  const out: Array<Record<string, unknown>> = []
  for await (const ev of translateRuntimeEvents(
    makeAsyncIterable(events),
    sid,
  )) {
    out.push(ev as Record<string, unknown>)
  }
  return out
}

describe('translateRuntimeEvents — compact_boundary', () => {
  test('system/compact_boundary produces compact_boundary + runtime.compacted', async () => {
    const out = await collect([
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'bnd-1',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 180000,
          messagesSummarized: 42,
        },
      },
      { type: 'message_stop' },
    ])

    const boundary = out.find((e) => e.type === 'compact_boundary')
    expect(boundary).toBeDefined()
    expect(boundary).toMatchObject({
      sessionId: 'sess-compact',
      trigger: 'auto',
      preTokens: 180000,
      messagesSummarized: 42,
    })

    const compacted = out.find((e) => e.type === 'runtime.compacted')
    expect(compacted).toBeDefined()
    expect(compacted).toMatchObject({
      sessionId: 'sess-compact',
      trigger: 'auto',
      preTokens: 180000,
    })
    // vendor 的 compactMetadata 里没有 post-compact token 数 (那个值只在
    // CompactionResult 里), 所以这两个字段必须**缺席**, 而不是被填 0 ——
    // 填 0 会让 UI 显示"节省 0 tokens"说谎.
    expect(compacted).not.toHaveProperty('postTokens')
    expect(compacted).not.toHaveProperty('savedTokens')
    expect(typeof compacted!.timestamp).toBe('number')
  })

  test('missing/partial compactMetadata degrades to auto + preTokens 0', async () => {
    // 防御: boundary 载荷不完整时不能抛,也不能漏发事件。
    const out = await collect([
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'message_stop' },
    ])

    const compacted = out.find((e) => e.type === 'runtime.compacted')
    expect(compacted).toMatchObject({ trigger: 'auto', preTokens: 0 })
    const boundary = out.find((e) => e.type === 'compact_boundary')
    expect(boundary).toMatchObject({ trigger: 'auto', preTokens: 0 })
    // undefined 的 messagesSummarized 不应作为键出现
    expect(boundary).not.toHaveProperty('messagesSummarized')
  })

  test('other system subtypes are ignored (no compaction events)', async () => {
    // init / task_started / status 等不是压缩, 不应产生任何 compact 事件,
    // 也不能因为新增 case 'system' 而改变既有行为。
    const out = await collect([
      { type: 'system', subtype: 'init', tools: [] },
      { type: 'system', subtype: 'task_started', task_id: 't1' },
      { type: 'message_stop' },
    ])

    expect(out.filter((e) => e.type === 'compact_boundary')).toHaveLength(0)
    expect(out.filter((e) => e.type === 'runtime.compacted')).toHaveLength(0)
  })

  test('manual trigger is preserved', async () => {
    const out = await collect([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'manual', preTokens: 5000 },
      },
      { type: 'message_stop' },
    ])

    expect(out.find((e) => e.type === 'compact_boundary')).toMatchObject({
      trigger: 'manual',
      preTokens: 5000,
    })
    expect(out.find((e) => e.type === 'runtime.compacted')).toMatchObject({
      trigger: 'manual',
    })
  })
})
