import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AskRegistry } from '../services/askRegistry.js'

const router: IRouter = Router()

const AnswerRequest = z.object({
  toolUseId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.object({
    preview: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
})

function getRegistry(req: Request): AskRegistry | undefined {
  return (req as unknown as { _askRegistry?: AskRegistry })._askRegistry
}

// 从 X-Session-Id header 读 client 声称的 sid. 不传 → null, 不校验.
function readClaimedSid(req: Request): string | null {
  const h = req.headers['x-session-id']
  if (typeof h === 'string' && h.length > 0) return h
  return null
}

router.post('/agent/answer', (req: Request, res: Response) => {
  const parsed = AnswerRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'AskRegistry not bound to request' })
  }
  const claimedSid = readClaimedSid(req)
  // 防御跨 sid 串号: 客户端带了 X-Session-Id 时, 校验 pendingAsk 的 sessionId
  // 必须一致. 不带 (legacy / 内部调用) → 维持旧行为, 只靠 toolUseId 唯一性.
  // 拒绝时返回 409 而非 404: 404 会让前端显示"Session 已过期", 但实际
  // session 还活着, 只是 sid 串了 — 错误的用户提示.
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
    answers: parsed.data.answers,
    ...(parsed.data.annotations ? { annotations: parsed.data.annotations } : {}),
  })
  if (!ok) return res.status(404).json({ error: 'no pending ask for toolUseId' })
  res.json({ ok: true })
})

const RejectRequest = z.object({
  toolUseId: z.string().min(1),
  reason: z.string().optional(),
})

router.post('/agent/answer/reject', (req: Request, res: Response) => {
  const parsed = RejectRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'AskRegistry not bound to request' })
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
  const ok = registry.reject(parsed.data.toolUseId, parsed.data.reason)
  res.json({ ok })
})

export default router