/**
 * BashTool input schema (对标 opencc `tools/BashTool/BashTool.tsx:230-269`)。
 *
 * 7 字段:
 *   - command (必填)
 *   - description (可选, 人类可读)
 *   - timeout (可选, max 600_000ms)
 *   - run_in_background (可选, 显式后台化)
 *   - dangerouslyDisableSandbox (可选, 用户级 sandbox 逃生)
 *   - _dangerouslyDisableSandboxApproved (可选, 内部 marker)
 *   - _simulatedSedEdit (可选, sed 预演)
 */
import { z } from 'zod'
import { getMaxBashTimeoutMs } from './timeouts.js'

const MAX_TIMEOUT_MS = getMaxBashTimeoutMs()

export const BashInputSchema = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  run_in_background: z.boolean().optional(),
  dangerouslyDisableSandbox: z.boolean().optional(),
  _dangerouslyDisableSandboxApproved: z.boolean().optional(),
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string(),
  }).optional(),
})

export type BashInput = z.infer<typeof BashInputSchema>

/**
 * 模型面向的 schema — 隐藏 `_simulatedSedEdit`(权限对话框提权, 不暴露给模型)
 * 和 `_dangerouslyDisableSandboxApproved`(内部 marker)。
 */
export const PublicBashInputSchema = BashInputSchema.omit({
  _dangerouslyDisableSandboxApproved: true,
  _simulatedSedEdit: true,
})

export type PublicBashInput = z.infer<typeof PublicBashInputSchema>