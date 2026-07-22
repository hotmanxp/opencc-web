import { z } from 'zod'

// 200KB hard cap on inline content. ~50k tokens is the practical maximum
// we want to allow through the SSE pipeline; anything larger should use the
// `file` variant and write the document to disk first.
const INLINE_BODY_MAX = 200_000
const TITLE_MAX = 120
const SUMMARY_MAX = 300
const COMMENT_MAX = 2000

// The body the AI submits. Discriminated by `kind`. Exactly one variant must
// be present per the runtime's parseAndExecute flow.
export const RequestApproveBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inline'),
    content: z.string().min(1).max(INLINE_BODY_MAX),
  }),
  z.object({
    kind: z.literal('file'),
    // Path is relative to the session cwd. The runtime validates that this
    // doesn't start with '/' (an absolute path would escape the workspace).
    path: z.string().min(1),
  }),
])
export type RequestApproveBody = z.infer<typeof RequestApproveBody>

export const RequestApproveInput = z.strictObject({
  title: z.string().min(1).max(TITLE_MAX),
  summary: z.string().max(SUMMARY_MAX).optional(),
  body: RequestApproveBody,
}).refine(
  // File paths must be relative to the session cwd. Absolute paths are
  // rejected because they escape the workspace boundary that the runtime
  // already maintains for Read/Write.
  (d) => d.body.kind === 'inline' || !d.body.path.startsWith('/'),
  { message: 'file path must be relative to the session cwd', path: ['body', 'path'] },
)
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

// The shape the runtime resolves into before passing to the registry. The
// SSE event uses the same canonical shape — see shared/events.ts.
export type ResolvedBody =
  | { kind: 'inline'; displayPath: null;  content: string }
  | { kind: 'file';   displayPath: string; content: string }
