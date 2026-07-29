import { describe, expect, test } from 'bun:test'
import { assertResumeSafe } from './resumeSafety.ts'

describe('assertResumeSafe (port of upstream 2.1.170)', () => {
  test('accepts a clean script', () => {
    const script = `async function userScript(args) { return String(args) }`
    expect(() => assertResumeSafe(script)).not.toThrow()
  })

  test('rejects Date.now() with upstream error string', () => {
    const script = `const t = Date.now()\nasync function userScript() { return t }`
    expect(() => assertResumeSafe(script)).toThrow(
      'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
    )
  })

  test('rejects new Date() with upstream error string', () => {
    const script = `const d = new Date()\nasync function userScript() { return d.toISOString() }`
    expect(() => assertResumeSafe(script)).toThrow(
      'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
    )
  })

  test('rejects Math.random() with upstream error string', () => {
    const script = `const r = Math.random()\nasync function userScript() { return r }`
    expect(() => assertResumeSafe(script)).toThrow(
      'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.',
    )
  })

  test('ignores Date.now() inside a single-line comment', () => {
    const script = `// Date.now()\nasync function userScript() { return '' }`
    expect(() => assertResumeSafe(script)).not.toThrow()
  })

  test('ignores Date.now() inside a block comment', () => {
    const script = `/* Date.now() */\nasync function userScript() { return '' }`
    expect(() => assertResumeSafe(script)).not.toThrow()
  })

  test('ignores Date.now() inside a string literal', () => {
    const script = `const s = "Date.now()"\nasync function userScript() { return s }`
    expect(() => assertResumeSafe(script)).not.toThrow()
  })

  test('ignores Date.now() inside a template literal', () => {
    const script = 'const s = `Date.now()`\nasync function userScript() { return s }'
    expect(() => assertResumeSafe(script)).not.toThrow()
  })

  test('rejects Date.now() inside a template interpolation (Plan14 code review regression)', () => {
    const script = 'const s = `${Date.now()}`\nasync function userScript() { return s }'
    expect(() => assertResumeSafe(script)).toThrow(
      'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
    )
  })

  test('rejects new Date() inside a template interpolation', () => {
    const script = 'const s = `${new Date()}`\nasync function userScript() { return s }'
    expect(() => assertResumeSafe(script)).toThrow(
      'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
    )
  })

  test('rejects Math.random() inside a template interpolation', () => {
    const script = 'const s = `${Math.random()}`\nasync function userScript() { return s }'
    expect(() => assertResumeSafe(script)).toThrow(
      'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.',
    )
  })
})
