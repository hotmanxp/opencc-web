import type React from 'react'
import { z } from 'zod/v4'
import type { Tool, ToolResult } from '../../Tool.ts'
import { validateStructuredOutput } from './schemaValidator.ts'

export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'

// The base tool's input schema is intentionally permissive — the
// runtime binds a JSON Schema on a per-call basis (via .withSchema)
// before exposing this tool to a subagent. This matches upstream
// claude-code's design: a single tool type that accepts arbitrary
// JSON, but is configured with a schema before use.
const baseInputSchema = z.object({
  data: z.unknown(),
})

type StructuredOutputInput = z.infer<typeof baseInputSchema>

// Matches upstream's "use this tool to emit your final structured
// answer" copy. The runtime wires the bound schema into both the
// per-call tool description (so the LLM sees a precise contract)
// and the validation path (so the returned data is JSON-Schema
// validated before the LLM sees it as a tool_result).
const STRUCTURED_OUTPUT_PROMPT =
  'Use this tool to emit your final structured answer. ' +
  'Call it exactly once with a `data` field whose value matches the requested schema. ' +
  'Do not write the answer as text — call this tool instead.'

/**
 * The base tool. Its `.call` is intentionally throwing — the runtime
 * must always reach this tool via `.withSchema(...)` so that a JSON
 * Schema is bound. The base export exists primarily for typing and
 * registration-name discovery; an accidental direct use (e.g. someone
 * adds `StructuredOutputTool` to a tool list without calling
 * `.withSchema()`) will surface as a clear "no bound schema" error
 * rather than silently passing arbitrary data through.
 */
const baseTool = {
  name: STRUCTURED_OUTPUT_TOOL_NAME,
  inputSchema: baseInputSchema,
  isReadOnly: (_input: StructuredOutputInput) => true,
  isConcurrencySafe: (_input: StructuredOutputInput) => true,

  async prompt(): Promise<string> {
    return STRUCTURED_OUTPUT_PROMPT
  },

  async description(): Promise<string> {
    return 'Emit structured output matching the configured JSON Schema.'
  },

  userFacingName(): string {
    return 'Structured Output'
  },

  // The Tool interface requires this (see src/Tool.ts:622). Returns
  // a one-line label for the chat-trail rendering.
  renderToolUseMessage(_input: Partial<StructuredOutputInput>): React.ReactNode {
    return 'Emit structured output'
  },

  // The Tool interface requires this (see src/Tool.ts:517). The base
  // tool is always invoked via a subagent that has already had the
  // bound schema approved upstream, so we just allow.
  async checkPermissions(input: StructuredOutputInput): Promise<{
    behavior: 'allow'
    updatedInput: StructuredOutputInput
  }> {
    return { behavior: 'allow', updatedInput: input }
  },

  mapToolResultToToolResultBlockParam(output: unknown, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output),
    }
  },

  async call({ data: _data }: StructuredOutputInput): Promise<ToolResult<unknown>> {
    // The base tool has no schema bound — it must be created via
    // .withSchema(). If a caller reaches the base, treat it as a
    // configuration error (matches upstream's "schema missing" path).
    throw new Error(
      'StructuredOutputTool called without a bound schema. ' +
        'Use StructuredOutputTool.withSchema(...) when registering this tool.',
    )
  },
} as unknown as Tool

/**
 * Build a configured StructuredOutputTool bound to a specific JSON
 * Schema. Each subagent invocation that uses agent({schema}) creates
 * one of these and registers it into the subagent's tool pool with
 * a unique tool name (e.g. "StructuredOutput_<agentId>") so the
 * subagent LLM is told "call this specific tool with this schema".
 */
/**
 * Coerce an LLM-emitted `data` field into the shape the schema expects.
 *
 * Some LLM providers (notably MiniMax-M3 in observed workflows) emit
 * `data` as a string — either a JSON string like `'{"type":"python"}'`
 * or a bare value like `'python'`. The base tool's input is
 * `data: z.unknown()`, so the string reaches us verbatim and zod's
 * object-shape validation rejects it before any field-level check
 * runs.
 *
 * Coercion order:
 *   1. Non-string → return as-is.
 *   2. JSON-parseable string → return the parsed value.
 *   3. Plain string + schema is `{type:'object'}` with exactly one
 *      required string property → wrap as `{<prop>: data}`. This is
 *      the common "single-discriminator" shape used by detect-type /
 *      read-version prompts.
 *   4. Otherwise → return the original string; the downstream
 *      validator will produce a precise error rather than silently
 *      accepting malformed input.
 */
function coerceStringInput(
  data: unknown,
  schema: Record<string, unknown>,
): unknown {
  if (typeof data !== 'string') return data
  const trimmed = data.trim()
  if (trimmed !== '') {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not JSON — fall through to schema-based coercion
    }
  }
  const props = (schema as { properties?: Record<string, unknown> }).properties
  const required = (schema as { required?: unknown }).required
  if (
    (schema as { type?: string }).type === 'object' &&
    props &&
    Array.isArray(required)
  ) {
    const stringReqs = required.filter((prop): prop is string => {
      if (typeof prop !== 'string') return false
      const propSchema = props[prop] as { type?: string } | undefined
      return propSchema?.type === 'string'
    })
    if (stringReqs.length === 1) {
      return { [stringReqs[0]]: data }
    }
  }
  return data
}

export const StructuredOutputTool = {
  ...baseTool,

  withSchema(schema: Record<string, unknown>) {
    const toolName = `${STRUCTURED_OUTPUT_TOOL_NAME}_${Math.random().toString(36).slice(2, 10)}`
    const bound: Tool = {
      ...baseTool,
      name: toolName,
      async call(
        input: StructuredOutputInput,
      ): Promise<ToolResult<unknown>> {
        const coerced = coerceStringInput(input.data, schema)
        const result = validateStructuredOutput(schema, coerced)
        return { data: result }
      },
    }
    return bound
  },
}
