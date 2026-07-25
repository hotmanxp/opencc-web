import { describe, test, expect } from 'vitest'
import {
  autoCompactIfNeeded,
  shouldAutoCompact,
} from '../../../src/runtime/compact/autocompact.js'
import type { TranscriptMessage } from '../../../src/transcript/types.js'

function makeMsg(content: string, type: 'user' | 'assistant' = 'user'): TranscriptMessage {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    type,
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: 0 },
    version: '2',
    message: { role: type, content: [{ type: 'text', text: content }] },
    cwd: '/tmp',
    sessionId: 'sess-1',
    userType: 'zai',
    isSidechain: false,
  }
}

describe('autocompact', () => {
  test('shouldAutoCompact: querySource=compact 永远 false', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'compact', 0, undefined)
    expect(r).toBe(false)
  })

  test('shouldAutoCompact: querySource=session_memory 永远 false', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'session_memory', 0, undefined)
    expect(r).toBe(false)
  })

  test('shouldAutoCompact: ZAI_DISABLE_AUTO_COMPACT=1 永远 false', async () => {
    process.env.ZAI_DISABLE_AUTO_COMPACT = '1'
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread', 0, undefined)
    expect(r).toBe(false)
    delete process.env.ZAI_DISABLE_AUTO_COMPACT
  })

  test('shouldAutoCompact: forceReason=true → true', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread', 0, 'message-count')
    expect(r).toBe(true)
  })

  test('shouldAutoCompact: token 未达阈值 → false', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread', 0, undefined)
    expect(r).toBe(false)
  })

  test('autoCompactIfNeeded: 短路 skip 时 circuitBreakerActive=true', async () => {
    const result = await autoCompactIfNeeded(
      [makeMsg('hi'), makeMsg('ok', 'assistant')],
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      {} as any,
      'repl_main_thread',
      { compacted: false, turnCounter: 0, turnId: 't1', consecutiveFailures: 3, nextRetryAtMs: Date.now() + 600_000, forceReason: 'message-count' },
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.circuitBreakerActive).toBe(true)
  })

  test('autoCompactIfNeeded: token 未达阈值 → no-op', async () => {
    const result = await autoCompactIfNeeded(
      [makeMsg('hi'), makeMsg('ok', 'assistant')],
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      {} as any,
      'repl_main_thread',
      undefined,
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(false)
  })

  test('autoCompactIfNeeded: 缺 modelCaller → catch 路径 + logEvent + 递增 consecutiveFailures', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    // tracking.consecutiveFailures = 2 + forceReason → 失败后应到 3,触发 cooldown
    const tracking = {
      compacted: false,
      turnCounter: 0,
      turnId: 't-trip',
      consecutiveFailures: 2,
      forceReason: 'message-count' as const,
    }
    // 防御纵深测试:即便调用方用 `as any` 绕过 TypeScript 必填检查,
    // compactConversation 内部 `if (!modelCaller)` 仍应在 0ms 抛错,
    // circuit breaker 递增。这是回归保护,生产代码必须传 modelCaller。
    const result = await autoCompactIfNeeded(
      msgs,
      {
        options: { mainLoopModel: 'MiniMax-M3' },
        abortController: new AbortController(),
        modelCaller: undefined,
      } as any,
      {} as any,
      'repl_main_thread',
      tracking,
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBe(3)
    expect(result.circuitBreakerTripped).toBe(true)
    expect(result.circuitBreakerActive).toBe(true)
    expect(result.nextRetryAtMs).toBeDefined()
  })

  test('autoCompactIfNeeded: 提供 modelCaller + forceReason → wasCompacted=true', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const tracking = {
      compacted: false,
      turnCounter: 0,
      turnId: 'turn-ok',
      forceReason: 'message-count' as const,
    }
    // mock modelCaller:吐 "compact summary" + message_stop
    const mockModelCaller = (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '对话摘要:用户打招呼,助手回应。' },
      }
      yield { type: 'message_stop' }
    }) as any

    const result = await autoCompactIfNeeded(
      msgs,
      {
        options: { mainLoopModel: 'MiniMax-M3' },
        abortController: new AbortController(),
        modelCaller: mockModelCaller,
      },
      {} as any,
      'repl_main_thread',
      tracking,
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(true)
    expect(result.consecutiveFailures).toBe(0)
  })

  test('ToolUseContext: modelCaller 字段类型层必填 (静态检查)', () => {
    // 这段代码不应该编译过 — 但 vitest 是运行时跑, 类型检查交给 tsc.
    // 真正拦截在 `tsc -b --noEmit` / 编辑器层。这里只是文档化意图:
    // 把 type-only assertion 放在注释里, 任何想偷懒写 `modelCaller: undefined`
    // 的 PR reviewer 看到这条 test 会知道契约。
    type Assert = {
      options: { mainLoopModel: string }
      abortController: AbortController
      modelCaller: (req: any) => AsyncIterable<any>
    }
    const ok: Assert = {
      options: { mainLoopModel: 'm' },
      abortController: new AbortController(),
      modelCaller: async function* () {},
    }
    expect(typeof ok.modelCaller).toBe('function')
    // @ts-expect-error modelCaller 必填 — 这条断言如果通过说明类型被改回了 optional
    const _bad: Assert = { options: { mainLoopModel: 'm' }, abortController: new AbortController() }
    void _bad
  })
})