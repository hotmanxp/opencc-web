import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { jsonSchemaToZod } from '../../src/mcp/jsonSchemaToZod.js'

describe('jsonSchemaToZod', () => {
  test('object with string and number', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' }, count: { type: 'number' } },
      required: ['name'],
    }) as z.ZodObject<any>
    expect(zod.safeParse({ name: 'x' }).success).toBe(true)
    expect(zod.safeParse({}).success).toBe(false)
    expect(zod.safeParse({ name: 'x', count: 'wrong' }).success).toBe(false)
  })

  test('array property', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    }) as z.ZodObject<any>
    expect(zod.safeParse({ tags: ['a', 'b'] }).success).toBe(true)
    expect(zod.safeParse({ tags: [1, 2] }).success).toBe(false)
  })

  test('malformed schema falls back to z.record(unknown)', () => {
    const zod = jsonSchemaToZod({ this: 'is-not-a-schema' })
    expect(zod.safeParse({ anything: 'goes' }).success).toBe(true)
  })

  test('null schema falls back to z.record(unknown)', () => {
    const zod = jsonSchemaToZod(null)
    expect(zod.safeParse({}).success).toBe(true)
  })
})
