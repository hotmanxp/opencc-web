import { describe, expect, test } from 'vitest'
import {
  parseArguments,
  parseArgumentNames,
  substituteArguments,
  substituteArgumentsLegacy,
} from '../../src/runtime/skills/substitute.js'

describe('substituteArguments (opencc-faithful, 0-indexed $N)', () => {
  test('$ARGUMENTS 替换为整个 args', () => {
    expect(substituteArguments('hello $ARGUMENTS', 'world foo')).toBe(
      'hello world foo',
    )
  })

  test('$0 $1 $ARGUMENTS[N] 位置替换', () => {
    expect(substituteArguments('a=$0 b=$1', 'foo bar')).toBe('a=foo b=bar')
    expect(substituteArguments('a=$ARGUMENTS[0] b=$ARGUMENTS[1]', 'foo bar')).toBe(
      'a=foo b=bar',
    )
  })

  test('quoted args：双引号 / 单引号内的空白保留为同一 token', () => {
    // quoted = true here just means "use shell-quote tokenizer"
    expect(substituteArguments('a=$0', 'foo bar', true)).toBe('a=foo')
    // double-quoted whitespace stays inside one token
    expect(substituteArguments('a=$0', '"foo bar"', true)).toBe('a=foo bar')
    // single-quoted whitespace stays inside one token
    expect(substituteArguments('a=$0', "'foo bar'", true)).toBe('a=foo bar')
  })

  test('declared argNames: $NAME 整体替换', () => {
    // The argName at position N replaces with parsedArgs[N]. opencc's spec is
    // "argumentNames[i] -> parsedArgs[i]". Since args has 1 token ('hello'),
    // only argNames[0] resolves to non-empty; argNames[1] falls back to ''.
    expect(substituteArguments('msg=$A end', 'hello', true, ['A'])).toBe(
      'msg=hello end',
    )
  })

  test('declared argNames: 多 argNames → 取每个位置', () => {
    expect(
      substituteArguments('a=$A b=$B', 'foo bar', true, ['A', 'B']),
    ).toBe('a=foo b=bar')
  })

  test('appendIfNoPlaceholder=false: 无占位符时原样返回', () => {
    expect(substituteArguments('plain text', 'foo', false)).toBe('plain text')
  })

  test('appendIfNoPlaceholder=true (default): 无占位符时追加 ARGUMENTS', () => {
    expect(substituteArguments('plain text', 'foo')).toBe('plain text\n\nARGUMENTS: foo')
  })

  test('args=undefined: 不替换任何占位符', () => {
    expect(substituteArguments('a=$0 b=$1', undefined)).toBe('a=$0 b=$1')
  })

  test('$NAME 含正则元字符：escapeRegExp 保护', () => {
    // Unbalanced parens in the name would throw on /unbalanced (/; escapeRegExp
    // turns the regex chars into literals so the lookup stays safe.
    expect(
      substituteArguments('a=$FOO(BAR) end', 'x', true, ['FOO(BAR)']),
    ).toBe('a=x end')
    // Partial-match guard: $FOOBAR should NOT be replaced when name is "FOO"
    expect(
      substituteArguments('$FOO $FOOBAR', 'x', true, ['FOO']),
    ).toBe('x $FOOBAR')
  })
})

describe('substituteArgumentsLegacy (back-compat 1-indexed $N)', () => {
  // These tests preserve the original zai SkillTool contract: $1 means the
  // first arg, $2 means the second. New code should use substituteArguments()
  // directly (0-indexed) but the legacy wrapper remains for the existing
  // SkillTool body until that gets ported.
  test('$1 $2 位置替换 (1-indexed)', () => {
    expect(substituteArgumentsLegacy('a=$1 b=$2', 'foo bar', true)).toBe(
      'a=foo b=bar',
    )
  })

  test('quoted 模式：参数按 shell 风格 quoted', () => {
    expect(substituteArgumentsLegacy('a=$1', 'foo bar', true)).toBe('a=foo')
    expect(substituteArgumentsLegacy('a=$1', 'foo bar', false)).toBe('a=foo')
  })

  test('declared argNames: $NAME 整体替换', () => {
    expect(
      substituteArgumentsLegacy('msg=$MSG end', 'hello world', true, ['MSG']),
    ).toBe('msg=hello world end')
  })

  test('无占位符时原样返回 (legacy)', () => {
    // Legacy has no appendIfNoPlaceholder — original behavior is to return
    // content untouched when no placeholder is found.
    expect(substituteArgumentsLegacy('plain text', 'foo', true)).toBe('plain text')
  })

  test('$@ 等价于 $ARGUMENTS', () => {
    expect(substituteArgumentsLegacy('cmd $@', 'a b c', true)).toBe('cmd a b c')
  })
})

describe('parseArguments', () => {
  test('plain whitespace split', () => {
    expect(parseArguments('foo bar baz')).toEqual(['foo', 'bar', 'baz'])
  })

  test('double-quoted whitespace preserved', () => {
    expect(parseArguments('foo "bar baz" qux')).toEqual([
      'foo',
      'bar baz',
      'qux',
    ])
  })

  test('single-quoted whitespace preserved', () => {
    expect(parseArguments("foo 'bar baz' qux")).toEqual([
      'foo',
      'bar baz',
      'qux',
    ])
  })

  test('backslash escapes next char', () => {
    expect(parseArguments('foo\\ bar')).toEqual(['foo bar'])
  })

  test('empty / whitespace-only', () => {
    expect(parseArguments('')).toEqual([])
    expect(parseArguments('   ')).toEqual([])
  })

  test('unterminated quote returns what we have', () => {
    expect(parseArguments('"foo bar')).toEqual(['foo bar'])
  })
})

describe('parseArgumentNames', () => {
  test('string form: space-separated', () => {
    expect(parseArgumentNames('foo bar baz')).toEqual(['foo', 'bar', 'baz'])
  })

  test('array form', () => {
    expect(parseArgumentNames(['foo', 'bar'])).toEqual(['foo', 'bar'])
  })

  test('numeric-only names filtered (would collide with $0, $1)', () => {
    expect(parseArgumentNames(['foo', '1', 'bar'])).toEqual(['foo', 'bar'])
  })

  test('empty / undefined', () => {
    expect(parseArgumentNames(undefined)).toEqual([])
    expect(parseArgumentNames('')).toEqual([])
    expect(parseArgumentNames([])).toEqual([])
  })
})