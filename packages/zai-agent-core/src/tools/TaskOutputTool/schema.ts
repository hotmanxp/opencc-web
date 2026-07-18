import { z } from 'zod'

/**
 * task_id = Agent 后台派发时返回的 shortId。
 * block:是否阻塞等待(默认 true);timeout:最长等多久(默认 600000ms = 10 分钟,最大 600000ms)。
 *
 * 默认 10 分钟:对齐 opencc 上游的 bg-agent 任务常见时长,也避免 LLM 在父 turn
 * 末尾只用 30s 短超时反复轮询。子 agent 完成后,父 session 也会通过
 * <task-notification> 自动收到结果,大多数场景根本不需要主动调 TaskOutput。
 */
export const TaskOutputInputSchema = z.object({
  task_id: z.string().min(1),
  block: z.boolean().optional().default(true),
  timeout: z.number().int().min(0).max(600000).optional().default(600000),
  tailLines: z.number().int().min(1).max(10000).optional().default(200),
})

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>