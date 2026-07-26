import { describe, expect, it } from 'vitest'
import { serializeForCompact } from '../../../src/runtime/compact/serialize-for-compact.js'

function mkMsg(content: unknown, type: string = 'user'): any {
  return { type, message: { content }, cwd: '/', sessionId: 's', uuid: Math.random().toString() }
}

describe('serializeForCompact', () => {
  it('text → [role] text', () => {
    expect(serializeForCompact([mkMsg([{ type: 'text', text: 'hi' }], 'user')])).toBe('[user] hi')
  })

  it('thinking 丢弃', () => {
    const msg = mkMsg(
      [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }],
      'assistant',
    )
    const out = serializeForCompact([msg])
    expect(out).not.toContain('secret')
    expect(out).toContain('answer')
  })

  it('tool_use JSON 序列化', () => {
    const msg = mkMsg([{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }], 'assistant')
    const out = serializeForCompact([msg])
    expect(out).toContain('[tool_use: Bash]')
    expect(out).toContain('"cmd":"ls"')
  })

  it('tool_result 500B 截断', () => {
    const msg = mkMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(800), is_error: false }], 'user')
    const out = serializeForCompact([msg])
    expect(out).toContain('...(truncated)')
    expect(out).not.toContain('x'.repeat(600))
  })

  it('image 计数', () => {
    const msg = mkMsg(
      [
        { type: 'image', source: { media_type: 'image/png' } },
        { type: 'image', source: { media_type: 'image/jpeg' } },
      ],
      'user',
    )
    const out = serializeForCompact([msg])
    expect(out).toContain('[图片附件 1]')
    expect(out).toContain('[图片附件 2]')
  })

  it('空 messages 返回 ""', () => {
    expect(serializeForCompact([])).toBe('')
  })

  it('string content 直接 dump', () => {
    expect(serializeForCompact([mkMsg('hello', 'user')])).toBe('[user] hello')
  })
})
