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
    // zai patch (2026-10-16, wb-005): JSON Schema 规定 `required` 缺失 =
    // **全部属性可选**。此前只在 `required` 存在时才给非必填项加
    // `.optional()`,于是「没有 required」的 schema 全部属性都成了必填 ——
    // 而消费方 MCPToolAdapter 直接 safeParse,模型省略一个本该可选的参数
    // 就被判校验失败、工具调用被拒。
    //
    // 正确读法统一成一句:**只有列在 required 里的才是必填**。`required`
    // 缺失与 `required: []` 语义相同,两者都走同一条路径。
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
    for (const k of Object.keys(shape)) {
      if (!req.has(k)) shape[k] = shape[k].optional()
    }
    return z.object(shape).passthrough()
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