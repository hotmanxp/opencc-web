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

/**
 * 内联语义 tolerant 数字/布尔 helper — zod v3 原生 z.preprocess 形态,
 * 避免 opencc-internals 里的 `zod/v4` ZodPipe 与 zod v3 ZodObject 不兼容
 * (TypeError: keyValidator._parse is not a function)。行为等价于
 * `semanticNumber`/`semanticBoolean`: 模型偶尔把数字/布尔值加上引号
 * (例如 `"timeout":"30000"` / `"run_in_background":"false"`), 这里在
 * preprocess 阶段把它们转回 number/boolean。
 */
const semanticNumber = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (v: unknown) =>
      typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v,
    inner,
  ) as unknown as T

const semanticBoolean = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  ) as unknown as T

export const BashInputSchema = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: semanticNumber(z.number().int().positive().max(MAX_TIMEOUT_MS).optional()),
  run_in_background: semanticBoolean(z.boolean().optional()),
  dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()),
  _dangerouslyDisableSandboxApproved: z.boolean().optional(),
  _simulatedSedEdit: z.object({
    filePath: z.string(),
    newContent: z.string(),
  }).optional(),
}).strict()

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