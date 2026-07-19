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
      '/x',
    )
    const t = await store.read(sessionId)
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].type).toBe('tool_use')
    expect((t.messages[0].message.content as any)[0]).toMatchObject({
      id: 'tu_1',
      name: 'Bash',
    })
    // M1: persisted tool_use v2 message must carry real cwd (not '').
    expect(t.messages[0].cwd).toBe('/x')
  })

  it('appendToolResult stores type=user with tool_result block, is_error preserved', async () => {
    await appendToolUse(
      store,
      sessionId,
      { id: 'tu_1', name: 'Bash', input: {} },
      0,
      null,
      '/x',
    )
    const tuUuid = (await store.read(sessionId)).messages[0].uuid
    await appendToolResult(
      store,
      sessionId,
      { tool_use_id: 'tu_1', content: 'err', is_error: true },
      0,
      tuUuid,
      '/x',
    )
    const t = await store.read(sessionId)
    const tr = t.messages.find((m) => m.type === 'user')!
    expect((tr.message.content as any)[0].is_error).toBe(true)
    // M1: persisted tool_result v2 message must carry real cwd (not '').
    expect(tr.cwd).toBe('/x')
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

  // isMeta 对齐 OpenCC: SubagentNotifier 注入的 <task-notification> 等
  // 系统 user 消息带 isMeta:true. LLM 仍可见, 但前端 UI 层不渲染.
  it('appendUserMessageV2 with isMeta:true persists isMeta flag', async () => {
    await appendUserMessageV2(
      store,
      sessionId,
      '<task-notification>...</task-notification>',
      0,
      null,
      { cwd: '/x', sessionId, userType: 'zai' },
      { isMeta: true },
    )
    const t = await store.read(sessionId)
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].type).toBe('user')
    expect(t.messages[0].isMeta).toBe(true)
    expect(t.messages[0].message.content).toBe(
      '<task-notification>...</task-notification>',
    )
  })

  it('appendUserMessageV2 without isMeta omits the field (back-compat)', async () => {
    await appendUserMessageV2(
      store,
      sessionId,
      'hello user',
      0,
      null,
      { cwd: '/x', sessionId, userType: 'zai' },
    )
    const t = await store.read(sessionId)
    expect(t.messages).toHaveLength(1)
    // 字段缺省时不写入磁盘, 前端按 false 处理 — 老 transcript 兼容.
    expect(t.messages[0].isMeta).toBeUndefined()
  })

  it('appendUserMessageV2 with skill_injection is treated as isMeta', async () => {
    // 对齐 OpenCC isMeta: skill body 落盘成 user 消息, LLM 仍可见 (resume 时进 prompt),
    // 但前端 UI 通过 isMeta=true 跳过渲染 (loadTranscriptMessages).
    await appendUserMessageV2(
      store,
      sessionId,
      'skill body markdown',
      0,
      null,
      { cwd: '/x', sessionId, userType: 'zai' },
      { kind: 'skill_injection', skillName: 'foo' },
    )
    const t = await store.read(sessionId)
    expect(t.messages[0].isMeta).toBe(true)
    expect(
      (t.messages[0].message.content as string).startsWith(
        '[skill_injection:foo]',
      ),
    ).toBe(true)
  })
})
