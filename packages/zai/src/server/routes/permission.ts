// /api/agent/permission-response — resolve a pending `behavior:'ask'`
// permission decision surfaced to the web UI (prompt.permission SSE event).
//
// The headless permission bridge (opencc-src/server/headlessPermissionBridge.ts)
// registers the decision with PermissionRegistry keyed by toolUseId and awaits
// the user's answer. This endpoint resolves it:
//   allow → the tool runs (optionally with updatedInput)
//   deny  → toolExecution surfaces a rejection to the model
//
// Defense-in-depth: client-supplied X-Session-Id is checked against the
// pending entry's sessionId. Mismatch → 409, not 404 (the pending is NOT
// consumed). Without X-Session-Id we fall back to toolUseId uniqueness.

import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { PermissionRegistry } from '../services/permissionRegistry.js'

const router: IRouter = Router()

const RESPONSE_REQUEST = z.discriminatedUnion('decision', [
  z.object({
    toolUseId: z.string().min(1),
    decision: z.literal('allow'),
    message: z.string().max(2000).optional(),
  }),
  z.object({
    toolUseId: z.string().min(1),
    decision: z.literal('deny'),
    message: z.string().max(2000).optional(),
  }),
])

function getRegistry(req: Request): PermissionRegistry | undefined {
  return (req as unknown as { _permissionRegistry?: PermissionRegistry })._permissionRegistry
}

function readClaimedSid(req: Request): string | null {
  const h = req.headers['x-session-id']
  return typeof h === 'string' && h.length > 0 ? h : null
}

router.post('/agent/permission-response', (req: Request, res: Response) => {
  const parsed = RESPONSE_REQUEST.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'PermissionRegistry not bound to request' })
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
  const ok = registry.answer(parsed.data.toolUseId, {
    decision: parsed.data.decision,
    ...(parsed.data.message ? { message: parsed.data.message } : {}),
  })
  if (!ok) return res.status(404).json({ error: 'no_pending_permission' })
  res.json({ ok: true })
})

export default router
