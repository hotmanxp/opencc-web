import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../src/transcript/store.js'
import {
  appendAssistantMessageV2,
  appendToolResult,
  appendToolUse,
  appendUserMessageV2,
  serializeForAnthropic,
} from '../../src/transcript/persistence.js'

let dataDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-resume-'))
  store = new TranscriptStore(dataDir)
  sessionId = await store.create({ cwd: '/x', model: 'm' })
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('queryEngine resume via serializeForAnthropic', () => {
  it('v2 transcript round-trips into Anthropic message shape (user + assistant + tool_use + tool_result)', async () => {
    await appendUserMessageV2(
      store,
      sessionId,
      'hello',
      0,
      null,
      { cwd: '/x', sessionId },
    )
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'ok' }],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    await appendToolUse(
      store,
      sessionId,
      { id: 'tu_1', name: 'Bash', input: {} },
      0,
      null,
      '/x',
    )
    const tuUuid = (await store.read(sessionId)).messages.at(-1)!.uuid
    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'tu_1', content: 'r', is_error: false },
      0,
      tuUuid,
      '/x',
    )

    const t = await store.read(sessionId)
    const anthropic = serializeForAnthropic(t.messages)
    // user, assistant, assistant(tool_use), user(tool_result)
    expect(anthropic).toHaveLength(4)
    expect(anthropic[0]).toEqual({ role: 'user', content: 'hello' })
    expect(anthropic[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(anthropic[2].role).toBe('assistant')
    expect((anthropic[2].content as any[])[0]).toMatchObject({
      type: 'tool_use',
      id: 'tu_1',
      name: 'Bash',
    })
    expect(anthropic[3].role).toBe('user')
    expect((anthropic[3].content as any[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      is_error: false,
    })
  })

  it('groups consecutive tool_result blocks under one user role (Anthropic protocol)', async () => {
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'go' }],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    await appendToolUse(
      store,
      sessionId,
      { id: 'tu_a', name: 'Bash', input: {} },
      0,
      null,
      '/x',
    )
    const tuAUuid = (await store.read(sessionId)).messages.at(-1)!.uuid
    await appendToolUse(
      store,
      sessionId,
      { id: 'tu_b', name: 'Bash', input: {} },
      0,
      tuAUuid,
      '/x',
    )
    const tuBUuid = (await store.read(sessionId)).messages.at(-1)!.uuid
    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'tu_a', content: 'a', is_error: false },
      0,
      tuAUuid,
      '/x',
    )
    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'tu_b', content: 'b', is_error: false },
      0,
      tuBUuid,
      '/x',
    )

    const t = await store.read(sessionId)
    const anthropic = serializeForAnthropic(t.messages)
    // assistant, assistant(tool_use), assistant(tool_use), user(2 tool_results grouped)
    expect(anthropic).toHaveLength(4)
    const last = anthropic[3]
    expect(last.role).toBe('user')
    expect((last.content as any[])).toHaveLength(2)
    expect((last.content as any[]).map((b: any) => b.tool_use_id))
      .toEqual(['tu_a', 'tu_b'])
  })

  it('preserves thinking + text blocks on assistant messages', async () => {
    await appendAssistantMessageV2(
      store,
      sessionId,
      [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
      ],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    const t = await store.read(sessionId)
    const anthropic = serializeForAnthropic(t.messages)
    expect(anthropic).toHaveLength(1)
    expect(anthropic[0].role).toBe('assistant')
    const blocks = anthropic[0].content as any[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'hmm' })
    expect(blocks[1]).toEqual({ type: 'text', text: 'answer' })
  })

  it('LegacyTranscriptError surfaces on read of v1 file (v2-aware guard catches it)', async () => {
    // Sanity check: deserializeFile rejects v1 with LegacyTranscriptError.
    const { deserializeFile } = await import('../../src/transcript/serialization.js')
    const v1Raw = JSON.stringify({ version: 1, messages: [] })
    expect(() => deserializeFile(v1Raw)).toThrow()
    try {
      deserializeFile(v1Raw)
    } catch (err) {
      expect((err as Error).name).toBe('LegacyTranscriptError')
    }
  })
})
