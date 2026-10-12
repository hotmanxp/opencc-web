// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { deriveTranscriptNodes } from './deriveTranscriptNodes.js'
import type { AgentMessage } from '../../store/useAgentStore.js'

// 压缩分界线的节点派生 (2026-10-12)。
//
// 关键行为: 分界线必须**切断**前后文本段(否则压缩前后的正文会被合进同一个
// text node 渲染成连续散文,视觉上完全看不出这里发生过压缩), 并且独立成
// compactBoundary 节点而不是落进 text 桶 —— MessageBubble 对未知 type 返回
// null, 落进去等于隐形。

function msg(type: string, extra: Record<string, unknown> = {}): AgentMessage {
  return {
    eventId: `${type}-${Math.random()}`,
    sessionId: 's1',
    ts: 1,
    turnIndex: 0,
    type,
    ...extra,
  } as AgentMessage
}

describe('deriveTranscriptNodes — compact_boundary', () => {
  test('分界线前后文本段被切开', () => {
    const nodes = deriveTranscriptNodes([
      msg('assistant.text', { text: '压缩前的回答' }),
      msg('compact_boundary', { trigger: 'auto', preTokens: 90000 }),
      msg('assistant.text', { text: '压缩后的回答' }),
    ])
    expect(nodes.map((n) => n.kind)).toEqual([
      'text',
      'compactBoundary',
      'text',
    ])
  })

  test('分界线在开头 / 结尾时不产生空 text 节点', () => {
    const head = deriveTranscriptNodes([
      msg('compact_boundary', { trigger: 'auto' }),
      msg('assistant.text', { text: 'x' }),
    ])
    expect(head.map((n) => n.kind)).toEqual(['compactBoundary', 'text'])

    const tail = deriveTranscriptNodes([
      msg('assistant.text', { text: 'x' }),
      msg('compact_boundary', { trigger: 'manual' }),
    ])
    expect(tail.map((n) => n.kind)).toEqual(['text', 'compactBoundary'])
  })

  test('分界线同时切断工具段', () => {
    const nodes = deriveTranscriptNodes([
      msg('tool_use:start', { toolUseId: 't1', name: 'Bash' }),
      msg('tool_use:done', { toolUseId: 't1', name: 'Bash', output: 'ok' }),
      msg('compact_boundary', { trigger: 'auto' }),
      msg('assistant.text', { text: '压缩后' }),
    ])
    expect(nodes.map((n) => n.kind)).toEqual(['toolGroup', 'compactBoundary', 'text'])
  })

  test('连续两条分界线各自成节点', () => {
    const nodes = deriveTranscriptNodes([
      msg('compact_boundary', { trigger: 'auto' }),
      msg('compact_boundary', { trigger: 'manual' }),
    ])
    expect(nodes.map((n) => n.kind)).toEqual(['compactBoundary', 'compactBoundary'])
  })

  test('分界线消息载荷原样传给节点', () => {
    const boundary = msg('compact_boundary', {
      trigger: 'auto',
      preTokens: 180000,
      messagesSummarized: 42,
      summary: '摘要正文',
    })
    const nodes = deriveTranscriptNodes([boundary])
    const node = nodes[0]!
    expect(node.kind).toBe('compactBoundary')
    if (node.kind === 'compactBoundary') {
      expect(node.message).toBe(boundary)
    }
  })

  test('没有分界线时行为不变', () => {
    const nodes = deriveTranscriptNodes([
      msg('assistant.text', { text: 'a' }),
      msg('assistant.text', { text: 'b' }),
    ])
    expect(nodes.map((n) => n.kind)).toEqual(['text'])
  })
})
