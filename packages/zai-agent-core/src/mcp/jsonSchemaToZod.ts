import { z, type ZodTypeAny } from 'zod'

type JsonSchema = Record<string, unknown>

function primitive(type: string): ZodTypeAny {
  switch (type) {
    case 'string': return z.string()
    case 'number':
    case 'integer': return z.number()
    case 'boolean': return z.boolean()
    case 'null': return z.null()
    default: return z.unknown()
  }
}

function convert(schema: unknown, depth = 0): ZodTypeAny {
  if (depth > 10) return z.unknown()
  if (!schema || typeof schema !== 'object') return z.unknown()
  const s = schema as JsonSchema

  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>
    const shape: Record<string, ZodTypeAny> = {}
    for (const [k, v] of Object.entries(props)) {
      shape[k] = convert(v, depth + 1)
    }
    let obj = z.object(shape).passthrough()
    if (Array.isArray(s.required)) {
      const req = new Set(s.required as string[])
      for (const k of Object.keys(shape)) {
        if (!req.has(k)) shape[k] = shape[k].optional()
      }
      obj = z.object(shape).passthrough()
    }
    return obj
  }

  if (s.type === 'array') {
    return z.array(convert(s.items, depth + 1))
  }

  if (typeof s.type === 'string') return primitive(s.type)

  if (Array.isArray(s.enum)) {
    const literals = (s.enum as unknown[]).map((v) => z.literal(v as never)) as ZodTypeAny[]
    return z.union(literals as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]])
  }

  return z.unknown()
}

export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  try {
    return convert(schema)
  } catch {
    return z.record(z.string(), z.unknown())
  }
}
