import { z } from 'zod'

export const AgentInputSchema = z.object({
  prompt: z.string().min(1),
  subagent_type: z.string().min(1).default('general-purpose'),
  description: z.string().optional(),
  /**
   * 默认 true:Agent 工具默认走 BackgroundAgent.dispatch() 异步派发,
   * 立即返回 shortId。设为 false 才走原同步路径(阻塞等结果)。
   */
  run_in_background: z.boolean().optional().default(true),
})
