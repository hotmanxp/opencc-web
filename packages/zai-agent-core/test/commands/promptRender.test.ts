import { describe, expect, it } from 'vitest'
import { renderPrompt } from '../../src/commands/promptRender.js'

describe('renderPrompt', () => {
  it('replaces $ARGUMENTS', () => {
    expect(renderPrompt({ body: 'Say $ARGUMENTS to me', args: 'hello world' })).toBe('Say hello world to me')
  })

  it('replaces positional $1 $2', () => {
    expect(renderPrompt({ body: 'Hi $1, age $2', args: 'alice 30' })).toBe('Hi alice, age 30')
  })

  it('positional beyond args becomes empty string', () => {
    expect(renderPrompt({ body: 'a=$1 b=$2 c=$3', args: 'x y' })).toBe('a=x b=y c=')
  })

  it('replaces ${name} via argNames order', () => {
    expect(renderPrompt({ body: 'Hi ${name}', args: 'alice', argNames: ['name'] })).toBe('Hi alice')
  })

  it('keeps ${name} literal when name not in argNames', () => {
    expect(renderPrompt({ body: 'Hi ${unknown}', args: 'alice', argNames: ['name'] })).toBe('Hi ${unknown}')
  })

  it('empty args → all replacements empty', () => {
    expect(renderPrompt({ body: '$ARGUMENTS $1', args: '' })).toBe(' ')
  })

  it('handles $$ (escaped dollar) — not a spec requirement, but verify no crash', () => {
    expect(renderPrompt({ body: 'price is $$5', args: '' })).toBe('price is $$5')
  })
})