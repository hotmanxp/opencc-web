import { randomUUID } from 'node:crypto'
import type { ModelCaller } from './types.js'
import type { TranscriptMessage } from '../transcript/types.js'
import { TranscriptStore } from '../transcript/store.js'
import { serializeForAnthropic } from '../transcript/persistence.js'

const COMPACT_SUMMARY_SYSTEM_PROMPT = `
你是一个对话摘要助手. 你的任务是把下面提供的对话历史压缩成一段精炼的中文摘要, 目标是让后续对话能在不丢失关键信息的前提下继续推进.

摘要需包含:
1. 用户原始目标与约束
2. 已执行的关键操作 (命令、文件修改、决策)
3. 已产生的关键结论与重要事实 (数字、路径、代码片段引用)
4. 当前任务进展与未完成项

约束:
- 用紧凑项目符号列表 + 短段落, 不要超过 800 字
- 保留所有用户提到的具体文件名、版本号、错误信息
- 不要捏造对话中没有出现的内容
- 不要添加问候语或重复指令
`.trim()

export type CompactSessionOptions = {
  store: TranscriptStore
  sessionId: string
  modelCaller: ModelCaller
  cwd: string
  model?: string
}

export type CompactSessionResult =
  | { kind: 'compacted'; summary: string; newMessages: TranscriptMessage[] }
  | { kind: 'error'; message: string }

const TOOL_RESULT_TRUNCATE_BYTES = 500

function serializeForCompact(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
): string {
  const parts: string[] = []
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'assistant'
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]
    let imageCount = 0
    for (const block of blocks) {
      const b = block as { type?: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { media_type?: string } }
      switch (b.type) {
        case 'text':
          parts.push(`[${role}] ${b.text ?? ''}`)
          break
        case 'thinking':
          // 思考对压缩无价值, 丢弃
          break
        case 'tool_use':
          parts.push(`> [tool_use: ${b.name ?? ''}] ${JSON.stringify(b.input ?? {})}`)
          break
        case 'tool_result': {
          const c = b.content
          let s: string
          if (typeof c === 'string') s = c
          else s = JSON.stringify(c)
          if (s.length > TOOL_RESULT_TRUNCATE_BYTES) {
            s = s.slice(0, TOOL_RESULT_TRUNCATE_BYTES) + '...(truncated)'
          }
          parts.push(`> [tool_result: ${b.is_error ? 'error' : 'ok'}]${s}`)
          break
        }
        case 'image':
          imageCount++
          parts.push(`[${role}] [图片附件 ${imageCount}]`)
          break
        default:
          parts.push(`[${role}] [未知块类型: ${b.type}]`)
      }
    }
    if (blocks.length === 0) {
      parts.push(`[${role}] ${String(m.content)}`)
    }
  }
  return parts.join('\n\n')
}

export async function compactSession(
  opts: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const { store, sessionId, modelCaller, cwd, model } = opts

  // 1. 读 + serialize
  const file = await store.read(sessionId)
  const originalMessages = file.messages
  if (originalMessages.length < 2) {
    return { kind: 'error', message: `对话太短, 无需压缩 (当前 ${originalMessages.length} 条, 至少需要 2 条)` }
  }
  const lastMsg = originalMessages[originalMessages.length - 1]!

  const anthropicMessages = serializeForAnthropic(originalMessages)
  const markdown = serializeForCompact(anthropicMessages)

  // 2. 60s timeout
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(new Error('compact-timeout')), 60_000)

  // 3. 调 modelCaller
  let summary = ''
  let sawMessageStop = false
  try {
    const stream = modelCaller({
      model: (model ?? 'default') as string,
      systemPrompt: COMPACT_SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `请压缩以下对话历史为摘要:\n\n${markdown}` }],
      tools: [],
      signal: abortController.signal,
    })
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && (ev as any).delta?.type === 'text_delta') {
        summary += (ev as any).delta.text
      }
      if (ev.type === 'message_stop') {
        sawMessageStop = true
        break
      }
    }
  } catch (err) {
    return { kind: 'error', message: `生成摘要失败: ${(err as Error).message.slice(0, 200)}` }
  } finally {
    clearTimeout(timer)
  }

  summary = summary.trim()
  if (!summary) {
    return { kind: 'error', message: '生成摘要失败: 模型返回空结果' }
  }

  // 4. 构造 boundary + summary 两条
  const boundaryUuid = randomUUID()
  const summaryUuid = randomUUID()
  const lastTurn = (lastMsg.runtime?.turnIndex ?? 0) + 1

  const boundaryMsg: TranscriptMessage = {
    uuid: boundaryUuid,
    parentUuid: lastMsg.uuid,
    type: 'compact_boundary',
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: lastTurn },
    version: '2',
    message: {
      content: [{ type: 'text', text: '对话从这之后被压缩为摘要。详细历史已归档。' }],
      // role: 'system' 标示 compact 边界 — queryEngine.ts:157-158 不读此字段,
      // 但 AnthropicMessage 类型 (transcript/types.ts:110) 严格约束 'user'|'assistant'.
      // 落盘写 'system', 恢复至 AnthropicMessage 形状时 serializeForAnthropic 已经 continue
      // 跳过 (Task 3), 所以这个字段对模型可见性为 0. cast 是 spec §3.2 决定的.
      role: 'system' as 'user' | 'assistant',
    },
    cwd,
    sessionId,
    userType: 'zai',
    isSidechain: false,
  }

  const summaryMsg: TranscriptMessage = {
    uuid: summaryUuid,
    parentUuid: boundaryUuid,
    type: 'assistant',
    timestamp: Date.now() + 1,
    raw: null,
    runtime: { turnIndex: lastTurn },
    version: '2',
    message: {
      content: [{ type: 'text', text: summary }],
      role: 'assistant',
    },
    cwd,
    sessionId,
    userType: 'zai',
    isSidechain: false,
  }

  return {
    kind: 'compacted',
    summary,
    newMessages: [...originalMessages, boundaryMsg, summaryMsg],
  }
}
