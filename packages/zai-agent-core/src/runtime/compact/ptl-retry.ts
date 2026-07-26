/**
 * PTL 自愈削头。
 *
 * spec §4.1:每次削掉最早的 1 个 API-round group(从首个 user 开始,
 * 到下一个 user 之前)。返回 null 表示无法削够 / 消息数 < 2 / gap 不足。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

const MIN_REMAINING_MESSAGES = 2
const PTL_HEADROOM_BUFFER_TOKENS = 50_000

export function getPromptTooLongTokenGap(
  ptlResponse: { usage?: { output_tokens?: number } },
  contextWindow: number,
): number {
  const used = ptlResponse?.usage?.output_tokens
  if (typeof used !== 'number' || !Number.isFinite(used)) return contextWindow
  return Math.max(0, contextWindow - used)
}

function findNextUserIndex(messages: TranscriptMessage[], startFrom: number): number {
  for (let i = startFrom; i < messages.length; i++) {
    if (messages[i]!.type === 'user') return i
  }
  return messages.length
}

export function truncateHeadForPTLRetry(
  messages: TranscriptMessage[],
  ptlResponse: { usage?: { output_tokens?: number } },
  contextWindow: number,
): TranscriptMessage[] | null {
  if (messages.length < MIN_REMAINING_MESSAGES) return null
  const gap = getPromptTooLongTokenGap(ptlResponse, contextWindow)
  if (gap < PTL_HEADROOM_BUFFER_TOKENS) return null
  const firstUserIdx = messages.findIndex((m) => m.type === 'user')
  if (firstUserIdx < 0) return null
  const nextUserIdx = findNextUserIndex(messages, firstUserIdx + 1)
  const remaining = messages.slice(nextUserIdx)
  if (remaining.length < MIN_REMAINING_MESSAGES) return null
  return remaining
}