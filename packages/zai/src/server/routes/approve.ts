// /api/agent/approve — primary decision submission (approve OR reject).
// /api/agent/approve/reject — server-side alias, kept parallel to
// /api/agent/answer/reject. The front-end always uses the primary endpoint.
//
// Defense-in-depth: client-supplied X-Session-Id is checked against the
// pending entry's sessionId. Mismatch → 409, not 404 (the pending is NOT
// consumed). Without X-Session-Id we fall back to toolUseId uniqueness
// (legacy / hot-reload path).

import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { ApproveRegistry } from '../services/approveRegistry.js'

const router: IRouter = Router()

const PRIMARY_REQUEST = z.discriminatedUnion('decision', [
  z.object({
    toolUseId: z.string().min(1),
    decision: z.literal('approved'),
    comment: z.string().max(2000).optional(),
  }),
  z.object({
    toolUseId: z.string().min(1),
    decision: z.literal('rejected'),
    comment: z.string().min(1).max(2000),
  }),
])

const REJECT_REQUEST = z.object({
  toolUseId: z.string().min(1),
  comment: z.string().min(1).max(2000),
  reason: z.string().optional(),
})

function getRegistry(req: Request): ApproveRegistry | undefined {
  return (req as unknown as { _approveRegistry?: ApproveRegistry })._approveRegistry
}

function readClaimedSid(req: Request): string | null {
  const h = req.headers['x-session-id']
  return typeof h === 'string' && h.length > 0 ? h : null
}

router.post('/agent/approve', (req: Request, res: Response) => {
  const parsed = PRIMARY_REQUEST.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'ApproveRegistry not bound to request' })
  }
  const claimedSid = readClaimedSid(req)
  if (claimedSid) {
    const pending = registry.peek(parsed.data.toolUseId)
    if (pending && pending.sessionId !== claimedSid) {
      return res.status(409).json({
        error: 'session_mismatch',
        detail: `toolUseId belongs to a different session`,
      })
    }
  }
  const ok = registry.answer(
    parsed.data.toolUseId,
    parsed.data.decision === 'approved'
      ? { decision: 'approved', ...(parsed.data.comment ? { comment: parsed.data.comment } : {}) }
      : { decision: 'rejected', comment: parsed.data.comment },
  )
  if (!ok) return res.status(404).json({ error: 'no_pending_review' })
  res.json({ ok: true })
})

router.post('/agent/approve/reject', (req: Request, res: Response) => {
  const parsed = REJECT_REQUEST.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'ApproveRegistry not bound to request' })
  }
  const claimedSid = readClaimedSid(req)
  if (claimedSid) {
    const pending = registry.peek(parsed.data.toolUseId)
    if (pending && pending.sessionId !== claimedSid) {
      return res.status(409).json({
        error: 'session_mismatch',
        detail: `toolUseId belongs to a different session`,
      })
    }
  }
  const ok = registry.reject(parsed.data.toolUseId, parsed.data.reason ?? 'user_rejected')
  res.json({ ok })
})

export default router
