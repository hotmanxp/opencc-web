/**
 * Regression for the compact-boundary transcript shape zai writes.
 *
 * zai's `/compact` originally emitted `type: 'compact_boundary'` with no
 * `subtype`. Vendor's boundary detector (`sessionStoragePortable.ts`
 * `parseBoundaryLine`) requires BOTH `type === 'system'` AND
 * `subtype === 'compact_boundary'`:
 *
 *   if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') return null
 *
 * So the old rows were invisible to vendor's loader — it either skipped them
 * or (once a line does parse as a boundary) took the "truncate everything
 * before it" branch, making the `preservedSegment` relink path unreachable.
 *
 * Fixed on the zai side (2026-10-08, plan P1.5) by writing the vendor shape:
 * `type: 'system'`, `subtype: 'compact_boundary'`, plus
 * `compactMetadata.preservedSegment` carrying the {head, anchor, tail} anchor
 * triple that `applyPreservedSegmentRelinks` needs to reconnect the preserved
 * segment to the summary.
 *
 * This test drives vendor's own `readTranscriptForLoad` to lock the contract
 * from the reader's side, and keeps the old shape as a contrast case so the
 * failure mode stays documented.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore — vendor module; src/opencc-src is excluded from the main tsconfig
import { readTranscriptForLoad } from '../../../src/opencc-src/utils/sessionStoragePortable.js'

function writeTranscript(lines: unknown[]): { file: string; size: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cp-boundary-'))
  const file = join(dir, 'a.jsonl')
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  writeFileSync(file, body)
  return { file, size: Buffer.byteLength(body) }
}

/** pre-boundary history that must be dropped on a truncating load. */
const STALE = [
  { uuid: 'm1', type: 'user', timestamp: 1, message: { content: 'stale', role: 'user' } },
  { uuid: 'm2', type: 'assistant', timestamp: 2, message: { content: 'stale', role: 'assistant' } },
]

/** boundary + summary + the two preserved messages, in vendor layout. */
const PRESERVED_TAIL = [
  {
    uuid: 'b1',
    parentUuid: 'k2',
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: 3,
    compactMetadata: {
      trigger: 'manual',
      preTokens: 0,
      messagesSummarized: 2,
      preservedSegment: { headUuid: 'k1', anchorUuid: 's1', tailUuid: 'k2' },
    },
  },
  { uuid: 's1', parentUuid: 'b1', type: 'assistant', timestamp: 4, message: { content: 'SUMMARY', role: 'assistant' } },
  { uuid: 'k1', parentUuid: 's1', type: 'assistant', timestamp: 5, message: { content: 'kept-1', role: 'assistant' } },
  { uuid: 'k2', parentUuid: 'k1', type: 'user', timestamp: 6, message: { content: 'kept-2', role: 'user' } },
]

describe('compact boundary shape', () => {
  it('vendor shape (system + compact_boundary + preservedSegment) is recognised as a preserved segment', async () => {
    const { file, size } = writeTranscript([...STALE, ...PRESERVED_TAIL])
    const r = await readTranscriptForLoad(file, size)

    // The whole point: vendor sees a preserved segment, so it must NOT
    // truncate at the boundary (offset stays 0 and the summary + kept
    // messages survive into the loaded buffer).
    expect(r.hasPreservedSegment).toBe(true)
    expect(r.boundaryStartOffset).toBe(0)

    const loaded = r.postBoundaryBuf.toString('utf8')
    expect(loaded).toContain('SUMMARY')
    expect(loaded).toContain('kept-1')
    expect(loaded).toContain('kept-2')
  })

  it('legacy shape (type=compact_boundary, no subtype) is NOT recognised — kept as a regression contrast', async () => {
    const { file, size } = writeTranscript([
      ...STALE,
      { uuid: 'b1', parentUuid: 'k2', type: 'compact_boundary', timestamp: 3 },
      { uuid: 's1', parentUuid: 'b1', type: 'assistant', timestamp: 4, message: { content: 'SUMMARY', role: 'assistant' } },
      { uuid: 'k2', parentUuid: 's1', type: 'user', timestamp: 6, message: { content: 'kept-2', role: 'user' } },
    ])
    const r = await readTranscriptForLoad(file, size)

    // Documents the old failure mode: without the vendor shape the loader
    // cannot see a preserved segment. This is what P1.5 fixes on the zai side.
    expect(r.hasPreservedSegment).toBe(false)
  })
})
