import { z } from 'zod'

// 上限:title / summary / comment 与旧 spec 对齐。filePath 长度单独限制
// 防止用户传超长字符串绕过 prefix 检查。路径 1KB 已远超实践上限。
const TITLE_MAX = 120
const SUMMARY_MAX = 300
const COMMENT_MAX = 2000
const FILE_PATH_MAX = 1024

// Simplified input: just a title + an optional summary + a filePath that the
// front-end can fetch on demand. We deliberately DO NOT inline the body here:
//   - SSE traffic stays constant regardless of document size
//   - The reviewer always sees the freshest content (the AI may keep editing
//     the file before submit); the old `inline` variant captured a snapshot
//   - No 200KB cap is needed because the bytes never traverse the wire
//
// filePath 接受绝对路径(unix `/...` 或 windows `C:\...` / `C:/...`)。服务端
// 路由直接按字面值解析,不再相对 session cwd 锚定 — 调用方负责给出合法路径。
export const RequestApproveInput = z.strictObject({
  title: z.string().min(1).max(TITLE_MAX),
  summary: z.string().max(SUMMARY_MAX).optional(),
  filePath: z.string().min(1).max(FILE_PATH_MAX),
})
export type RequestApproveInput = z.infer<typeof RequestApproveInput>

// Output is what the model sees in transcript after the user decides.
// - approve is unconditional; comment is optional (user may want to add
//   marginal notes, "looks good", etc.).
// - reject REQUIRES a non-empty comment. This is a hard product rule:
//   a reject-with-no-context is useless to the AI.
export const RequestApproveOutput = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approved'),
    comment: z.string().max(COMMENT_MAX).optional(),
  }),
  z.object({
    decision: z.literal('rejected'),
    comment: z.string().min(1).max(COMMENT_MAX),
  }),
])
export type RequestApproveOutput = z.infer<typeof RequestApproveOutput>

export type RequestApproveDecision = 'approved' | 'rejected'

// Canonical aliases matching AskUserQuestionTool's schema convention. The
// runtime imports the tool's inputSchema/outputSchema by these names.
export const inputSchema = RequestApproveInput
export const outputSchema = RequestApproveOutput
