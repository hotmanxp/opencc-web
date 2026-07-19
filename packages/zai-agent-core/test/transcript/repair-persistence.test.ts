import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../src/transcript/store.js'
import {
  appendAssistantMessageV2,
  appendToolResult,
  appendToolUse,
  appendUserMessageV2,
} from '../../src/transcript/persistence.js'
import { repairAndPersistTranscript } from '../../src/transcript/repair.js'

let dataDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-repair-persist-'))
  store = new TranscriptStore(dataDir)
  sessionId = await store.create({ cwd: '/x', model: 'm' })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('repairAndPersistTranscript', () => {
  it('repairs a delayed tool_result, persists the fix, and is idempotent on a second call', async () => {
    // Build a deliberately misordered transcript: a follow-up user prompt
    // arrives BEFORE the tool_result for the preceding tool_use. The
    // repair pass must reorder them so the tool_result sits directly
    // after its tool_use, while leaving the follow-up prompt after.
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'run it' }],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    const assistantUuid = (await store.read(sessionId)).messages[0].uuid

    const toolUuid = (await appendToolUse(
      store,
      sessionId,
      { id: 'call-1', name: 'Bash', input: {} },
      0,
      assistantUuid,
      '/x',
    ))!

    await appendUserMessageV2(
      store,
      sessionId,
      'next prompt',
      1,
      toolUuid,
      { cwd: '/x', sessionId },
    )

    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'call-1', content: 'done', is_error: false },
      0,
      toolUuid,
      '/x',
    )

    const first = await repairAndPersistTranscript(store, sessionId)
    const second = await repairAndPersistTranscript(store, sessionId)
    const onDisk = await store.read(sessionId)

    expect(first.report.repaired).toBe(true)
    expect(second.report.repaired).toBe(false)
    expect(onDisk.messages).toEqual(first.messages)
  })

  it('persists reordered messages under file lock so concurrent appends do not race', async () => {
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'first' }],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    const assistantUuid = (await store.read(sessionId)).messages[0].uuid
    const toolUuid = (await appendToolUse(
      store,
      sessionId,
      { id: 'call-2', name: 'Bash', input: {} },
      0,
      assistantUuid,
      '/x',
    ))!
    await appendUserMessageV2(
      store,
      sessionId,
      'next',
      1,
      toolUuid,
      { cwd: '/x', sessionId },
    )
    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'call-2', content: 'ok', is_error: false },
      0,
      toolUuid,
      '/x',
    )

    const before = await store.read(sessionId)
    const result = await repairAndPersistTranscript(store, sessionId)
    const after = await store.read(sessionId)

    expect(before.meta.updatedAt).toBeLessThanOrEqual(after.meta.updatedAt)
    expect(result.report.repaired).toBe(true)
    expect(after.messages.map(message => message.type)).toEqual([
      'assistant',
      'tool_use',
      'user',
      'user',
    ])
    const reorderedToolResult = after.messages[2]
    expect(Array.isArray(reorderedToolResult.message?.content)).toBe(true)
    const blocks = reorderedToolResult.message?.content as Array<{ tool_use_id: string }>
    expect(blocks[0]?.tool_use_id).toBe('call-2')
  })

  it('mutateMessages returns the value supplied by the mutator without touching the file when nothing changes', async () => {
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'hi' }],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    const before = await store.read(sessionId)

    const returned = await store.mutateMessages(sessionId, messages => ({
      messages,
      changed: false,
      value: { tags: ['kept'], count: messages.length },
    }))

    expect(returned).toEqual({ tags: ['kept'], count: 1 })
    const after = await store.read(sessionId)
    expect(after.messages).toEqual(before.messages)
    expect(after.meta.updatedAt).toBe(before.meta.updatedAt)
  })
})
