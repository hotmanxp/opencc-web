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

router.post('/agent/answer', (req: Request, res: Response) => {
  const parsed = AnswerRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'AskRegistry not bound to request' })
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
  const ok = registry.reject(parsed.data.toolUseId, parsed.data.reason)
  res.json({ ok })
})

export default router
