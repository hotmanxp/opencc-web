/**
 * 启发式 token 估算 — 不调 API。
 *
 * 公式:
 * - text / thinking: 非 ASCII > 50% → 1.5,< 50% → 4,中间 → 2.5
 * - tool_use: (name.length + JSON.stringify(input).length) / 3
 * - tool_result: JSON.stringify(content).length / 3
 * - image: 固定 1000
 *
 * spec §4.2:估算只用于 shouldAutoCompact 触发判定;不写入 boundary messages。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown }

function nonAsciiRatio(s: string): number {
  if (s.length === 0) return 0
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) nonAscii++
  }
  return nonAscii / s.length
}

function textTokens(s: string): number {
  if (!s) return 0
  const ratio = nonAsciiRatio(s)
  const divisor = ratio > 0.5 ? 1.5 : ratio < 0.5 ? 4 : 2.5
  return Math.ceil(s.length / divisor)
}

function blockTokens(b: Block): number {
  switch (b.type) {
    case 'text':
      return textTokens(b.text ?? '')
    case 'thinking':
      return textTokens(b.thinking ?? '')
    case 'tool_use':
      return Math.ceil(((b.name?.length ?? 0) + JSON.stringify(b.input ?? {}).length) / 3)
    case 'tool_result':
      return Math.ceil(JSON.stringify(b.content ?? '').length / 3)
    case 'image':
      return 1000
    default:
      return 0
  }
}

function messageTokens(m: TranscriptMessage): number {
  const content = m.message?.content
  if (typeof content === 'string') return textTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const b of content) {
    if (b && typeof b === 'object') total += blockTokens(b as Block)
  }
  return total
}

export function estimateMessagesTokenCount(messages: TranscriptMessage[]): number {
  let total = 0
  for (const m of messages) total += messageTokens(m)
  return total
}
