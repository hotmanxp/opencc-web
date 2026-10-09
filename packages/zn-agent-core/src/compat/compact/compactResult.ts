// Leaf module — no imports on purpose.
//
// Same reasoning as `autoCompactThreshold.ts`: `compactBridge.ts` transitively
// pulls vendor's compaction chain, and `utils/attachments.ts` inside it does
// `require('./permissions/autoModeState.js')`, which vite-node cannot resolve
// (ERR_MODULE_NOT_FOUND under vitest). The summary-extraction logic is the only
// piece with real branching, so it lives here where it can be driven directly.

/**
 * Pull the summary body out of a vendor `CompactionResult`.
 *
 * Summary messages are vendor `AssistantMessage`s shaped
 * `{ type: 'assistant', message: { content } }`, where `content` is either a
 * plain string or an array of content blocks. Anything that is not text
 * (thinking, tool_use) carries no summarisation value and is skipped.
 *
 * Throws rather than returning '' — a silent empty summary would make /compact
 * report success while destroying the conversation.
 */
export function extractSummaryText(result: unknown): string {
  const blocks = (result as { summaryMessages?: unknown[] })?.summaryMessages ?? []
  const parts: string[] = []
  for (const msg of blocks) {
    const content = (msg as { message?: { content?: unknown } })?.message?.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        }
      }
    }
  }
  const text = parts.join('\n').trim()
  if (!text) {
    throw new Error('compactViaVendor: vendor 返回了空摘要')
  }
  return text
}
