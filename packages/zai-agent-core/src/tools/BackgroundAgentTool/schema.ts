import { z } from 'zod'

/**
 * 暴露给 LLM 的 input schema。
 * 与 opencc 的 BackgroundAgentTool 对齐:prompt/cwd/agent/label。
 */
export const BackgroundAgentInputSchema = z.object({
  prompt: z.string().min(1, 'prompt 不能为空'),
  cwd: z.string().optional(),
  agent: z.string().optional(),
  label: z.string().optional(),
})

export type BackgroundAgentInput = z.infer<typeof BackgroundAgentInputSchema>