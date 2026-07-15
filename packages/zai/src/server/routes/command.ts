import { Router, type IRouter } from 'express'
import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { initCommands } from '../services/commands/registry.js'
import { getCurrentSessionId, getRuntime } from '../services/agentRuntime.js'

export const commandRouter: IRouter = Router()

interface CommandRequestBody {
  name?: string
  args?: string
  sessionId?: string
}

commandRouter.post('/command', async (req, res) => {
  const { name, args = '', sessionId } = (req.body ?? {}) as CommandRequestBody

  try {
    // 服务启动时若未 init,先兜底一次。
    await initCommands({ cwd: process.cwd(), dataDir: process.env.ZAI_DATA_DIR ?? '', sessionId })

    const reg = getCommandRegistry()
    const cmd = name ? reg.get(name) : undefined
    if (!cmd) {
      return res.json({ type: 'unknown', payload: { input: `/${name}` } })
    }

    // 取当前 session;若 body 带 sessionId,优先用。
    const sid = sessionId ?? getCurrentSessionId() ?? undefined
    const runtime = getRuntime() as unknown as { config?: { defaultModel?: string } } | null
    const context = {
      cwd: process.cwd(),
      dataDir: process.env.ZAI_DATA_DIR ?? '',
      ...(sid ? { sessionId: sid } : {}),
      ...(runtime?.config?.defaultModel ? { model: runtime.config.defaultModel } : {}),
    }

    if (cmd.type === 'local') {
      const result = await cmd.call(args, context)
      switch (result.kind) {
        case 'cleared': return res.json({ type: 'cleared', payload: null })
        case 'compacted': return res.json({ type: 'compacted', payload: { removedMessages: result.removedMessages, summary: result.summary } })
        case 'status': return res.json({ type: 'status', payload: result.payload })
        case 'message': return res.json({ type: 'message', payload: { text: result.text } })
        case 'error': return res.json({ type: 'error', payload: { message: result.message } })
      }
    }
    // PromptCommand
    const blocks = await cmd.getPromptForCommand(args, context)
    // 合并 text 块为单字符串(实际场景绝大多数命令只有一段 text)。
    const text = blocks
      .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
    return res.json({ type: 'prompt', payload: { rendered: text } })
  } catch (err) {
    return res.status(500).json({ type: 'error', payload: { message: (err as Error).message } })
  }
})
