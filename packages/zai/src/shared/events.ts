import { z } from 'zod'

const Base = z.object({
  eventId: z.string(),
  ts: z.number(),
})

const RuntimeEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('runtime.started'),
             sessionId: z.string(), turnIndex: z.number() }),
  z.object({ ...Base.shape, type: z.literal('runtime.delta'),
             sessionId: z.string(), turnIndex: z.number(),
             delta: z.string() }),
  // 思考块的流式分片. 与 runtime.delta 平行通道 — UI 把 thinking 与
  // 文本独立折叠显示. 早期版本 thinking_delta 被 silently 丢弃, 只能从
  // transcript 刷新后看到, 流式过程看不到 — 这里加一条独立 spec event.
  z.object({ ...Base.shape, type: z.literal('runtime.thinking'),
             sessionId: z.string(), turnIndex: z.number(),
             thinking: z.string() }),
  // runtime.tool_call 必须带 toolUseId: server 在 content_block_stop / tool_use:start
  // 两个分支都填上游 block.id, 客户端不再合成. 这样 runtime.tool_result 用同一 id
  // upsert 能命中 start 条目, ToolCallBlock 才能从 "调用中" 切到 "已完成".
  z.object({ ...Base.shape, type: z.literal('runtime.tool_call'),
             sessionId: z.string(), turnIndex: z.number(),
             toolUseId: z.string(),
             toolName: z.string(), input: z.unknown() }),
  z.object({ ...Base.shape, type: z.literal('runtime.tool_result'),
             sessionId: z.string(), turnIndex: z.number(),
             toolUseId: z.string(), output: z.unknown() }),
  z.object({ ...Base.shape, type: z.literal('runtime.done'),
             sessionId: z.string(), turnIndex: z.number(),
             usage: z.object({ input: z.number(), output: z.number() }).optional() }),
  z.object({ ...Base.shape, type: z.literal('runtime.aborted'),
             sessionId: z.string(), turnIndex: z.number(),
             reason: z.string() }),
  // runtime.error 携带 toolUseId 时表示"这是某个具体工具的失败" (例如
  // tool_use:error/invalid/denied 翻译过来的), 前端应把对应 tool_use:start
  // upsert 成 tool_use:error 让 ToolCallBlock 从"调用中"切到"错误".
  // 没有 toolUseId 时是 turn-level / 引擎级别错误, 只 setStatus.
  z.object({ ...Base.shape, type: z.literal('runtime.error'),
             sessionId: z.string(), turnIndex: z.number(),
             error: z.object({ category: z.string(), message: z.string(),
                               recoverable: z.boolean() }),
             toolUseId: z.string().optional() }),
])

const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('session.created'),
             sessionId: z.string(), title: z.string(), cwd: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.deleted'),
             sessionId: z.string() }),
  z.object({ ...Base.shape, type: z.literal('session.renamed'),
             sessionId: z.string(), title: z.string() }),
])

const JobEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('job.started'),
             jobId: z.string(), kind: z.enum(['resource_refresh','login','install','agent_task']),
             taskId: z.string().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.progress'),
             jobId: z.string(), message: z.string(), percent: z.number().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.done'),
             jobId: z.string(), result: z.unknown().optional() }),
  z.object({ ...Base.shape, type: z.literal('job.failed'),
             jobId: z.string(), error: z.string() }),
])

const PromptEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('prompt.ask'),
             sessionId: z.string(), toolUseId: z.string(),
             questions: z.array(z.object({
               question: z.string(), header: z.string(),
               options: z.array(z.object({
                 label: z.string(), description: z.string().optional(),
               })),
             })) }),
])

const SystemEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('server.connected'),
             sessionId: z.string().nullable() }),
  z.object({ ...Base.shape, type: z.literal('server.error'),
             message: z.string() }),
  z.object({ ...Base.shape, type: z.literal('toast'),
             level: z.enum(['info','warn','error']), message: z.string() }),
])

export const ServerEvent = z.discriminatedUnion('type', [
  ...RuntimeEvent.options,
  ...SessionEvent.options,
  ...JobEvent.options,
  ...PromptEvent.options,
  ...SystemEvent.options,
])
export type ServerEvent = z.infer<typeof ServerEvent>
