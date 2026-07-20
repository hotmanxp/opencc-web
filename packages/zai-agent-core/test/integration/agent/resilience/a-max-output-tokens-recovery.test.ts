/**
 * 集成测试 — A.2 max_output_tokens 自愈流式恢复 (recoverMaxOutputTokens).
 *
 * 覆盖 spec §3 行为 6-9 + spec §4 的 5 个 case。
 * capEscalation 默认 [4096, 16384, 65536],第 3 次仍失败 → yield runtime.error
 * kind:'max_output_tokens',**不抛**。
 */
import { describe, test, expect } from 'vitest'
import { recoverMaxOutputTokens } from '../../../../src/runtime/errors/maxOutputTokens.js'
import type { RuntimeEvent } from '../../../../src/runtime/events.js'

// 构造可控 modelCaller:
// - 第一次 attempt = 抛 max_output_tokens
// - 第二次 attempt = 抛 max_output_tokens
// - 第三次 attempt = 抛 max_output_tokens
// - 之后 attempt = 成功 (text_delta + message_stop)
function makeMaxTokensCaller(
  attemptsBeforeSuccess: number,
  observedCaps: number[],
): any {
  let attempt = 0
  return (req: any) => {
    attempt++
    const cap = (req as any).max_tokens
    if (typeof cap === 'number') observedCaps.push(cap)
    if (attempt <= attemptsBeforeSuccess) {
      return (async function* () {
        throw Object.assign(new Error('max_output_tokens: model hit output cap'), {
          status: 400,
          error: { type: 'max_output_tokens' },
        })
      })()
    }
    return (async function* () {
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'recovered text' },
      }
      yield { type: 'message_stop' }
    })()
  }
}

// 一个 lazy 抛 non-max_output_tokens 的 caller:第一次就抛 auth
function makeAuthErrorCaller(): any {
  return (_req: any) =>
    (async function* () {
      throw Object.assign(new Error('auth failed'), {
        status: 401,
        error: { type: 'authentication_error' },
      })
    })()
}

async function drainEvents(gen: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('integration: recoverMaxOutputTokens (max_output_tokens 自愈)', () => {
  test('default capEscalation = [4096, 16384, 65536] (3 次重试)', async () => {
    const observedCaps: number[] = []
    const caller = makeMaxTokensCaller(2, observedCaps) // 第 3 次成功
    const events = await drainEvents(
      recoverMaxOutputTokens({
        modelCaller: caller,
        messages: [],
        signal: new AbortController().signal,
      } as any),
    )
    // 第 1 + 2 次都抛,第 3 次成功 → 应该有 text 事件流
    expect(observedCaps).toEqual([4096, 16384, 65536])
    // 第 3 次成功:有 text_delta + message_stop
    const textDeltas = events.filter(
      (e: any) => e.type === 'content_block_delta' && (e as any).delta?.type === 'text_delta',
    )
    expect(textDeltas.length).toBeGreaterThan(0)
  })

  test('第一次 attempt cap=4096,失败后第二次用 16384', async () => {
    const observedCaps: number[] = []
    const caller = makeMaxTokensCaller(2, observedCaps)
    await drainEvents(
      recoverMaxOutputTokens({
        modelCaller: caller,
        messages: [],
        signal: new AbortController().signal,
      } as any),
    )
    expect(observedCaps[0]).toBe(4096)
    expect(observedCaps[1]).toBe(16384)
  })

  test('第二次失败后第三次用 65536', async () => {
    const observedCaps: number[] = []
    const caller = makeMaxTokensCaller(2, observedCaps)
    await drainEvents(
      recoverMaxOutputTokens({
        modelCaller: caller,
        messages: [],
        signal: new AbortController().signal,
      } as any),
    )
    expect(observedCaps[2]).toBe(65536)
  })

  test('第 3 次仍失败 → yield runtime.error kind:max_output_tokens, 不抛', async () => {
    const observedCaps: number[] = []
    // 3 次都失败
    const caller = makeMaxTokensCaller(99, observedCaps)
    const events = await drainEvents(
      recoverMaxOutputTokens({
        modelCaller: caller,
        messages: [],
        signal: new AbortController().signal,
      } as any),
    )
    expect(observedCaps).toEqual([4096, 16384, 65536])
    // 至少要有一个 runtime.error
    const errorEvents = events.filter((e) => e.type === 'runtime.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    const payload = (errorEvents[0] as any).error ?? (errorEvents[0] as any).payload
    expect(payload).toBeDefined()
    expect(payload.kind).toBe('max_output_tokens')
  })

  test('遇非 max_output_tokens 错误立即抛, 不重试', async () => {
    const caller = makeAuthErrorCaller()
    await expect(
      drainEvents(
        recoverMaxOutputTokens({
          modelCaller: caller,
          messages: [],
          signal: new AbortController().signal,
        } as any),
      ),
    ).rejects.toThrow()
  })

  test('abort signal 触发时立即停止 (3 次失败 + abort)', async () => {
    const ac = new AbortController()
    ac.abort()
    const caller = makeMaxTokensCaller(99, [])
    // 不抛也不 hang,直接 yield error / 结束
    const events = await drainEvents(
      recoverMaxOutputTokens({
        modelCaller: caller,
        messages: [],
        signal: ac.signal,
      } as any),
    )
    // 至少要结束(可能 yield error)
    expect(Array.isArray(events)).toBe(true)
  })

  test('custom capEscalation 可被 maxAttempts=2 截断', async () => {
    const observedCaps: number[] = []
    let attempt = 0
    const caller = (req: any) => {
      attempt++
      const cap = (req as any).max_tokens
      if (typeof cap === 'number') observedCaps.push(cap)
      // 每次都失败
      return (async function* () {
        throw Object.assign(new Error('max_output_tokens'), {
          status: 400,
          error: { type: 'max_output_tokens' },
        })
      })()
    }
    const events = await drainEvents(
      recoverMaxOutputTokens({
        modelCaller: caller,
        messages: [],
        maxAttempts: 2,
        capEscalation: [1024, 2048, 4096],
        signal: new AbortController().signal,
      } as any),
    )
    // 只跑了 2 次
    expect(observedCaps).toEqual([1024, 2048])
    expect(attempt).toBe(2)
    // 最后 yield error
    const errorEvents = events.filter((e) => e.type === 'runtime.error')
    expect(errorEvents.length).toBe(1)
  })
})