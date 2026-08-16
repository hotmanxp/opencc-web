import { Router, type IRouter } from 'express'
import { getCommandRegistry } from '@zn-ai/zn-agent-core'
import { initCommands } from '../services/commands/registry.js'
import {
  getCurrentSessionId,
  getRuntime,
  getTranscriptStore,
  resolveSkillPrompt,
} from '../services/agentRuntime.js'
import { eventBus } from '../services/eventBus.js'

export const commandRouter: IRouter = Router()

interface CommandRequestBody {
  name?: string
  args?: string
  sessionId?: string
}

// command.run / command.done 事件的 args 字段长度上限 — 防止 args 1MB 文本
// 注入把 eventBus history / SSE 流量撑爆。超出截断 + argsTruncated:true 标记。
const MAX_ARGS_LENGTH = 1024

// command.done result 与 routes/command.ts 的 res.json type 严格对齐;新增
// kind 时必须同步 shared/events.ts CommandEvent union + 这里, zod 编译期
// 拦截飘移。
type CommandDoneResult =
  | 'cleared'
  | 'compacted'
  | 'status'
  | 'message'
  | 'prompt'
  | 'error'
  | 'unknown'

commandRouter.post('/command', async (req, res) => {
  const { name, args = '', sessionId } = (req.body ?? {}) as CommandRequestBody

  // 取当前 session;若 body 带 sessionId,优先用。提前到 try 外面, 让
  // command.run 与 command.done 共享同 sid (即使下游 initCommands 抛错也
  // 能配对)。注意: getCurrentSessionId() 内部读 agentRuntime 单例, 在
  // 测试 stub 下可能返回 null, 此处用 '' 兜底, 与 eventBus 习惯一致。
  const sid = sessionId ?? getCurrentSessionId() ?? ''
  const commandId = crypto.randomUUID()
  const startedAt = Date.now()
  const argsTruncated = args.length > MAX_ARGS_LENGTH
  const argsForEvent = argsTruncated ? args.slice(0, MAX_ARGS_LENGTH) : args
  const resolvedName = name ?? ''

  // command.run — 入口就 emit, 确保 initCommands 抛错也会跟 command.done
  // 配对 (虽然 initCommands 失败应属冷启动异常, 不计入常规统计)。
  eventBus.emit({
    type: 'command.run',
    sessionId: sid,
    commandId,
    name: resolvedName,
    args: argsForEvent,
    ...(argsTruncated ? { argsTruncated: true } : {}),
    trigger: 'user',
    ts: startedAt,
  })

  // 出口帮手: 在 res.json 之前 emit command.done, 同一 commandId 配对
  // command.run。error 字段仅 result='error' 时填, 其它情况省略。
  const finishEvent = (result: CommandDoneResult, error?: string) => {
    eventBus.emit({
      type: 'command.done',
      sessionId: sid,
      commandId,
      name: resolvedName,
      result,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
      ts: Date.now(),
    })
  }

  try {
    // 服务启动时若未 init,先兜底一次。
    await initCommands({ cwd: process.cwd(), dataDir: process.env.ZAI_DATA_DIR ?? '', sessionId })

    const reg = getCommandRegistry()
    const cmd = name ? reg.get(name) : undefined
    if (!cmd) {
      // Skills 不在 command registry 里(registry 只装 builtin + ~/.zai
      // commands),但前端 autocomplete 的 /skill 列表来自 listSkills。这里兜底
      // 解析 skill 并渲染其 markdown prompt,否则 /skill args 会落到 unknown,
      // 原始 "/skill args" 文本被原样丢给模型,skill 永不激活。
      const rendered = name ? await resolveSkillPrompt(name, args) : null
      if (rendered !== null) {
        // skill fallthrough 路由: result 为 'prompt', 但 trigger 实际是
        // 'user'(用户敲 /name), 不是 skill 主动调用。我们在这里给
        // command.run 重新标记? 不, 更准确的方式是: 仍 emit 'user' trigger
        // (代表用户输入), result 是 'prompt' (代表该命令被翻译成 prompt),
        // — 同一个 trigger 字段语义不变, 新增判断留给 frontend。
        finishEvent('prompt')
        return res.json({ type: 'prompt', payload: { rendered } })
      }
      finishEvent('unknown')
      return res.json({ type: 'unknown', payload: { input: `/${name}` } })
    }

    const runtime = getRuntime() as unknown as { config?: { defaultModel?: string } } | null
    // 把 transcript messages 注入到 context(commands 端只读 `m.type` 判 role,
    // 不需要完整 Message 形状)。未传 sessionId / transcript 读失败时缺省
    // 空数组,让命令自身(例如 handoff 的 countAssistantMessages)走
    // "无 assistant 消息"的安全 fallback,而不再被 +Infinity 推入 generate。
    let messages: ReadonlyArray<{ type: string }> = []
    if (sid) {
      try {
        const store = getTranscriptStore()
        const { messages: entries } = await store.read(sid, { cwd: process.cwd() })
        messages = entries as ReadonlyArray<{ type: string }>
      } catch {
        // transcript 缺失 / 损坏不阻断命令 — 跟 vendor 把 messages 视作 []
        // 的兜底语义一致;harness 走"无 assistant 消息"分支(新会话)。
      }
    }
    const context = {
      cwd: process.cwd(),
      dataDir: process.env.ZAI_DATA_DIR ?? '',
      ...(sid ? { sessionId: sid } : {}),
      ...(runtime?.config?.defaultModel ? { model: runtime.config.defaultModel } : {}),
      messages,
    }

    if (cmd.type === 'local') {
      const result = await cmd.call(args, context)
      switch (result.kind) {
        case 'cleared':
          finishEvent('cleared')
          return res.json({ type: 'cleared', payload: null })
        case 'compacted':
          finishEvent('compacted')
          return res.json({ type: 'compacted', payload: { removedMessages: result.removedMessages, summary: result.summary } })
        case 'status':
          finishEvent('status')
          return res.json({ type: 'status', payload: result.payload })
        case 'message':
          finishEvent('message')
          return res.json({ type: 'message', payload: { text: result.text } })
        case 'error':
          finishEvent('error', result.message)
          return res.json({ type: 'error', payload: { message: result.message } })
      }
    }
    // PromptCommand
    try {
      const blocks = await cmd.getPromptForCommand(args, context)
      // 合并 text 块为单字符串(实际场景绝大多数命令只有一段 text)。
      const text = blocks
        .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
        .filter(Boolean)
        .join('\n')
      finishEvent('prompt')
      return res.json({ type: 'prompt', payload: { rendered: text } })
    } catch (err) {
      console.error('[command] handler failed:', err)
      const message = `生成交接提示失败:${err instanceof Error ? err.message : String(err)}`
      finishEvent('error', message)
      return res.json({
        type: 'error',
        payload: { message },
      })
    }
  } catch (err) {
    const message = (err as Error).message
    finishEvent('error', message)
    return res.status(500).json({ type: 'error', payload: { message } })
  }
})
