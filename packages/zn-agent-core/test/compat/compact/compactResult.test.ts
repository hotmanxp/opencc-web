/**
 * Unit tests for the summary-extraction leaf.
 *
 * `compactBridge.ts` itself is not unit-testable under vite-node: it
 * transitively imports vendor's compaction chain, and
 * `opencc-src/utils/attachments.ts` does
 * `require('./permissions/autoModeState.js')`, which vite-node cannot resolve.
 * The extraction logic — the only part of the bridge with real branching — is
 * therefore split into `compat/compact/compactResult.ts`, mirroring how
 * `autoCompactThreshold.ts` was extracted for the auto-compact threshold.
 */
import { describe, expect, it } from 'vitest'
import { extractSummaryText } from '../../../src/compat/compact/compactResult.js'

/** vendor AssistantMessage with plain-string content. */
const strMsg = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: text },
})

/** vendor AssistantMessage with content-block array content. */
const blockMsg = (blocks: unknown[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks },
})

describe('extractSummaryText', () => {
  it('joins multiple string-content messages', () => {
    const out = extractSummaryText({
      summaryMessages: [strMsg('第一段'), strMsg('第二段')],
    })
    expect(out).toBe('第一段\n第二段')
  })

  it('pulls text blocks out of a content-block array', () => {
    const out = extractSummaryText({
      summaryMessages: [
        blockMsg([
          { type: 'thinking', thinking: '不该进摘要' },
          { type: 'text', text: '摘要正文' },
        ]),
      ],
    })
    expect(out).toBe('摘要正文')
  })

  it('skips non-text blocks (tool_use / images) — they carry no summary value', () => {
    const out = extractSummaryText({
      summaryMessages: [
        blockMsg([
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'image', source: { media_type: 'image/png' } },
          { type: 'text', text: '只有这段有用' },
        ]),
      ],
    })
    expect(out).toBe('只有这段有用')
  })

  it('trims surrounding whitespace', () => {
    expect(extractSummaryText({ summaryMessages: [strMsg('  \n 正文 \t ')] })).toBe('正文')
  })

  it('throws on an empty summary rather than silently compacting to nothing', () => {
    // A silent '' would make /compact report success while destroying history.
    expect(() => extractSummaryText({ summaryMessages: [] })).toThrow(/空摘要/)
    expect(() => extractSummaryText({})).toThrow(/空摘要/)
    expect(() =>
      extractSummaryText({ summaryMessages: [blockMsg([{ type: 'thinking', thinking: 'x' }])] }),
    ).toThrow(/空摘要/)
  })

  it('tolerates malformed messages instead of crashing on a missing field', () => {
    const out = extractSummaryText({
      summaryMessages: [{}, { message: {} }, strMsg('活下来了')],
    })
    expect(out).toBe('活下来了')
  })
})
