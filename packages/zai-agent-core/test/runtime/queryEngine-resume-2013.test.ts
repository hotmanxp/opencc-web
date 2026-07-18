import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryEngine } from '../../src/runtime/queryEngine.js'
import { TranscriptStore } from '../../src/transcript/store.js'
import {
  appendAssistantMessageV2,
  appendToolResult,
  appendToolUse,
  appendUserMessageV2,
} from '../../src/transcript/persistence.js'
import type { ModelCaller } from '../../src/runtime/types.js'

/**
 * Regression: Anthropic 400 error 2013 ("tool call result does not follow
 * tool call") is raised when queryEngine resumes a transcript whose assistant
 * turn emitted N parallel tool_use blocks. The previous in-memory loop in
 * queryEngine.ts folded tool_use children into the parent assistant message
 * but did NOT merge the per-tool tool_result user messages — they were left
 * as separate user messages. Anthropic protocol requires all tool_results
 * answering an assistant(tool_use_1, tool_use_2) turn to live in ONE user
 * message immediately following it. Two split user(tool_result) messages
 * produce: assistant(tool_use_X), user(tool_result_X), user(tool_result_Y)
 * which the model API rejects with 2013.
 *
 * Reference: opencc-internals/utils/messages.ts uses
 * `foldTopLevelToolUses` + `mergeAdjacentUserMessages` for this. The zai
 * inline loop was missing both pieces.
 */

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const e of g) out.push(e)
  return out
}

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-resume-2013-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('queryEngine resume — parallel tool_use Anthropic-2013 regression', () => {
  it('merges sibling tool_result user messages into ONE user message (parallel tool_use)', async () => {
    const store = new TranscriptStore(tmpDir)
    const sessionId = await store.create({ cwd: '/x', model: 'm' })

    // 1) 起始 user prompt(appendUserMessageV2 是写入 user 消息的唯一方式,
    //    store.create 只创建空 transcript)
    const userUuid = await appendUserMessageV2(
      store, sessionId, 'do two things', 0, null, { cwd: '/x', sessionId },
    )

    // 2) assistant 文本(不带 tool_use — tool_use 由 appendToolUse 单独写)
    const assistantUuid = await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'check both' }],
      0,
      userUuid,
      { cwd: '/x', sessionId },
    )

    // 3) 平行 tool_use (一个 assistant turn 调两个工具)
    const tuAUuid = await appendToolUse(
      store, sessionId,
      { id: 'call_a_1', name: 'Bash', input: { cmd: 'ls' } },
      0, assistantUuid!, '/x',
    )
    const tuBUuid = await appendToolUse(
      store, sessionId,
      { id: 'call_a_2', name: 'Bash', input: { cmd: 'pwd' } },
      0, assistantUuid!, '/x',
    )

    // 4) 每个 tool_use 各自的 tool_result(appendToolResult 一条 user 一条)
    await appendToolResult(
      store, sessionId,
      { tool_use_id: 'call_a_1', content: 'a', is_error: false },
      0, tuAUuid!, '/x',
    )
    await appendToolResult(
      store, sessionId,
      { tool_use_id: 'call_a_2', content: 'b', is_error: false },
      0, tuBUuid!, '/x',
    )

    // 5) 接下来由 queryEngine 续传:一个 mock modelCaller 截获 req.messages
    const seen: Array<{ role: string; content: unknown }> = []
    const captureCaller: ModelCaller = (async function* (req: any) {
      seen.push(...req.messages)
      yield { type: 'message_start', message: { id: 'm1' } }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as ModelCaller

    await collect(
      queryEngine(
        { prompt: '<task-notification>new</task-notification>', cwd: '/x', transcriptId: sessionId },
        { dataDir: tmpDir, modelCaller: captureCaller },
      ),
    )

    // 断言 1: 所有 tool_use_id 都出现在 assistant content 里
    const allAssistantIds = new Set<string>()
    for (const m of seen) {
      if (m.role !== 'assistant') continue
      const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; id?: string }>) : []
      for (const b of blocks) if (b.type === 'tool_use' && b.id) allAssistantIds.add(b.id)
    }
    expect(allAssistantIds.has('call_a_1')).toBe(true)
    expect(allAssistantIds.has('call_a_2')).toBe(true)

    // 断言 2: 紧跟在最后一条带 tool_use 的 assistant 之后必须是且仅有一条 user 消息
    //          包含全部 tool_result blocks(Anthropic 协议要求)
    const lastAssistantIdx = (() => {
      for (let i = seen.length - 1; i >= 0; i--) {
        if (seen[i]!.role !== 'assistant') continue
        const blocks = Array.isArray(seen[i]!.content)
          ? (seen[i]!.content as Array<{ type?: string }>)
          : []
        if (blocks.some((b) => b.type === 'tool_use')) return i
      }
      return -1
    })()
    expect(lastAssistantIdx).toBeGreaterThanOrEqual(0)
    const next = seen[lastAssistantIdx + 1]
    expect(next?.role).toBe('user')
    const nextBlocks = Array.isArray(next?.content)
      ? (next!.content as Array<{ type?: string; tool_use_id?: string }>)
      : []
    const trIds = nextBlocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
    expect(trIds).toContain('call_a_1')
    expect(trIds).toContain('call_a_2')

    // 断言 3: 不应该有"第二条独立的 tool_result-only user 消息"夹在 assistant 和
    //          task-notification 之间(那是 2013 的精确形状)
    const userMessagesBetween = seen
      .slice(lastAssistantIdx + 1, -1) // 排除最后一条 task-notification user
      .filter((m) => {
        if (m.role !== 'user') return false
        const blocks = Array.isArray(m.content)
          ? (m.content as Array<{ type?: string }>)
          : []
        return blocks.some((b) => b.type === 'tool_result')
      })
    expect(userMessagesBetween.length).toBeLessThanOrEqual(1)
  })

  it('does not silently drop orphan top-level tool_use messages (no preceding assistant)', async () => {
    // 罕见的损坏场景:appendToolUse 落盘了,但 appendAssistantMessageV2 失败
    // (silent catch). 内联旧逻辑会把孤儿 tool_use 静默丢弃 → tool_result 无主
    // → 2013。正确语义:把孤儿 tool_use 折叠成独立 assistant 消息,tool_result
    // 紧跟其后匹配。
    const store = new TranscriptStore(tmpDir)
    const sessionId = await store.create({ cwd: '/x', model: 'm' })
    const userUuid = await appendUserMessageV2(
      store, sessionId, 'do something', 0, null, { cwd: '/x', sessionId },
    )

    // 故意跳过 appendAssistantMessageV2,只 appendToolUse(模拟 silent 失败)
    const orphanTuUuid = await appendToolUse(
      store, sessionId,
      { id: 'call_orphan', name: 'Bash', input: {} },
      0, userUuid, '/x',
    )
    await appendToolResult(
      store, sessionId,
      { tool_use_id: 'call_orphan', content: 'r', is_error: false },
      0, orphanTuUuid!, '/x',
    )

    const seen: Array<{ role: string; content: unknown }> = []
    const captureCaller: ModelCaller = (async function* (req: any) {
      seen.push(...req.messages)
      yield { type: 'message_start', message: { id: 'm1' } }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as ModelCaller

    await collect(
      queryEngine(
        { prompt: 'new', cwd: '/x', transcriptId: sessionId },
        { dataDir: tmpDir, modelCaller: captureCaller },
      ),
    )

    // tool_use 必须出现在某条 assistant.content 里(孤儿被吸收成 assistant)
    const allAssistantIds = new Set<string>()
    for (const m of seen) {
      if (m.role !== 'assistant') continue
      const blocks = Array.isArray(m.content)
        ? (m.content as Array<{ type?: string; id?: string }>)
        : []
      for (const b of blocks) if (b.type === 'tool_use' && b.id) allAssistantIds.add(b.id)
    }
    expect(allAssistantIds.has('call_orphan')).toBe(true)
  })
})