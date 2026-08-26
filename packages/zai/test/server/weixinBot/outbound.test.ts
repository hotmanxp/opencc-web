import { describe, it, expect } from 'vitest'
import { splitText } from '../../../src/server/services/weixinBot/outbound.js'

describe('splitText', () => {
  it('returns single chunk when under limit', () => {
    expect(splitText('hello', 100)).toEqual(['hello'])
  })

  it('splits long text at newlines', () => {
    const text = 'line1\nline2\nline3\nline4\nline5'
    const chunks = splitText(text, 12)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12)
  })

  it('preserves code fences across chunks', () => {
    const text = 'before\n```js\nconsole.log(1)\n```\nafter'
    const chunks = splitText(text, 15)
    // 至少 1 个 chunk 包含 ```js\nconsole.log(1)\n```
    const joined = chunks.join('\n')
    expect(joined).toContain('```js')
    expect(joined).toContain('```')
  })

  it('hard-splits single line exceeding limit', () => {
    const text = 'A'.repeat(50)
    const chunks = splitText(text, 10)
    expect(chunks.length).toBe(5)
    expect(chunks.every((c) => c.length <= 10)).toBe(true)
  })

  it('drops empty chunks', () => {
    const text = '\n\n\n\n'
    expect(splitText(text, 100)).toEqual([])
  })
})
