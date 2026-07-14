import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../src/transcript/store.js'
import {
  appendAssistantMessageV2,
  appendToolResult,
  appendToolUse,
} from '../../src/transcript/persistence.js'

let dataDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-transcript-'))
  store = new TranscriptStore(dataDir)
  sessionId = await store.create({ cwd: '/x', model: 'm' })
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('persistence helpers', () => {
  it('appendToolUse stores type=tool_use with tool_use block', async () => {
    await appendToolUse(
      store,
      sessionId,
      { id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
      0,
      null,
    )
    const t = await store.read(sessionId)
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].type).toBe('tool_use')
    expect((t.messages[0].message.content as any)[0]).toMatchObject({
      id: 'tu_1',
      name: 'Bash',
    })
  })

  it('appendToolResult stores type=user with tool_result block, is_error preserved', async () => {
    await appendToolUse(
      store,
      sessionId,
      { id: 'tu_1', name: 'Bash', input: {} },
      0,
      null,
    )
    const tuUuid = (await store.read(sessionId)).messages[0].uuid
    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'tu_1', content: 'err', is_error: true },
      0,
      tuUuid,
    )
    const t = await store.read(sessionId)
    const tr = t.messages.find((m) => m.type === 'user')!
    expect((tr.message.content as any)[0].is_error).toBe(true)
  })

  it('appendAssistantMessageV2 stores multiple blocks in order', async () => {
    await appendAssistantMessageV2(
      store,
      sessionId,
      [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm' },
      ],
      0,
      null,
      { cwd: '/x', sessionId, userType: 'zai' },
    )
    const t = await store.read(sessionId)
    const content = t.messages[0].message.content as any
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('text')
    expect(content[1].type).toBe('thinking')
  })
})