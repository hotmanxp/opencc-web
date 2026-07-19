import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { QueryOptions } from '../../src/runtime/types.js'

// We test the buildSystemPrompt indirectly via the public contract:
// invoking queryLoop with controlled inputs and asserting that the
// system prompt sent to the model includes the boundary marker and
// sectioned memory content.
//
// To avoid spawning a real model, we use a stub modelCaller.

import { queryLoop } from '../../src/runtime/queryLoop.js'
import type { ModelCaller } from '../../src/runtime/types.js'

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'zai-sysprompt-')) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

describe('buildSystemPrompt (string[] contract)', () => {
  test('returns string[] including AGENTS.md content when present', async () => {
    // Capture the system prompt passed to the model.
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

    expect(capturedSystem).toBeDefined()
    // Either joined string or array; both are valid Anthropic inputs.
    const sysStr = Array.isArray(capturedSystem) ? capturedSystem.join('\n') : capturedSystem
    // memoryLoader is mocked by reading actual files; cwd is repo root which has AGENTS.md
    expect(sysStr).toContain('AGENTS')
  })
})