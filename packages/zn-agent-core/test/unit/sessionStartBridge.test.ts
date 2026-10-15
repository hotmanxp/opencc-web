/**
 * zai patch (2026-10-11):SessionStart hook 接线 —— 上下文存储与抽取的单测。
 *
 * 背景:headless 路径原先从不派发 SessionStart(`processSessionStartHooks` 的
 * 唯一调用方是 vendor `main.tsx`,即交互式 REPL 入口),与当初 `loadMods` 的
 * 缺口同一形状。修复后 mod 的 SessionStart handler 能收到事件,但产出的
 * `HookResultMessage[]` 在 headless 侧没有消费方 —— REPL 是把它塞进本会话
 * 消息流,zai 没有那个位置。故只取 `hook_additional_context` 一类,存起来由
 * pre-API-call reminder provider 注入。
 *
 * 这里钉住「只取该取的、不取 REPL 专属的」,避免以后有人把 hook 产出的
 * message 也塞进去,导致每个会话开头多出不属于它的内容。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setSessionStartContexts,
  getSessionStartContexts,
  extractAdditionalContexts,
  __resetSessionStartContextsForTesting,
  clearSessionStartContexts,
} from '../../src/opencc-src/server/sessionStartBridge.js'

describe('sessionStartBridge', () => {
  beforeEach(() => {
    __resetSessionStartContextsForTesting()
  })

  describe('extractAdditionalContexts', () => {
    it('取出 hook_additional_context 附件的字符串数组', () => {
      const got = extractAdditionalContexts([
        { attachment: { type: 'hook_additional_context', content: ['a', 'b'] } },
      ])
      expect(got).toEqual(['a', 'b'])
    })

    it('兼容 content 是单字符串的形式', () => {
      const got = extractAdditionalContexts([
        { attachment: { type: 'hook_additional_context', content: 'solo' } },
      ])
      expect(got).toEqual(['solo'])
    })

    it('跳过非 hook_additional_context —— 那是 REPL 消息流专用', () => {
      const got = extractAdditionalContexts([
        { attachment: { type: 'hook_success', content: 'nope' } },
        { attachment: { type: 'hook_system_message', content: 'nope' } },
        { attachment: { type: 'hook_additional_context', content: ['yes'] } },
      ])
      expect(got).toEqual(['yes'])
    })

    it('容忍缺 attachment / content 的畸形输入', () => {
      const got = extractAdditionalContexts([
        {},
        { attachment: {} },
        { attachment: { type: 'hook_additional_context' } },
        { attachment: { type: 'hook_additional_context', content: [1, 'ok'] } },
      ] as Array<Record<string, unknown>>)
      // 非字符串元素跳过,字符串保留
      expect(got).toEqual(['ok'])
    })

    it('空数组 → 空结果', () => {
      expect(extractAdditionalContexts([])).toEqual([])
    })
  })

  describe('存储', () => {
    it('set 后能读回', () => {
      setSessionStartContexts('s1', ['x', 'y'])
      expect(getSessionStartContexts('s1')).toEqual(['x', 'y'])
    })

    it('重复项去重', () => {
      setSessionStartContexts('s1', ['dup', 'dup', 'other'])
      expect(getSessionStartContexts('s1')).toEqual(['dup', 'other'])
    })

    it('过滤空串与纯空白', () => {
      setSessionStartContexts('s1', ['ok', '', '   ', null as unknown as string])
      expect(getSessionStartContexts('s1')).toEqual(['ok'])
    })

    it('set 是替换而非累加 —— 重复派发(如 reload)不该往里堆', () => {
      setSessionStartContexts('s1', ['first'])
      setSessionStartContexts('s1', ['second'])
      expect(getSessionStartContexts('s1')).toEqual(['second'])
    })

    it('读回的是副本,外部改动不污染内部状态', () => {
      setSessionStartContexts('s1', ['a'])
      const got = getSessionStartContexts('s1') as string[]
      got.push('mutated')
      expect(getSessionStartContexts('s1')).toEqual(['a'])
    })

    it('A 会话的上下文不会泄漏到 B 会话', () => {
      setSessionStartContexts('A', ['A 的上下文'])
      setSessionStartContexts('B', ['B 的上下文'])
      expect(getSessionStartContexts('A')).toEqual(['A 的上下文'])
      expect(getSessionStartContexts('B')).toEqual(['B 的上下文'])
    })

    it('未注册的会话读到空结果而不是别人的内容', () => {
      setSessionStartContexts('A', ['A 的上下文'])
      expect(getSessionStartContexts('never-seen')).toEqual([])
    })

    it('clear 只丢指定会话', () => {
      setSessionStartContexts('A', ['a'])
      setSessionStartContexts('B', ['b'])
      clearSessionStartContexts('A')
      expect(getSessionStartContexts('A')).toEqual([])
      expect(getSessionStartContexts('B')).toEqual(['b'])
    })
  })
})