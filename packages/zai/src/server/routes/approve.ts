// /api/agent/approve — primary decision submission (approve OR reject).
// /api/agent/approve/reject — server-side alias, kept parallel to
// /api/agent/answer/reject. The front-end always uses the primary endpoint.
// /api/agent/approve/file — fetch the document the LLM asked to be reviewed.
//   Looked up by toolUseId against the in-memory ApproveRegistry; the
//   registry stores the filePath supplied at tool-use time so the front
//   end can pull the latest version without the AI snapshotting it inline.
//
// Defense-in-depth: client-supplied X-Session-Id is checked against the
// pending entry's sessionId. Mismatch → 409, not 404 (the pending is NOT
// consumed). Without X-Session-Id we fall back to toolUseId uniqueness
// (legacy / hot-reload path).

import { Router, type IRouter, type Request, type Response } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ApproveRegistry } from '../services/approveRegistry.js'

const router: IRouter = Router()

// Approve file body hard cap. Mirrors the spec §2.1 inline cap that was
// in place before the filePath simplification; the fetch endpoint is
// the only path the drawer takes now, so this is the single guardrail.
const APPROVE_FILE_MAX = 200_000

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

// Resolve the per-session cwd by reading the v2 transcript. We need this
// because the filePath the AI submitted is relative to the session cwd
// (which may differ from the instance cwd if the LLM ran `cd` mid-loop).
async function resolveSessionCwd(sessionId: string, instanceCwd: string): Promise<string> {
  try {
    const { getTranscriptStore } = await import('../services/agentRuntime.js')
    const store = getTranscriptStore()
    const t = await store.read(sessionId)
    const metaCwd = (t.meta as { cwd?: string }).cwd
    return metaCwd ? path.resolve(metaCwd) : path.resolve(instanceCwd)
  } catch {
    // Fall back to the instance cwd if the session can't be loaded —
    // production calls almost always have a valid session, but tests
    // and ad-hoc callers may not.
    return path.resolve(instanceCwd)
  }
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

// GET /api/agent/approve/file?toolUseId=...&sessionId=...
//
// The front end opens the drawer when the SSE prompt.approve event arrives,
// then calls this endpoint to load the actual markdown. We never trust
// `?filePath=` directly — only the filePath stored on the registry entry
// (which itself came from the validated tool call) is allowed. This makes
// the endpoint a sealed channel: it's only useful to a reader who already
// has a valid toolUseId for an in-flight approval.
//
// filePath is an absolute path (unix or windows). The route resolves it
// literally and reads the file directly. Workspace-boundary enforcement
// moved from the route to the calling agent — the front-end reviewer and
// the agent share trust, but the agent is expected to supply a path the
// reviewer can actually see.
//
// Status codes:
//   200 → { toolUseId, filePath, content, bytes }
//   400 → missing toolUseId
//   403 → sid mismatch (sid supplied but doesn't match registry entry)
//   404 → no pending entry (already answered / timed out / unknown id)
//   413 → file larger than APPROVE_FILE_MAX
//   415 → binary file (utf-8 decode failure)
router.get('/agent/approve/file', async (req: Request, res: Response) => {
  const toolUseId = typeof req.query.toolUseId === 'string' ? req.query.toolUseId : ''
  if (!toolUseId) {
    return res.status(400).json({ error: 'missing_toolUseId' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'ApproveRegistry not bound to request' })
  }
  const pending = registry.peek(toolUseId)
  if (!pending) {
    return res.status(404).json({ error: 'no_pending_review' })
  }
  const claimedSid = readClaimedSid(req)
  if (claimedSid && pending.sessionId !== claimedSid) {
    return res.status(403).json({
      error: 'session_mismatch',
      detail: `toolUseId belongs to a different session`,
    })
  }
  // Absolute path semantics: take the filePath as-is and let the OS resolve
  // it. The previous cwd-anchoring / path-traversal block is intentionally
  // removed because the contract changed — callers now supply a fully
  // qualified path, so escape-prevention is the agent's responsibility
  // (typically via sandbox / file-tool policy), not this route's.
  const abs = path.resolve(pending.filePath)
  let buf: Buffer
  try {
    const stat = await fs.stat(abs)
    if (stat.size > APPROVE_FILE_MAX) {
      return res.status(413).json({
        error: 'file_too_large',
        max: APPROVE_FILE_MAX,
        actual: stat.size,
      })
    }
    if (stat.size === 0) {
      return res.json({ toolUseId, filePath: pending.filePath, content: '', bytes: 0 })
    }
    buf = await fs.readFile(abs)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return res.status(404).json({ error: 'file_unreadable', detail: msg })
  }
  const td = new TextDecoder('utf-8', { fatal: true })
  let content: string
  try {
    content = td.decode(buf)
  } catch {
    return res.status(415).json({ error: 'binary_file' })
  }
  res.json({ toolUseId, filePath: pending.filePath, content, bytes: buf.length })
})

export default router
