import { Router, type Request, type Response } from 'express'
import {
  getTranscriptStore,
} from '../services/agentRuntime.js'
import { repairAndPersistTranscript } from '@zn-ai/zai-agent-core/runtime'

const router: Router = Router()

// POST /api/transcript/:sessionId/repair
// 手动触发 transcript 修复: 把"孤立 tool_use"(没有匹配 tool_result)补
// 上一个 recovery 记录(tool_result with is_error:true + 文案"tool execution
// did not complete"),让下游 LLM 重新加载时拿到合法的 tool_use/tool_result 对.
// 触发原因: 历史 transcript(尤其 zai < isMeta 协议)可能在 hook 抛错、崩溃、
// 或服务重启时丢掉部分 tool_result;resume 时 Anthropic 会回 2013"messages:
// tool_use ids were found without tool_result blocks". 这个端点对当前
// session 立即跑一次 repairAndPersistTranscript,返回 { repaired, ids }
router.post('/:sessionId/repair', async (req: Request, res: Response) => {
  const sessionId = req.params.sessionId
  if (!sessionId || !sessionId.startsWith('sess-')) {
    res.status(400).json({ error: 'invalid sessionId' })
    return
  }
  try {
    const store = getTranscriptStore()
    try {
      await store.read(sessionId)
    } catch (readErr) {
      // ENOENT 或 transcript 损坏
      const code = (readErr as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'transcript not found', sessionId })
        return
      }
      throw readErr
    }
    const result = await repairAndPersistTranscript(store, sessionId)
    res.json({
      ok: true,
      sessionId,
      repaired: result.report.repaired,
      repairedToolUseIds: result.report.repairedToolUseIds,
      synthesizedToolUseIds: result.report.synthesizedToolUseIds,
      synthesizedOrphanToolUseIds: result.report.synthesizedOrphanToolUseIds,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: `repair failed: ${msg}`, sessionId })
  }
})

export default router
