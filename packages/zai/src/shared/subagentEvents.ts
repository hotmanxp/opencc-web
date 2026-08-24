import { z } from 'zod'

/**
 * DSH 轨 subagent/后台任务 全面对齐 vendor 事件 schema。
 *
 * 对应 vendor `@deepseek-ai/dsh-subagent` 事件:
 *   - subagent/start → subagent.start
 *   - subagent/end   → subagent.end
 *   - subagent/descriptor → subagent.descriptor
 *   - (continuation ActivationState) → subagent.state
 *   - 子 agent publish message → subagent.message
 *
 * 旧 `subagent.changed`(action='start'|'finish')已 deprecated,保留 shim 至 2026-09-30。
 * 详见 spec §4 事件 Schema 对齐。
 */

const Base = z.object({
  ts: z.number(),
  sessionId: z.string(),
  runId: z.string(),
})

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

export const SubagentStartEvent = Base.extend({
  type: z.literal('subagent.start'),
  provider: z.string(),
  id: z.string(),
  local: z.boolean(),
  parentSessionId: z.string().optional(),
})

export const SubagentStopReason = z.enum([
  'completed',
  'aborted',
  'error',
  'max-tokens',
  'refusal',
])

export const SubagentEndEvent = Base.extend({
  type: z.literal('subagent.end'),
  provider: z.string(),
  id: z.string(),
  local: z.boolean(),
  stopReason: SubagentStopReason,
  lastAssistantMessage: z.array(SubagentContentBlockSchema).optional(),
  output: z.array(SubagentContentBlockSchema).optional(),
  structured: z.unknown().optional(),
})

export const SubagentDescriptorEvent = Base.extend({
  type: z.literal('subagent.descriptor'),
  version: z.literal(2),
  mode: z.enum(['one-shot', 'continuable']),
  provider: z.string(),
  label: z.string().optional(),
  persona: z.string().optional(),
  toolFilter: z.array(z.string()).optional(),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
})

export const SubagentStateEvent = Base.extend({
  type: z.literal('subagent.state'),
  state: z.enum(['running', 'waiting', 'settled']),
})

export const SubagentMessageEvent = Base.extend({
  type: z.literal('subagent.message'),
  blocks: z.array(SubagentContentBlockSchema),
})

export const SubagentErrorEvent = Base.extend({
  type: z.literal('subagent.error'),
  message: z.string(),
  code: z.string().optional(),
})

export const SubagentEvent = z.discriminatedUnion('type', [
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
])
export type SubagentEventT = z.infer<typeof SubagentEvent>
