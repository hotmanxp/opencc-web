import { describe, expect, test } from 'vitest'
import { substituteArguments } from '../../src/runtime/skills/substitute.js'

describe('substituteArguments', () => {
  test('$ARGUMENTS 替换为整个 args', () => {
    expect(substituteArguments('hello $ARGUMENTS', 'world foo', true))
      .toBe('hello world foo')
  })

  test('$1 $2 位置替换', () => {
    expect(substituteArguments('a=$1 b=$2', 'foo bar', true)).toBe('a=foo b=bar')
  })

  test('quoted 模式：参数按 shell 风格 quoted', () => {
    expect(substituteArguments('a=$1', 'foo bar', true)).toBe('a=foo')
    expect(substituteArguments('a=$1', 'foo bar', false)).toBe('a=foo')
  })

  test('declared argNames: $NAME 整体替换', () => {
    expect(substituteArguments('msg=$MSG end', 'hello world', true, ['MSG']))
      .toBe('msg=hello world end')
  })

  test('无占位符时原样返回', () => {
    expect(substituteArguments('plain text', 'foo', true)).toBe('plain text')
  })

  test('$@ 等价于 $ARGUMENTS', () => {
    expect(substituteArguments('cmd $@', 'a b c', true)).toBe('cmd a b c')
  })
})
