import { describe, expect, it } from 'vitest'
import { renderPrompt } from '../../../src/compat/commands/promptRender.js'

describe('renderPrompt', () => {
  it('replaces $ARGUMENTS with the full args string', () => {
    expect(renderPrompt({ body: 'pnpm release:$ARGUMENTS', args: 'minor' })).toBe(
      'pnpm release:minor',
    )
  })

  it('uses 0-indexed positional shorthand (vendor parity: $0 = first token)', () => {
    const out = renderPrompt({ body: '$0 and $1', args: 'foo bar' })
    expect(out).toBe('foo and bar')
  })

  it('replaces missing positional tokens with empty string', () => {
    expect(renderPrompt({ body: 'x$2', args: 'a' })).toBe('x')
  })

  it('substitutes ${name} only when declared in argNames', () => {
    const body = '${version_type} vs ${other}'
    const out = renderPrompt({ body, args: 'patch extra', argNames: ['version_type'] })
    expect(out).toBe('patch vs ${other}')
  })

  it('leaves content unchanged when args is empty', () => {
    expect(renderPrompt({ body: 'Type: $ARGUMENTS', args: '' })).toBe('Type: ')
    expect(renderPrompt({ body: 'literal {version_type}', args: '' })).toBe(
      'literal {version_type}',
    )
  })

  it('treats $$ as an escaped dollar', () => {
    expect(renderPrompt({ body: '$$ARGUMENTS', args: 'x' })).toBe('$$ARGUMENTS')
  })
})
