import { z } from 'zod'

/**
 * 与 opencc 上游 TaskStopTool 对齐:接受旧参数 `shell_id`
 * (deprecated KillShell 工具的兼容路径),通过 zod transform 归一到 `task_id`。
 */
export const TaskStopInputSchema = z
  .object({
    task_id: z.string().min(1).optional(),
    // shell_id is accepted for backward compatibility with the deprecated KillShell tool
    shell_id: z.string().min(1).optional(),
    reason: z.string().optional(),
  })
  .transform((raw) => ({
    // Canonical task_id wins; fall back to shell_id (KillShell legacy).
    task_id: raw.task_id ?? raw.shell_id ?? '',
    reason: raw.reason,
  }))

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>