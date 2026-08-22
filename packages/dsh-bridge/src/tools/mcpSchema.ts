/**
 * MCP raw JSON Schema → dsh-tools ParameterSchemaSpec 转换。
 *
 * 背景:
 *   - MCP 服务器的 `inputSchema` 是标准 JSON Schema(顶层 type:'object' +
 *     properties + required[]),任意节点形态任意。
 *   - `@deepseek-ai/dsh-tools` 的 `defineTool({ parameters })` 期望
 *     parameters 是 flat property map (`Record<paramName, ValueSchemaSpec>`),
 *     不是 JSON Schema。直接把 MCP inputSchema 透传会在
 *     `parameterSchemaSpecToJsonSchema` 报
 *     `parameters.type must be a value schema object`(它把顶层 'type'
 *     当作参数名,value 不是 value schema)。
 *
 * 转换规则:
 *   - 顶层把 `properties` 抽出当 property map;`required[]` 转成
 *     每个被列名 property 上的 `required: true` 标注。
 *   - 节点不支持的 MCP 形态(`anyOf`/`$ref`/`allOf`/缺 type 等)→ fallback
 *     到 `{ type: 'json' }`,接受任意 lossless JSON,确保工具可注册。
 *   - object 节点的 `additionalProperties` 必须显式 bool(MCP 常缺省)→
 *     缺省填 `false`。
 *   - 保留 annotations(`description`/`title`/`default`/`examples`)。
 *   - 数组 items 递归;空 array 节点的 items 不在 MCP spec 中给出,
 *     dsh-tools 允许 items 省略 → 不强制塞 json fallback,保留语义。
 */

import type {
  ParameterSchemaSpec,
  ParameterPropertySpec,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

const SCALAR_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])

/**
 * 把 MCP 服务器给的原始 inputSchema 转成 dsh-tools 的 flat property map。
 * 接受任意 unknown 输入;非对象/无 properties 都安全退化为空 map。
 */
export function mcpInputSchemaToParameterSpec(
  inputSchema: unknown,
): ParameterSchemaSpec {
  if (!inputSchema || typeof inputSchema !== 'object') return {}
  const root = inputSchema as Record<string, unknown>
  const rawProps = root.properties
  if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) {
    return {}
  }
  const requiredField = Array.isArray(root.required)
    ? root.required.filter((v): v is string => typeof v === 'string')
    : []
  const requiredSet = new Set(requiredField)

  const out: Record<string, ParameterPropertySpec> = {}
  for (const [name, value] of Object.entries(rawProps)) {
    if (!value || typeof value !== 'object') continue
    const spec = convertMcpValueSchema(value as Record<string, unknown>)
    if (requiredSet.has(name)) {
      ;(spec as ParameterPropertySpec).required = true
    }
    out[name] = spec as ParameterPropertySpec
  }
  return out as ParameterSchemaSpec
}

/**
 * 把一个 MCP 节点(任意 JSON Schema fragment)规范化为
 * dsh-tools 合规 ValueSchemaSpec。不支持的形态 fallback 为
 * `{ type: 'json' }`,配合 description 注解保留最少提示信息。
 */
export function convertMcpValueSchema(node: unknown): ValueSchemaSpec {
  if (!node || typeof node !== 'object') {
    return { type: 'json' }
  }
  const n = node as Record<string, unknown>

  // 拷贝 shared annotations(description/title/default/examples);
  // 若 dsh-tools 不认的 default(非 JSON lossless)会被底层校验拒。
  const annotations: Record<string, unknown> = {}
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (Object.hasOwn(n, key)) annotations[key] = n[key]
  }

  // oneOf 翻译(>=2 个分支才合法;否则退化)
  if (Array.isArray(n.oneOf) && n.oneOf.length >= 2) {
    const branches = n.oneOf.map((b) =>
      b && typeof b === 'object'
        ? convertMcpValueSchema(b as Record<string, unknown>)
        : ({ type: 'json' } as ValueSchemaSpec),
    )
    return { oneOf: branches as never, ...annotations } as never
  }

  const rawType = n.type
  if (typeof rawType === 'string') {
    if (SCALAR_TYPES.has(rawType)) {
      const scalar: Record<string, unknown> = { type: rawType, ...annotations }
      if (Array.isArray(n.enum)) scalar.enum = n.enum
      if (Object.hasOwn(n, 'const')) scalar.const = n.const
      return scalar as never
    }
    if (rawType === 'array') {
      const arr: Record<string, unknown> = { type: 'array', ...annotations }
      if (n.items && typeof n.items === 'object') {
        arr.items = convertMcpValueSchema(n.items as Record<string, unknown>)
      }
      return arr as never
    }
    if (rawType === 'object') {
      const obj: Record<string, unknown> = {
        type: 'object',
        // 强制 explicit boolean(MCP 常缺省;缺失 dsh-tools 拒)
        additionalProperties:
          typeof n.additionalProperties === 'boolean'
            ? n.additionalProperties
            : false,
        ...annotations,
      }
      const props = n.properties
      if (props && typeof props === 'object' && !Array.isArray(props)) {
        const nested = mcpInputSchemaToParameterSpec({
          properties: props,
          required: n.required,
        })
        // mcpInputSchemaToParameterSpec 抹掉顶层 type/object/annotations;
        // 这里手工合并 annotations(确保 description 等保留)
        obj.properties = nested as never
      }
      return obj as never
    }
  }

  // rawType 不是合法 ValueSchemaSpec 用 type、或 anyOf/allOf/$ref 等
  // dsh-tools 不支持的关键字 → 安全 fallback 到 type:'json'
  return { type: 'json', ...annotations } as never
}
