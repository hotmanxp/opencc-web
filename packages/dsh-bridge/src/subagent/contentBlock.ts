import { z } from 'zod'

/**
 * SubagentResult.output 元素 — vendor `@deepseek-ai/dsh-subagent/src/types.ts:219`
 * ContentBlock 类型的 zod 校验版。
 *
 * 与 zai `shared/subagentEvents.ts:SubagentContentBlockSchema` 同构(本文件
 * 早期定义,Task 1 是消费侧镜像)。
 */

export const SubagentContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }),
  }),
])
export type SubagentContentBlock = z.infer<typeof SubagentContentBlockSchema>

export function parseContentBlock(raw: unknown): SubagentContentBlock {
  const r = SubagentContentBlockSchema.safeParse(raw)
  if (!r.success) {
    console.warn(
      '[dsh-bridge] contentBlock parse failed:',
      r.error.issues,
      JSON.stringify(raw).slice(0, 200),
    )
    throw new Error(
      `[dsh-bridge] contentBlock parse failed: ${r.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  return r.data
}

export function parseContentBlocks(raw: unknown): SubagentContentBlock[] {
  if (!Array.isArray(raw)) {
    console.warn('[dsh-bridge] contentBlocks parse: not array, got', typeof raw)
    return []
  }
  const out: SubagentContentBlock[] = []
  for (const item of raw) {
    try {
      out.push(parseContentBlock(item))
    } catch {
      // 单个失败跳过(已 warn)
    }
  }
  return out
}
