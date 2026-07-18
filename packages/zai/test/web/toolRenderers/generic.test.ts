// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { genericRenderer } from '../../../src/web/src/components/toolRenderers/generic.js'
import React from 'react'

describe('genericRenderer', () => {
  it('preview returns first field value as string', () => {
    expect(genericRenderer.preview({ command: 'ls' })).toBe('ls')
  })
  it('preview stringifies non-string first value', () => {
    expect(genericRenderer.preview({ a: { b: 1 } })).toBe('{"b":1}')
  })
  it('preview is empty when no input keys', () => {
    expect(genericRenderer.preview({})).toBe('')
  })
  it('preview returns first key even when value is null', () => {
    expect(genericRenderer.preview({ a: null })).toBe('')
  })
  it('preview truncates long values at 80', () => {
    expect(genericRenderer.preview({ a: 'x'.repeat(120) })).toBe('x'.repeat(80) + '…')
  })
  it('displayName / renderInput / renderOutput are undefined (caller falls back)', () => {
    expect(genericRenderer.displayName).toBeUndefined()
    expect(genericRenderer.renderInput).toBeUndefined()
    expect(genericRenderer.renderOutput).toBeUndefined()
  })
  // quick smoke that there is a React Node shape if we ever hook one up
  it('returns an object, not a primitive', () => {
    expect(typeof genericRenderer).toBe('object')
    expect(React).toBeDefined()
  })
})
