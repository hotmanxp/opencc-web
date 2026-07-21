import { describe, it, expect } from 'vitest'
import { parseBashOutput } from '../../../src/web/src/components/toolRenderers/bashParser.js'

describe('parseBashOutput', () => {
  it('empty input yields empty segments', () => {
    expect(parseBashOutput('')).toEqual({ stdout: '', stderr: '', plain: '' })
  })
  it('extracts single stdout block', () => {
    expect(parseBashOutput('<stdout>hello</stdout>')).toEqual({
      stdout: 'hello',
      stderr: '',
      plain: '',
    })
  })
  it('extracts stdout and stderr together', () => {
    const out = parseBashOutput('<stdout>out</stdout><stderr>err</stderr>')
    expect(out.stdout).toBe('out')
    expect(out.stderr).toBe('err')
    expect(out.plain).toBe('')
  })
  it('preserves order: stdout first, then stderr', () => {
    const out = parseBashOutput('<stderr>err</stderr><stdout>out</stdout>')
    expect(out.stdout).toBe('out')
    expect(out.stderr).toBe('err')
  })
  it('puts unknown tags into plain', () => {
    const out = parseBashOutput(
      '<task_id>123</task_id>\n<status>running</status>',
    )
    expect(out.stdout).toBe('')
    expect(out.stderr).toBe('')
    expect(out.plain).toBe('<task_id>123</task_id>\n<status>running</status>')
  })
  it('keeps raw text without any tags', () => {
    const out = parseBashOutput('just text\nmore')
    expect(out.plain).toBe('just text\nmore')
  })
  it('trims whitespace around stdout/stderr bodies', () => {
    expect(parseBashOutput('<stdout>\n  hi  \n</stdout>')).toEqual({
      stdout: 'hi',
      stderr: '',
      plain: '',
    })
  })
  it('handles multiline stdout ([\s\S] non-greedy across newlines)', () => {
    expect(
      parseBashOutput('<stdout>line1\nline2</stdout>'),
    ).toEqual({ stdout: 'line1\nline2', stderr: '', plain: '' })
  })
})
