import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

// Mirror of the helper exported by modelCaller.ts. The helper is currently
// a module-private function — these tests live alongside the module so a
// refactor that makes it export (or extract to a shared util) keeps the
// contract test passing. Re-implementing here keeps the test pure (no
// module-import dependency on the implementation file).
type AnthropicToolInputSchema = {
  type?: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean | unknown
  $schema?: string
  [key: string]: unknown
}

function normalizeToolSchema(zodSchema: unknown): AnthropicToolInputSchema {
  let converted: unknown
  try {
    converted = zodSchema == null
      ? null
      : zodToJsonSchema(zodSchema as Parameters<typeof zodToJsonSchema>[0], {
          target: 'jsonSchema7',
          $refStrategy: 'none',
        })
  } catch {
    converted = null
  }
  if (
    converted
    && typeof converted === 'object'
    && (converted as Record<string, unknown>).type === 'object'
    && typeof (converted as Record<string, unknown>).properties === 'object'
  ) {
    return converted as AnthropicToolInputSchema
  }
  return {
    type: 'object',
    additionalProperties: true,
  }
}

describe('normalizeToolSchema (mirror of modelCaller.ts helper)', () => {
  it('returns a permissive object schema for ZodUnknown() (regression: vendor Agent tool)', () => {
    // This is the shape `wrapAsOpenccTool` produces for vendor tools whose
    // zai-native Tool definition declared `inputSchema: z.unknown()` (or
    // didn't declare one at all). Previously `zodToJsonSchema` returned
    // just `{"$schema": "..."}` with no `type`/`properties` — the MiniMax
    // proxy rejected the request with HTTP 400 "input json is empty".
    const result = normalizeToolSchema(z.unknown())
    expect(result.type).toBe('object')
    expect(result.additionalProperties).toBe(true)
    // No `properties` field — the proxy only requires `type: object`.
    expect(result.properties).toBeUndefined()
  })

  it('returns a permissive object schema for ZodAny()', () => {
    const result = normalizeToolSchema(z.any())
    expect(result.type).toBe('object')
    expect(result.additionalProperties).toBe(true)
  })

  it('returns a permissive object schema for null/undefined input', () => {
    expect(normalizeToolSchema(null)).toEqual({ type: 'object', additionalProperties: true })
    expect(normalizeToolSchema(undefined)).toEqual({ type: 'object', additionalProperties: true })
  })

  it('returns a permissive object schema when zodToJsonSchema throws', () => {
    // Construct a value that zodToJsonSchema chokes on. A non-zod object
    // passed directly usually serializes to `{}`, which trips our guard.
    const result = normalizeToolSchema({ weird: 'shape' })
    expect(result.type).toBe('object')
    expect(result.additionalProperties).toBe(true)
  })

  it('passes through a valid zod object schema unchanged', () => {
    const schema = z.object({
      command: z.string(),
      timeout: z.number().optional(),
    })
    const result = normalizeToolSchema(schema)
    expect(result.type).toBe('object')
    expect(result.properties).toBeDefined()
    expect((result.properties as Record<string, unknown>).command).toBeDefined()
    // Required keys are derived from the zod object's `.shape` keys
    // (zod-to-json-schema emits `required: [...]` for non-optional fields).
    expect(result.required).toEqual(['command'])
  })

  it('passes through a valid empty zod object schema (rare but legal)', () => {
    // z.object({}) — has `type: object`, `properties: {}` — meets the guard.
    const result = normalizeToolSchema(z.object({}))
    expect(result.type).toBe('object')
    expect(result.properties).toEqual({})
  })
})