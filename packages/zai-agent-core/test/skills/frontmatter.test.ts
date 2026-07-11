import { describe, expect, test } from 'vitest'
import { parseSkillFrontmatter } from '../../src/runtime/skills/frontmatter.js'

describe('parseSkillFrontmatter', () => {
  test('空文件 → 空 frontmatter + 全文 body', () => {
    const { frontmatter, body } = parseSkillFrontmatter('')
    expect(frontmatter).toEqual({})
    expect(body).toBe('')
  })

  test('无 frontmatter 分隔符 → 空 frontmatter + 全文 body', () => {
    const { frontmatter, body } = parseSkillFrontmatter('# hello\nworld')
    expect(frontmatter).toEqual({})
    expect(body).toBe('# hello\nworld')
  })

  test('基本标量字段', () => {
    const raw = `---
description: A test skill
when_to_use: When testing
version: 1.0.0
---
body content`
    const { frontmatter, body } = parseSkillFrontmatter(raw)
    expect(frontmatter.description).toBe('A test skill')
    expect(frontmatter.when_to_use).toBe('When testing')
    expect(frontmatter.version).toBe('1.0.0')
    expect(body).toBe('body content')
  })

  test('列表字段', () => {
    const raw = `---
arguments:
  - first
  - second
  - third
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter.arguments).toEqual(['first', 'second', 'third'])
  })

  test('带引号的字符串保留空格', () => {
    const raw = `---
name: 'hello world'
description: "double quoted"
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter.name).toBe('hello world')
    expect(frontmatter.description).toBe('double quoted')
  })

  test('布尔字段', () => {
    const raw = `---
disable-model-invocation: true
user-invocable: false
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter['disable-model-invocation']).toBe(true)
    expect(frontmatter['user-invocable']).toBe(false)
  })

  test('缺失闭合 --- → frontmatter 空 + body 为全文', () => {
    const { frontmatter, body } = parseSkillFrontmatter('---\nkey: value\nbody', 'test.md')
    expect(frontmatter).toEqual({})
    expect(body).toBe('---\nkey: value\nbody')
  })

  test('frontmatter 内部语法错误 → 抛错', () => {
    // leading "-" on a non-list line is not a valid key:value; triggers parser throw
    expect(() => parseSkillFrontmatter('---\n-invalid: not a key\n---\nbody', 'test.md'))
      .toThrow(/frontmatter|line/i)
  })

  test('未声明字段保留原始值', () => {
    const raw = `---
description: test
custom-field: hello
---
body`
    const { frontmatter } = parseSkillFrontmatter(raw)
    expect(frontmatter['custom-field']).toBe('hello')
  })

  test('body 保留换行与缩进', () => {
    const raw = `---
description: x
---
line1
  indented
line2`
    const { body } = parseSkillFrontmatter(raw)
    expect(body).toBe('line1\n  indented\nline2')
  })
})
