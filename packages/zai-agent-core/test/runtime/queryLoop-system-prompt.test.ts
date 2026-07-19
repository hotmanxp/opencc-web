import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { QueryOptions } from '../../src/runtime/types.js'

// We test the buildSystemPrompt indirectly via the public contract:
// invoking queryLoop with controlled inputs and asserting the string[]
// shape and content that flows toward the model.
//
// To avoid spawning a real model, we use a stub modelCaller and apply
// the same normalization logic the real modelCaller uses (joining + dropping
// the boundary marker) to verify the end-to-end payload the model would
// receive.

import { queryLoop } from '../../src/runtime/queryLoop.js'
import type { ModelCaller } from '../../src/runtime/types.js'

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'zai-sysprompt-')) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

// Mirrors the normalization in packages/zai/src/server/services/modelCaller.ts.
// Kept here (instead of imported) to avoid pulling the zai package's runtime
// into the zai-agent-core test surface — the constant is intentionally
// duplicated per the same package-boundary rationale.
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

function normalizeForModel(systemPrompt: unknown): string {
  if (typeof systemPrompt === 'string') return systemPrompt
  if (Array.isArray(systemPrompt) && systemPrompt.every((s) => typeof s === 'string')) {
    return (systemPrompt as string[])
      .filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
      .join('\n\n')
  }
  return (systemPrompt as Array<{ type: string }>)
    .map((b) => JSON.stringify(b))
    .join('\n')
}

describe('buildSystemPrompt (string[] contract)', () => {
  test('returns string[] with AGENTS content; normalized payload drops boundary marker', async () => {
    // Capture the system prompt passed to the (stub) modelCaller.
    let capturedSystem: string | string[] | undefined
    const caller: ModelCaller = (async function* (opts: any) {
      capturedSystem = opts.systemPrompt
      yield { type: 'message_start' }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as any

    const cwd = process.cwd()
    const stream = queryLoop(
      {
        prompt: 'hi',
        cwd,
        model: 'stub',
        enableAgentsMd: true,
      } as QueryOptions,
      {
        dataDir: tmpDir,
        modelCaller: caller,
        defaultModel: 'stub',
      } as any,
    )
    // Drain stream.
    for await (const _ of stream) { /* no-op */ }

    // --- Build-side contract (what queryLoop hands to modelCaller) ---
    expect(capturedSystem).toBeDefined()
    expect(Array.isArray(capturedSystem)).toBe(true)
    expect((capturedSystem as unknown[]).every((s) => typeof s === 'string')).toBe(true)

    // --- End-to-end contract (what the model would actually receive) ---
    // Apply the same normalization the production modelCaller applies, then
    // assert the marker is gone (it was being JSON.stringify'd before the
    // Critical fix at 813f2f2; this guards against regression).
    const sysStr = normalizeForModel(capturedSystem)
    // memoryLoader reads actual files; cwd is repo root which has AGENTS.md
    expect(sysStr).toContain('AGENTS')
    expect(sysStr).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    // Guard the historical bug: a JSON.stringify'd string[] would emit
    // literal `"..."` quotes around each section. Normalized output
    // should be plain text — no quote chars around the joined string.
    expect(sysStr.startsWith('"')).toBe(false)
    expect(sysStr.endsWith('"')).toBe(false)
  })
})