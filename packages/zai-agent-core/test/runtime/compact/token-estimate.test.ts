import { describe, expect, it } from 'vitest'
import { estimateMessagesTokenCount } from '../../../src/runtime/compact/token-estimate.js'

function mkMsg(content: unknown, type: string = 'user'): any {
  return { type, message: { content }, cwd: '/', sessionId: 's', uuid: Math.random().toString() }
}

describe('estimateMessagesTokenCount', () => {
  it('中文 text 按 1.5 字符/token', () => {
    const msg = mkMsg([{ type: 'text', text: '一二三四五六七八九'.repeat(3) }])
    expect(estimateMessagesTokenCount([msg])).toBe(18)
  })

  it('英文 text 按 4 字符/token', () => {
    const msg = mkMsg([{ type: 'text', text: 'a'.repeat(40) }])
    expect(estimateMessagesTokenCount([msg])).toBe(10)
  })

  it('混合(50/50)按 2.5 字符/token', () => {
    const msg = mkMsg([{ type: 'text', text: '一'.repeat(20) + 'a'.repeat(20) }])
    expect(estimateMessagesTokenCount([msg])).toBe(16)
  })

  it('thinking block 同 text', () => {
    const msg = mkMsg([{ type: 'thinking', thinking: '一二三四五六七八九'.repeat(3) }], 'assistant')
    expect(estimateMessagesTokenCount([msg])).toBe(18)
  })

  it('image block 固定 1000 tokens', () => {
    const msg = mkMsg([{ type: 'image', source: { media_type: 'image/png' } }])
    expect(estimateMessagesTokenCount([msg])).toBe(1000)
  })

  it('tool_use block 按 (name + JSON.stringify(input).length) / 3', () => {
    const msg = mkMsg([{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }], 'assistant')
    expect(estimateMessagesTokenCount([msg])).toBe(6)
  })

  it('tool_result block 按 JSON.stringify(content).length / 3', () => {
    const msg = mkMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'hello world' }])
    expect(estimateMessagesTokenCount([msg])).toBe(5)
  })

  it('空 messages 返回 0', () => {
    expect(estimateMessagesTokenCount([])).toBe(0)
  })
})
