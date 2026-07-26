/**
 * 把对话历史转成 Markdown,喂给 LLM 生成摘要。
 *
 * 与旧 compactService.ts:36-80 行为兼容(spec Global Constraints 不变量 5)。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

const TOOL_RESULT_TRUNCATE_BYTES = 500

type Block = {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { media_type?: string }
}

function blockToString(role: string, block: Block, imageCountRef: { n: number }): string | null {
  switch (block.type) {
    case 'text':
      return `[${role}] ${block.text ?? ''}`
    case 'thinking':
      return null
    case 'tool_use':
      return `> [tool_use: ${block.name ?? ''}] ${JSON.stringify(block.input ?? {})}`
    case 'tool_result': {
      let s: string
      const c = block.content
      if (typeof c === 'string') s = c
      else s = JSON.stringify(c)
      if (s.length > TOOL_RESULT_TRUNCATE_BYTES) {
        s = s.slice(0, TOOL_RESULT_TRUNCATE_BYTES) + '...(truncated)'
      }
      return `> [tool_result: ${block.is_error ? 'error' : 'ok'}]${s}`
    }
    case 'image':
      imageCountRef.n++
      return `[${role}] [图片附件 ${imageCountRef.n}]`
    default:
      return `[${role}] [未知块类型: ${block.type}]`
  }
}

export function serializeForCompact(messages: TranscriptMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const role = m.type === 'user' ? 'user' : 'assistant'
    const content = m.message?.content
    const imageCountRef = { n: 0 }
    const partsForMsg: string[] = []
    if (typeof content === 'string') {
      partsForMsg.push(`[${role}] ${content}`)
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === 'object') {
          const s = blockToString(role, b as Block, imageCountRef)
          if (s) partsForMsg.push(s)
        }
      }
    } else {
      partsForMsg.push(`[${role}] ${String(content)}`)
    }
    parts.push(partsForMsg.join('\n\n'))
  }
  return parts.join('\n\n')
}
