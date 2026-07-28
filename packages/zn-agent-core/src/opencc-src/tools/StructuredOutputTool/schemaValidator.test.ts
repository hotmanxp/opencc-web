import { describe, expect, it } from 'bun:test'
import { validateStructuredOutput } from './schemaValidator.js'

describe('validateStructuredOutput', () => {
  it('returns parsed object when input matches schema', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name', 'age'],
      additionalProperties: false,
    }
    const result = validateStructuredOutput(schema, { name: 'Ada', age: 36 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ name: 'Ada', age: 36 })
    }
  })

  it('returns error when input is missing required field', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }
    const result = validateStructuredOutput(schema, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/must have required property 'name'/)
    }
  })

  it('returns error when input type does not match', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' } } }
    const result = validateStructuredOutput(schema, { count: 'five' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/must be integer/)
    }
  })

  it('strips additional properties when additionalProperties:false', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    }
    const result = validateStructuredOutput(schema, { name: 'A', extra: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ name: 'A' })
    }
  })

  it('throws on invalid schema itself', () => {
    expect(() =>
      validateStructuredOutput({ type: 'not-a-real-type' } as never, {}),
    ).toThrow(/Invalid JSON Schema/)
  })
})
