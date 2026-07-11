import { describe, it, expect } from 'vitest'
import { linkifySegments } from '../../src/web/src/lib/linkify.tsx'

describe('linkifySegments', () => {
  it('空字符串返回单 text 段', () => {
    expect(linkifySegments('')).toEqual([{ kind: 'text', value: '' }])
  })

  it('无 URL 文本原样返回', () => {
    expect(linkifySegments('hello world')).toEqual([
      { kind: 'text', value: 'hello world' },
    ])
  })

  it('单 URL 切分为 [text, link, text]', () => {
    const out = linkifySegments('看 https://example.com 这个')
    expect(out).toEqual([
      { kind: 'text', value: '看 ' },
      { kind: 'link', raw: 'https://example.com', href: 'https://example.com' },
      { kind: 'text', value: ' 这个' },
    ])
  })

  it('匹配 http 与 https', () => {
    const out = linkifySegments('http://a.com https://b.com')
    expect(out.filter((s) => s.kind === 'link').map((s) => (s as any).href)).toEqual([
      'http://a.com',
      'https://b.com',
    ])
  })

  it('多个 URL 顺序保持', () => {
    const out = linkifySegments('a https://x.com b https://y.com c')
    expect(out.filter((s) => s.kind === 'link').length).toBe(2)
  })

  it('剥离尾部标点 . , ; : ! ? )', () => {
    expect(linkifySegments('看 https://x.com.').filter((s) => s.kind === 'link')[0])
      .toEqual({ kind: 'link', raw: 'https://x.com.', href: 'https://x.com' })
    expect(linkifySegments('看 https://x.com).').filter((s) => s.kind === 'link')[0])
      .toEqual({ kind: 'link', raw: 'https://x.com', href: 'https://x.com' })
  })

  it('URL 在字符串开头/末尾正常工作', () => {
    expect(linkifySegments('https://start.com').map((s) => s.kind)).toEqual(['link'])
    expect(linkifySegments('end https://end.com').map((s) => s.kind)).toEqual([
      'text',
      'link',
    ])
  })

  it('括号内 URL 在首个 ) 处终止', () => {
    // 正则字符类排除 ),  所以 (foo) 形式的 URL 在 ( 处匹配, ) 处终止.
    // 期望: raw 包含开括号, href 不包含尾括号.
    const out = linkifySegments('wiki (https://en.wikipedia.org/wiki/Foo_(bar))').filter(
      (s) => s.kind === 'link',
    )
    expect((out[0] as any).href).not.toMatch(/\)$/)
  })

  it('不匹配 markdown 风格的 [label](url) 中的 url 部分被独立识别为 link', () => {
    // 设计上 linkifySegments 不知道 markdown 上下文, 内部 url 仍会被单独识别.
    // 这是预期行为 (QuestionCard / 流式文本 不走 markdown 解析).
    const out = linkifySegments('[点这里](https://x.com)')
    const links = out.filter((s) => s.kind === 'link')
    expect(links.length).toBe(1)
    expect((links[0] as any).href).toBe('https://x.com')
  })
})
