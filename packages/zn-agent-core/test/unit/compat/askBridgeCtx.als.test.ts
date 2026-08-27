/**
 * zai patch (2026-08-27) — resolveAskBridgeCtx 的 sessionId 优先级:
 * ALS(runWithSessionId)> __zaiBridgeCtx.sessionId(全局指针)。
 *
 * 动机:inproc print track 每 session 的整个 runHeadless 链都包在
 * runWithSessionId 里,N 个并发 session 各自拿到自己的 sessionId;
 * 轻量 track 无 ALS → 回退全局指针,行为不变。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAskBridgeCtx } from '../../../src/compat/tools/opencc/AskUserQuestionTool.js'
import {
  getCurrentSessionId,
  runWithSessionId,
} from '../../../src/compat/runWithSessionId.js'

const BRIDGE_KEY = '__zaiBridgeCtx'

function withBridge(v: unknown, fn: () => void) {
  const saved = (globalThis as any)[BRIDGE_KEY]
  if (v === undefined) delete (globalThis as any)[BRIDGE_KEY]
  else (globalThis as any)[BRIDGE_KEY] = v
  try {
    fn()
  } finally {
    if (saved === undefined) delete (globalThis as any)[BRIDGE_KEY]
    else (globalThis as any)[BRIDGE_KEY] = saved
  }
}

describe('resolveAskBridgeCtx', () => {
  it('无 ALS 时回退 __zaiBridgeCtx.sessionId(轻量 track 行为不变)', () => {
    withBridge({ sessionId: 'global-sid', askRegistry: 'reg' }, () => {
      const ctx = resolveAskBridgeCtx()
      expect(ctx.sessionId).toBe('global-sid')
      expect(ctx.askRegistry).toBe('reg')
    })
  })

  it('ALS 存在时优先于全局指针', () => {
    withBridge({ sessionId: 'global-sid' }, () => {
      runWithSessionId('als-sid', () => {
        expect(resolveAskBridgeCtx().sessionId).toBe('als-sid')
      })
    })
  })

  it('两个并发异步链各自解析到自己的 sessionId', async () => {
    withBridge({ sessionId: 'stale-pointer' }, async () => {
      const a = runWithSessionId('A', async () => {
        await new Promise(r => setTimeout(r, 5))
        return resolveAskBridgeCtx().sessionId
      })
      const b = runWithSessionId('B', async () => {
        await new Promise(r => setTimeout(r, 2))
        return resolveAskBridgeCtx().sessionId
      })
      expect(await Promise.all([a, b])).toEqual(['A', 'B'])
    })
  })

  it('链外恢复:ALS 结束后 getCurrentSessionId 为 undefined', () => {
    runWithSessionId('tmp', () => {
      expect(getCurrentSessionId()).toBe('tmp')
    })
    expect(getCurrentSessionId()).toBeUndefined()
  })

  it('__zaiBridgeCtx 完全缺失时 sessionId=undefined(stub 分支语义保留)', () => {
    withBridge(undefined, () => {
      const ctx = resolveAskBridgeCtx()
      expect(ctx.sessionId).toBeUndefined()
      expect(ctx.askRegistry).toBeUndefined()
    })
  })
})
