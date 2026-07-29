import { describe, it, expect } from 'bun:test'
import {
  StructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from './StructuredOutputTool.ts'

describe('StructuredOutputTool', () => {
  it('has the canonical tool name', () => {
    expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe('StructuredOutput')
    expect(StructuredOutputTool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME)
  })

  it('is read-only and concurrency-safe', () => {
    // The Tool interface declares isReadOnly / isConcurrencySafe as
    // functions of the tool input. We pass the base input shape; the
    // base tool has no bound schema yet, so data: unknown is fine.
    expect(StructuredOutputTool.isReadOnly({ data: {} })).toBe(true)
    expect(StructuredOutputTool.isConcurrencySafe({ data: {} })).toBe(true)
  })

  it('declares input as arbitrary JSON (data: unknown)', () => {
    // Schema should be defined (sync, not Promise, per src/Tool.ts).
    const schema = StructuredOutputTool.inputSchema
    expect(schema).toBeDefined()
  })

  it('returns validation error when call input does not match bound schema', async () => {
    // Simulate the tool having a bound schema (set by the caller)
    const toolWithSchema = StructuredOutputTool.withSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
    const result = await toolWithSchema.call(
      { data: { age: 5 } },
      {} as never,
      {} as never,
      {} as never,
    )
    expect(result.data).toEqual({
      ok: false,
      error: expect.stringMatching(/required property 'name'/),
    })
  })

  it('returns validated object when input matches bound schema', async () => {
    const toolWithSchema = StructuredOutputTool.withSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
    const result = await toolWithSchema.call(
      { data: { name: 'Ada' } },
      {} as never,
      {} as never,
      {} as never,
    )
    expect(result.data).toEqual({
      ok: true,
      value: { name: 'Ada' },
    })
  })

  it('parses JSON string when LLM emits data as JSON', async () => {
    const toolWithSchema = StructuredOutputTool.withSchema({
      type: 'object',
      properties: { type: { type: 'string' } },
      required: ['type'],
    })
    const result = await toolWithSchema.call(
      { data: '{"type":"python"}' },
      {} as never,
      {} as never,
      {} as never,
    )
    expect(result.data).toEqual({
      ok: true,
      value: { type: 'python' },
    })
  })

  it('wraps bare string into single-required-string-property schema', async () => {
    // Mirrors the MiniMax-M3 detect-type workflow: LLM emits
    // { data: "python" } (or sometimes ""), schema is
    // { type: { type: 'string' }, required: ['type'] }.
    const toolWithSchema = StructuredOutputTool.withSchema({
      type: 'object',
      properties: { type: { type: 'string' } },
      required: ['type'],
    })
    const result = await toolWithSchema.call(
      { data: 'python' },
      {} as never,
      {} as never,
      {} as never,
    )
    expect(result.data).toEqual({
      ok: true,
      value: { type: 'python' },
    })
  })

  it('does not wrap when schema has multiple required string properties', async () => {
    // Ambiguous — refuse to guess which property the string belongs to.
    const toolWithSchema = StructuredOutputTool.withSchema({
      type: 'object',
      properties: {
        type: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['type', 'name'],
    })
    const result = await toolWithSchema.call(
      { data: 'python' },
      {} as never,
      {} as never,
      {} as never,
    )
    expect(result.data).toEqual({
      ok: false,
      error: expect.any(String),
    })
  })
})
