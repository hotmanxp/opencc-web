import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { renderPrompt, FILE_WRITE_TOOL_NAME } from '../../../src/tools/FileWriteTool/prompt.js'
import { FileWriteInputSchema } from '../../../src/tools/FileWriteTool/schema.js'

describe('FileWriteTool prompt', () => {
  it('is named "Write"', () => {
    expect(FILE_WRITE_TOOL_NAME).toBe('Write')
  })

  it('mentions both required parameter names so the model knows the JSON keys', () => {
    // Regression: previously the prompt only described behavior, never
    // enumerated `file_path` / `content`. Combined with a JSON Schema that
    // dropped `required`, the model emitted `{}` and zod rejected it.
    // Both names must appear verbatim in the description.
    const prompt = renderPrompt()
    expect(prompt).toMatch(/file_path/)
    expect(prompt).toMatch(/content/)
    expect(prompt).toMatch(/both required/i)
  })

  it('includes a JSON example with the right keys', () => {
    const prompt = renderPrompt()
    expect(prompt).toMatch(/"file_path"/)
    expect(prompt).toMatch(/"content"/)
  })
})

describe('FileWriteTool schema', () => {
  it('rejects missing file_path with the same error shape the model was hitting', () => {
    // Reproduces the user-reported failure mode:
    //   [{ code: 'invalid_type', expected: 'string', received: 'undefined',
    //      path: ['file_path'], message: 'Required' }]
    expect(() => FileWriteInputSchema.parse({ content: 'x' })).toThrow(
      /file_path/,
    )
    expect(() => FileWriteInputSchema.parse({ file_path: '/x' })).toThrow(
      /content/,
    )
    expect(() => FileWriteInputSchema.parse({})).toThrow()
  })

  it('accepts well-formed input', () => {
    const out = FileWriteInputSchema.parse({
      file_path: '/abs/path/to/foo.ts',
      content: 'export const x = 1\n',
    })
    expect(out.file_path).toBe('/abs/path/to/foo.ts')
    expect(out.content).toBe('export const x = 1\n')
  })

  it('serialized JSON schema declares both fields as required (production converter)', () => {
    // This is the converter used at runtime by packages/zai/src/server/services/modelCaller.ts
    // (`zod-to-json-schema` package with target:'jsonSchema7'). If a future
    // change to FileWriteInputSchema or the converter silently drops `required`,
    // the model would receive an "all fields optional" schema and start calling
    // Write with `{}` again. Pin the behavior here.
    const json = zodToJsonSchema(FileWriteInputSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as {
      type: string
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(json.type).toBe('object')
    expect(json.properties).toBeDefined()
    expect(json.required).toEqual(
      expect.arrayContaining(['file_path', 'content']),
    )
  })

  it('z.strictObject production schemas keep `required` after conversion (regression guard)', () => {
    // Generic guard for the same class of bug. zod-to-json-schema has
    // historically emitted `required: []` for z.strictObject when the
    // schema is wrapped or extended — locking in the behavior for a known
    // shape protects every strictObject-based tool (Write, Glob, Grep,
    // AskUserQuestion, ...).
    const schema = z.strictObject({
      foo: z.string().describe('foo arg'),
      bar: z.number().describe('bar arg'),
    })
    const json = zodToJsonSchema(schema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as { required?: string[] }
    expect(json.required).toEqual(expect.arrayContaining(['foo', 'bar']))
  })
})

