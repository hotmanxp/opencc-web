import Ajv, { type ValidateFunction } from 'ajv'

const ajv = new Ajv({
  allErrors: true,
  removeAdditional: 'all', // strip extras regardless of additionalProperties setting; matches upstream behavior
  useDefaults: true,
  strict: false,
})

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

export function validateStructuredOutput(
  schema: Record<string, unknown>,
  input: unknown,
): ValidationResult {
  let validate: ValidateFunction
  try {
    validate = ajv.compile(schema)
  } catch (e) {
    throw new Error(
      `Invalid JSON Schema: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  // Clone input because ajv mutates on strip
  const data = typeof input === 'object' && input !== null
    ? structuredClone(input)
    : input
  if (!validate(data)) {
    const messages = (validate.errors ?? []).map(err => {
      const path = err.instancePath || '(root)'
      return `${path} ${err.message}`
    })
    return { ok: false, error: messages.join('; ') }
  }
  return { ok: true, value: data as Record<string, unknown> }
}
