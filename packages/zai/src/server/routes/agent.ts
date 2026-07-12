import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { abortAgentSession, getCurrentSessionId, getAskRegistry, getRuntime, getTranscriptStore, setCurrentSessionId } from '../services/agentRuntime.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '@zn-ai/zai-agent-core'
import { eventBus } from '../services/eventBus.js'

const router: IRouter = Router()

const HARD_TIMEOUT_MS = 5 * 60 * 1000

const PromptRequest = z.object({
  prompt: z.string().min(1).max(32_000),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
})

function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

router.post('/agent/prompt', async (req: Request, res: Response) => {
  const parsed = PromptRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {prompt, cwd?}' })
  }

  const { prompt, cwd = process.cwd(), sessionId: existingSessionId } = parsed.data
  const sessionId = existingSessionId ?? newSessionId()
  const abortController = new AbortController()
  const timer = setTimeout(() => {
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.agent.prompt] HARD_TIMEOUT fired', { sessionId, ms: HARD_TIMEOUT_MS })
    }
    abortController.abort('timeout')
  }, HARD_TIMEOUT_MS)

  req.on('close', () => {
    if (process.env.ZAI_DEBUG === '1') {
      console.error('[zai.agent.prompt] req.close', {
        sessionId,
        alreadyAborted: abortController.signal.aborted,
      })
    }
    if (!abortController.signal.aborted) {
      abortController.abort('client_disconnect')
    }
    getAskRegistry().abortAll('client_disconnect')
  })

  // 立即响应，事件通过 eventBus → /api/event SSE
  res.json({ sessionId })

  // 异步 fire-and-forget 运行 runtime
  void (async () => {
    try {
      let systemPrompt: string | undefined
      try {
        const agentsMd = await loadAgentsMd(cwd)
        const built = buildAgentsMdSystemPrompt(agentsMd)
        systemPrompt = built ?? undefined
      } catch {
        // AGENTS.md 加载失败不阻断
      }

      const events = getRuntime().run({
        prompt,
        cwd,
        ...(existingSessionId ? { resumeFromTranscriptId: existingSessionId } : {}),
        systemPrompt,
        abortSignal: abortController.signal,
      })

      let titlePatched = Boolean(existingSessionId)
      for await (const event of events) {
        // 首次出现 sessionId → 写入 session.created 事件
        if (typeof event.sessionId === 'string' && event.sessionId !== sessionId) {
          setCurrentSessionId(event.sessionId)
          if (!titlePatched) {
            titlePatched = true
            try {
              const title = deriveTitleFromPrompt(prompt)
              await getTranscriptStore().patch(event.sessionId, { title })
            } catch {
              /* title 失败不阻断 */
            }
          }
        }
        // ★ 替代原 stream.send：通过总线推送
        eventBus.emit(event as any)
        if (event.type === 'runtime.done' || event.type === 'runtime.aborted') break
      }
    } catch (err) {
      if (process.env.ZAI_DEBUG === '1') {
        console.error('[zai.agent.prompt] for-await threw', {
          sessionId,
          message: (err as Error).message,
          stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        })
      }
      eventBus.emit({
        type: 'runtime.error',
        eventId: 'err',
        sessionId,
        ts: Date.now(),
        turnIndex: 0,
        error: {
          category: 'internal',
          message: (err as Error).message,
          recoverable: false,
        },
      } as any)
    } finally {
      clearTimeout(timer)
    }
  })()
})

// GET /api/agent/sessions — 列出所有 session，最新的在前
router.get('/agent/sessions', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    const sessions = await store.list()
    res.json({ sessions })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/agent/sessions/:id — 读取指定 session 的消息
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    const transcript = await store.read(req.params.id)
    res.json({ transcript })
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

// DELETE /api/agent/sessions/:id — 删除指定 session
router.delete('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const store = getTranscriptStore()
    await store.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/agent/abort', async (_req: Request, res: Response) => {
  const sessionId = getCurrentSessionId()
  await abortAgentSession('user_abort')
  res.json({ ok: true, sessionId })
})

const TITLE_MAX_LEN = 50

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim()
  if (!firstLine) return '新会话'
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + '…'
}

export default router
