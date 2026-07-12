import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { createSseStream } from './stream.js'
import { abortAgentSession, getCurrentSessionId, getAskRegistry, getRuntime, getTranscriptStore, setCurrentSessionId, listSkills } from '../services/agentRuntime.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '@zn-ai/zai-agent-core'

const router: IRouter = Router()

const HARD_TIMEOUT_MS = 5 * 60 * 1000

const StreamRequest = z.object({
  prompt: z.string().min(1).max(32_000),
  cwd: z.string().optional(),
  token: z.string().optional(),
  sessionId: z.string().optional(),
})

router.post('/agent/stream', async (req: Request, res: Response) => {
  const parsed = StreamRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {prompt, cwd?}' })
  }

  const { prompt, cwd = process.cwd(), sessionId: existingSessionId } = parsed.data
  const runtime = getRuntime()

  let systemPrompt: string | undefined
  try {
    const agentsMd = await loadAgentsMd(cwd)
    const built = buildAgentsMdSystemPrompt(agentsMd)
    systemPrompt = built ?? undefined
  } catch {
    // AGENTS.md 加载失败不阻断请求
  }

  const stream = createSseStream(res)
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort('timeout'), HARD_TIMEOUT_MS)

  req.on('close', () => {
    if (!abortController.signal.aborted) {
      abortController.abort('client_disconnect')
    }
    // 客户端断开时清空 AskRegistry 中等待的 promise, 让 tool.call 终止
    getAskRegistry().abortAll('client_disconnect')
  })

  try {
    const events = runtime.run({
      prompt,
      cwd,
      ...(existingSessionId ? { resumeFromTranscriptId: existingSessionId } : {}),
      systemPrompt,
      abortSignal: abortController.signal,
    })
    let sessionId = existingSessionId ?? ''
    let titlePatched = Boolean(existingSessionId)
    for await (const event of events) {
      if (typeof event.sessionId === 'string' && event.sessionId !== sessionId) {
        sessionId = event.sessionId
        setCurrentSessionId(sessionId)
        if (!titlePatched) {
          titlePatched = true
          try {
            const title = deriveTitleFromPrompt(prompt)
            await getTranscriptStore().patch(sessionId, { title })
          } catch { /* title 失败不阻断流 */ }
        }
      }
      stream.send(event as any)
      if (event.type === 'runtime.done' || event.type === 'runtime.aborted') break
    }
  } catch (err) {
    stream.send({
      type: 'runtime.error',
      eventId: 'err',
      sessionId: existingSessionId ?? '',
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
    stream.end()
  }
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

// GET /api/agent/skills — 返回可用 skills 列表，供前端 / 触发 autocomplete
router.get('/agent/skills', async (_req: Request, res: Response) => {
  try {
    const skills = await listSkills()
    res.json({ skills })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

const TITLE_MAX_LEN = 50

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0].trim()
  if (!firstLine) return '新会话'
  if (firstLine.length <= TITLE_MAX_LEN) return firstLine
  return firstLine.slice(0, TITLE_MAX_LEN - 1) + '…'
}

export default router
