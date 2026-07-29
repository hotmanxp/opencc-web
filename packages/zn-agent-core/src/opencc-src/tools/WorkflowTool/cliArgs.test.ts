// src/tools/WorkflowTool/cliArgs.test.ts
import { describe, expect, it } from 'bun:test'
import { parseCliArgs } from './cliArgs.ts'

describe('parseCliArgs', () => {
  it('parses basic --key=value pairs', () => {
    expect(parseCliArgs('--name=ethan --word=hello')).toEqual({
      name: 'ethan',
      word: 'hello',
    })
  })

  it('parses boolean flags (no =)', () => {
    expect(parseCliArgs('--verbose')).toEqual({ verbose: true })
  })

  it('parses mixed flags and values', () => {
    expect(parseCliArgs('--name=ethan --verbose --word=hello')).toEqual({
      name: 'ethan',
      verbose: true,
      word: 'hello',
    })
  })

  it('parses double-quoted values with spaces', () => {
    expect(parseCliArgs('--desc="hello world"')).toEqual({
      desc: 'hello world',
    })
  })

  it('parses single-quoted values with spaces', () => {
    expect(parseCliArgs("--desc='hello world'")).toEqual({
      desc: 'hello world',
    })
  })

  it('returns {} for empty string', () => {
    expect(parseCliArgs('')).toEqual({})
  })

  it('returns {} for whitespace-only string', () => {
    expect(parseCliArgs('   ')).toEqual({})
  })

  it('returns {} for null/undefined', () => {
    expect(parseCliArgs(null)).toEqual({})
    expect(parseCliArgs(undefined)).toEqual({})
  })

  it('ignores tokens without -- prefix', () => {
    expect(parseCliArgs('/some/path --name=ethan')).toEqual({
      name: 'ethan',
    })
  })

  it('ignores single-dash tokens like -x', () => {
    expect(parseCliArgs('-x --name=ethan')).toEqual({
      name: 'ethan',
    })
  })

  it('last duplicate key wins', () => {
    expect(parseCliArgs('--name=ethan --name=bob')).toEqual({
      name: 'bob',
    })
  })

  it('boolean then string overrides: --flag --flag=value', () => {
    expect(parseCliArgs('--flag --flag=value')).toEqual({
      flag: 'value',
    })
  })

  it('handles keys with hyphens and underscores', () => {
    expect(parseCliArgs('--my-key=foo --my_key=bar')).toEqual({
      'my-key': 'foo',
      my_key: 'bar',
    })
  })

  it('handles keys starting with underscore', () => {
    expect(parseCliArgs('--_internal=value')).toEqual({
      _internal: 'value',
    })
  })

  it('preserves empty value: --key=', () => {
    expect(parseCliArgs('--key=')).toEqual({ key: '' })
  })

  it('handles path-like values with = and /', () => {
    expect(parseCliArgs('--dir=/Users/foo/bar --url=https://x.com/a?b=c')).toEqual({
      dir: '/Users/foo/bar',
      url: 'https://x.com/a?b=c',
    })
  })

  it('handles escaped quotes inside double-quoted value', () => {
    expect(parseCliArgs('--msg="say \\"hi\\""')).toEqual({
      msg: 'say "hi"',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseCliArgs('  --name=ethan  ')).toEqual({ name: 'ethan' })
  })

  // Contract-locking tests (per opencc review 2026-06-22). These pin the
  // current behavior so a future refactor doesn't silently change it.

  it('--no-foo prefix becomes a regular key (not negation)', () => {
    // Many CLI tools interpret `--no-foo` as `{foo: false}`. The opencc
    // parser does NOT — it produces the literal key. Document the gap
    // explicitly so callers know to use a different convention (e.g.
    // `--foo=false`).
    expect(parseCliArgs('--no-foo')).toEqual({ 'no-foo': true })
  })

  it('preserves = inside an unquoted bare value', () => {
    // Greedy match — the regex consumes `val=with=more` as one value,
    // not splitting at subsequent `=`. Common for URLs / query strings.
    expect(parseCliArgs('--query=name=ethan&type=user')).toEqual({
      query: 'name=ethan&type=user',
    })
  })

  it('rejects Unicode keys (ASCII-only contract)', () => {
    // `[a-zA-Z_]` does not match Unicode. Documented out-of-scope; if
    // Unicode support is ever needed, widen the key class.
    expect(parseCliArgs('--名前=ethan')).toEqual({})
  })

  it('handles = immediately followed by quote', () => {
    expect(parseCliArgs('--key="value with spaces"')).toEqual({
      key: 'value with spaces',
    })
  })
})