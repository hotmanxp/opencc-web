import { Router, type IRouter } from 'express'
import { z } from 'zod'
import {
  getReplHistoryService,
  type ReplHistoryService,
} from '../services/repl/ReplHistoryService.js'

const router: IRouter = Router()

/** 默认 + 上限保护 — top10 接口返回命令数上限 */
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 10

const QuerySchema = z.object({
  q: z.string().optional(),
  // n 仅校验为正整数;上限在 router 内 clamp(超过不报错,而是限制为 MAX_LIMIT)
  n: z.coerce.number().int().min(1).optional(),
})

function resolveService(req: any): ReplHistoryService {
  // 测试可注入 app.locals.replHistoryService;生产用单例
  return req.app?.locals?.replHistoryService ?? getReplHistoryService()
}

/**
 * GET /api/bash/history/top10?q=<prefix>&n=<limit>
 * 返回全局命令历史中频次 topN,支持前缀过滤。
 * Spec/Plan: docs/superpowers/plans/2026-07-25-zai-bash-repl-top10.md
 */
router.get('/bash/history/top10', async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid query', detail: parsed.error.flatten() })
  }
  const { q, n } = parsed.data
  // 上限保护:超过 MAX_LIMIT 静默 clamp,客户端不必处理 400
  const limit = Math.min(n ?? DEFAULT_LIMIT, MAX_LIMIT)
  const prefix = q && q.length > 0 ? q : undefined
  const entries = await resolveService(req).getTopCommands(limit, prefix)
  return res.json({ entries })
})

export default router