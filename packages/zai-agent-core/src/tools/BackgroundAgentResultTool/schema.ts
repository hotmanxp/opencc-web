import { z } from 'zod'

/**
 * 暴露给 LLM 的 input schema。
 * shortId:任务 ID;tailLines:返回最后 N 行(默认 200)。
 * waitMs:如果任务未完成,等待 N 毫秒后重读(默认 0,不等)。
 */
export const BackgroundAgentResultInputSchema = z.object({
  shortId: z.string().min(1, 'shortId 不能为空'),
  tailLines: z.number().int().min(1).max(10000).optional().default(200),
  waitMs: z.number().int().min(0).max(60000).optional().default(0),
})

export type BackgroundAgentResultInput = z.infer<typeof BackgroundAgentResultInputSchema>