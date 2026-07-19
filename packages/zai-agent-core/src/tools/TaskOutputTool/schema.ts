import { z } from 'zod'

/**
 * 与 opencc 上游 TaskOutputTool 对齐:接受 3 个旧参数名,通过 zod transform
 * 归一到 `task_id` / `timeout`。
 *
 *   - task_id  ←  bash_id (BashOutputTool 旧名)
 *               ←  agentId (AgentOutputTool 旧名)
 *   - timeout  ←  wait_up_to * 1000 (秒 → 毫秒)
 *
 * 默认 10 分钟:对齐 opencc 上游的 bg-agent 任务常见时长,也避免 LLM 在父 turn
 * 末尾只用 30s 短超时反复轮询。子 agent 完成后,父 session 也会通过
 * <task-notification> 自动收到结果,大多数场景根本不需要主动调 TaskOutput。
 */
export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().min(1).optional(),
    // Legacy: BashOutputTool used `bash_id`.
    bash_id: z.string().min(1).optional(),
    // Legacy: AgentOutputTool used `agentId`.
    agentId: z.string().min(1).optional(),
    block: z.boolean().optional().default(true),
    timeout: z.number().int().min(0).max(600000).optional(),
    // Legacy: AgentOutputTool / BashOutputTool used `wait_up_to` (seconds).
    wait_up_to: z.number().min(0).optional(),
    tailLines: z.number().int().min(1).max(10000).optional(),
  })
  .transform((raw) => {
    // Canonical task_id wins; fall back to legacy aliases.
    const task_id = raw.task_id ?? raw.bash_id ?? raw.agentId ?? ''
    // Canonical timeout wins; wait_up_to only fires as fallback when no explicit
    // timeout was provided. Default 600000 (10 min) when neither is present.
    // (zod `.default()` would pre-fill 600000 and mask the user's omission — we
    //  resolve the priority in the transform instead.)
    let timeout = 600000
    if (typeof raw.timeout === 'number') {
      timeout = raw.timeout
    } else if (typeof raw.wait_up_to === 'number') {
      timeout = raw.wait_up_to * 1000
    }
    return {
      task_id,
      block: raw.block ?? true,
      timeout,
      tailLines: raw.tailLines ?? 200,
    }
  })

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>