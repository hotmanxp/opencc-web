/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same ZodTypeAny reference per session, so we can cache by identity.
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * Converts a Zod v4 schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  // `unrepresentable: 'any'` 是兜底:碰到 `.transform()` 这种 JSON Schema
  // 表达不出的节点时退化成 `{}`,**不再抛 "Transforms cannot be
  // represented in JSON Schema"**。原来没传这个选项会让任何 tool 的
  // inputSchema 一旦带 transform(典型如 AgentTool 的 model 字段)就让整轮
  // API 调用挂掉 —— 见 utils/api.ts:208 toolToAPISchema 对每个 tool 每次
  // LLM 调用都跑一次。
  //
  // 与 utils/settings/schemaOutput.ts:6 的策略保持一致;那里也是用同一招
  // 防住 settings JSON Schema 生成时不抛。
  const result = toJSONSchema(schema, { unrepresentable: 'any' }) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
