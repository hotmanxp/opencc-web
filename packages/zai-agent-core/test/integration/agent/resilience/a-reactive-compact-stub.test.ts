/**
 * 集成测试 — A.4 reactive compact stub (tryReactiveCompact).
 *
 * 覆盖 spec §3 行为 14-16 + spec §4 的 3 个 case。
 * Stage 1 compactConversation 存在 → 'attempted' + newMessages
 * 抛错 → 'failed',不抛。
 *
 * 测试策略: 每个 case 用 vi.doMock + vi.resetModules
 * 让 source file 里的 await import 走的是 mock factory。
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

describe('integration: tryReactiveCompact stub', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    vi.resetModules()
    originalNodeEnv = process.env.NODE_ENV
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    vi.restoreAllMocks()
    vi.resetModules()
  })

  // ----- Case 1: Stage 1 不存在 → unimplemented -----
  describe('Stage 1 不存在', () => {
    beforeEach(() => {
      vi.doMock('../../../../src/runtime/compact/conversation.js', () => ({
        compactConversation: undefined,
        buildPostCompactMessages: undefined,
      }))
    })

    test('mock import 返回 undefined → kind:unimplemented', async () => {
      const { tryReactiveCompact } = await import(
        '../../../../src/runtime/errors/reactiveCompact.js'
      )
      const result = await tryReactiveCompact(
        [],
        (() => (async function* () {})()) as any,
        new AbortController().signal,
      )
      expect(result.kind).toBe('unimplemented')
      expect(result.newMessages).toBeUndefined()
    })
  })

  // ----- Case 2: Stage 1 存在 + 成功 → attempted -----
  describe('Stage 1 成功', () => {
    beforeEach(() => {
      const fakeBoundary = {
        uuid: 'bnd-1',
        parentUuid: null,
        type: 'system',
        timestamp: 1,
        raw: null,
        runtime: { turnIndex: 0 },
        version: '2',
        message: {
          content: [{ type: 'text', text: 'boundary' }],
          role: 'system',
        },
        cwd: '/',
        sessionId: 'sess-rc-1',
        userType: 'zai',
        isSidechain: false,
      }
      const fakeSummary = {
        uuid: 'sum-1',
        parentUuid: 'bnd-1',
        type: 'assistant',
        timestamp: 2,
        raw: null,
        runtime: { turnIndex: 0 },
        version: '2',
        message: {
          content: [{ type: 'text', text: 'summary text' }],
          role: 'assistant',
        },
        cwd: '/',
        sessionId: 'sess-rc-1',
        userType: 'zai',
        isSidechain: false,
      }
      vi.doMock('../../../../src/runtime/compact/conversation.js', () => ({
        compactConversation: async () => ({
          boundaryMarker: fakeBoundary,
          summaryMessages: [fakeSummary],
          attachments: [],
          hookResults: [],
          messagesToKeep: [],
          preCompactTokenCount: 100,
          postCompactTokenCount: 5,
        }),
        buildPostCompactMessages: (r: any) => [
          r.boundaryMarker,
          ...r.summaryMessages,
          ...(r.messagesToKeep ?? []),
          ...r.attachments,
          ...r.hookResults,
        ],
      }))
    })

    test('调 compactConversation 成功 → kind:attempted + newMessages', async () => {
      const { tryReactiveCompact } = await import(
        '../../../../src/runtime/errors/reactiveCompact.js'
      )
      const caller = (() => (async function* () {})()) as any
      const messages = [{ role: 'user' as const, content: 'msg-1' }]
      const result = await tryReactiveCompact(
        messages as any,
        caller,
        new AbortController().signal,
      )
      expect(result.kind).toBe('attempted')
      expect(Array.isArray(result.newMessages)).toBe(true)
      expect(result.newMessages?.length).toBeGreaterThanOrEqual(2)
      // 验证 boundary + summary content 都在 newMessages 中
      const allContent = JSON.stringify(result.newMessages)
      expect(allContent).toContain('boundary')
      expect(allContent).toContain('summary text')
    })
  })

  // ----- Case 3: Stage 1 抛错 → failed -----
  describe('Stage 1 抛错', () => {
    beforeEach(() => {
      vi.doMock('../../../../src/runtime/compact/conversation.js', () => ({
        compactConversation: async () => {
          throw new Error('compact failed: model unavailable')
        },
        buildPostCompactMessages: undefined,
      }))
    })

    test('compactConversation 抛错 → kind:failed, 不抛', async () => {
      const { tryReactiveCompact } = await import(
        '../../../../src/runtime/errors/reactiveCompact.js'
      )
      const caller = (() => (async function* () {})()) as any
      const result = await tryReactiveCompact([], caller, new AbortController().signal)
      expect(result.kind).toBe('failed')
      expect(result.reason).toContain('compact failed')
    })
  })

  // ----- Case 4: 永不抛 -----
  describe('永不抛', () => {
    test('modelCaller 抛错时仍返结果不抛', async () => {
      const { tryReactiveCompact } = await import(
        '../../../../src/runtime/errors/reactiveCompact.js'
      )
      const caller = (() =>
        (async function* () {
          throw new Error('caller broken')
        })()) as any
      // 即便 modelCaller 抛错,reactiveCompact 也应该兜底
      await expect(
        tryReactiveCompact([], caller, new AbortController().signal),
      ).resolves.toBeDefined()
    })
  })

  // ----- Case 5: abort 行为 -----
  describe('abort signal', () => {
    test('abort 触发后不抛, 返 valid kind', async () => {
      const { tryReactiveCompact } = await import(
        '../../../../src/runtime/errors/reactiveCompact.js'
      )
      const ac = new AbortController()
      ac.abort()
      const caller = (() => (async function* () {})()) as any
      const result = await tryReactiveCompact([], caller, ac.signal)
      expect(['unimplemented', 'failed', 'attempted']).toContain(result.kind)
    })
  })
})