import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import { TranscriptStore } from '../../src/transcript/store.js'
import {
  appendAssistantMessageV2,
  appendToolResult,
  appendToolUse,
  appendUserMessageV2,
} from '../../src/transcript/persistence.js'
import type { ModelCaller } from '../../src/runtime/types.js'

/**
 * Regression: SubagentNotifier 注入 <task-notification> 时,queryLoop 续传父
 * session 的 transcript,如果父 transcript 末尾留有 tool_use(Agent) +
 * tool_result(<subagent_dispatched>) 这种形状,resume 把它们喂给 modelCaller
 * 时会触发 Anthropic 400 / 2013 "invalid params, tool call id is invalid"。
 *
 * 复现条件:
 *   父 transcript:[user(p1), assistant(text), tool_use(Agent), tool_result]
 *   SubagentNotifier 注入 prompt: <task-notification>...</task-notification>
 *   queryLoop resume 该 transcriptId 并把 task-notification 追加为新 user.
 *
 * 期望:model 看到的 messages 必须是合法 Anthropic 形状 — 不能出现
 *   (1) orphan tool_result:tool_use_id 不在前序任何 assistant(tool_use) 里
 *   (2) tool_use 块被丢,只剩 tool_result 块
 *   (3) tool_use 块与 tool_result 块被拆到不连续的 user 消息之间
 *
 * 测试:在 modelCaller 上截 req.messages,验证 task-notification 之前的
 * 最后一条 assistant(tool_use) 后紧跟且仅跟一条 user(tool_result) ——
 * 不能在前或后插入任何 user 消息。
 */

async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const e of g) out.push(e)
  return out
}

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-subagent-2013-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('queryLoop resume — SubagentNotifier inject after AgentTool dispatch', () => {
  it('preserves Agent tool_use ↔ <subagent_dispatched> pairing when resuming for task-notification', async () => {
    const store = new TranscriptStore(tmpDir)
    const sessionId = await store.create({ cwd: '/x', model: 'm' })

    // 1) 父 session 起始 user prompt
    const userUuid = await appendUserMessageV2(
      store, sessionId, 'dispatch a sub-agent', 0, null, { cwd: '/x', sessionId },
    )

    // 2) 父 assistant turn: text + 一个 Agent tool_use (并行结构,模拟真实场景)
    const assistantUuid = await appendAssistantMessageV2(
      store, sessionId,
      [{ type: 'text', text: 'dispatching...' }],
      0, userUuid, { cwd: '/x', sessionId },
    )

    // 3) Agent 工具调用(appendToolUse 顶层,parentUuid=assistant)
    const agentToolUseId = 'toolu_agent_001'
    const tuAUuid = await appendToolUse(
      store, sessionId,
      { id: agentToolUseId, name: 'Agent', input: { prompt: 'do sub thing', subagent_type: 'general-purpose' } },
      0, assistantUuid!, '/x',
    )

    // 4) Agent tool_result(背景模式下立即返回 <subagent_dispatched>)
    await appendToolResult(
      store, sessionId,
      {
        tool_use_id: agentToolUseId,
        content: '<subagent_dispatched agent_type="general-purpose" task_id="task-001">后台 Agent 已派发</subagent_dispatched>',
        is_error: false,
      },
      0, tuAUuid!, '/x',
    )

    // 5) SubagentNotifier 触发续传:截获发给 modelCaller 的 messages
    const seen: Array<{ role: string; content: unknown }> = []
    const captureCaller: ModelCaller = (async function* (req: any) {
      seen.push(...req.messages)
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ack' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as ModelCaller

    // 关键: isMetaPrompt: true 模拟 SubagentNotifier 注入路径
    await collect(
      queryLoop(
        {
          prompt: '<task-notification>\n<task-id>task-001</task-id>\n<status>completed</status>\n<summary>Sub-agent completed</summary>\n</task-notification>',
          cwd: '/x',
          transcriptId: sessionId,
          isMetaPrompt: true,
        },
        { dataDir: tmpDir, modelCaller: captureCaller },
      ),
    )

    // === 断言 1: agent tool_use_id 必须出现在某条 assistant.content 里 ===
    const allAssistantToolIds = new Set<string>()
    for (const m of seen) {
      if (m.role !== 'assistant') continue
      const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; id?: string }>) : []
      for (const b of blocks) if (b.type === 'tool_use' && b.id) allAssistantToolIds.add(b.id)
    }
    expect(allAssistantToolIds.has(agentToolUseId)).toBe(true)

    // === 断言 2: 每条 tool_result 的 tool_use_id 都必须出现在某条前序 assistant(tool_use) 里 ===
    //            (Anthropic 2013 的精确触发条件:orphan tool_result)
    const assistantToolIdsInOrder: string[] = []
    for (const m of seen) {
      if (m.role !== 'assistant') continue
      const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; id?: string }>) : []
      for (const b of blocks) if (b.type === 'tool_use' && b.id) assistantToolIdsInOrder.push(b.id)
    }
    expect(assistantToolIdsInOrder).toContain(agentToolUseId)

    for (const m of seen) {
      if (m.role !== 'user') continue
      const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; tool_use_id?: string }>) : []
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          expect(
            assistantToolIdsInOrder,
            `orphan tool_result: ${b.tool_use_id} not in any preceding assistant(tool_use)`,
          ).toContain(b.tool_use_id)
        }
      }
    }

    // === 断言 3: 必须严格 user/assistant 交替 (Anthropic 协议要求) ===
    let prevRole: string | null = null
    for (const m of seen) {
      expect(m.role).not.toBe(prevRole)
      prevRole = m.role
    }

    // === 断言 4: 最后一条带 tool_use 的 assistant 之后必须是且仅有一条 user(tool_result),
    //            然后才能是 task-notification user 消息 ===
    const lastAssistantIdx = (() => {
      for (let i = seen.length - 1; i >= 0; i--) {
        if (seen[i]!.role !== 'assistant') continue
        const blocks = Array.isArray(seen[i]!.content)
          ? (seen[i]!.content as Array<{ type?: string }>)
          : []
        if (blocks.some(b => b.type === 'tool_use')) return i
      }
      return -1
    })()
    expect(lastAssistantIdx).toBeGreaterThanOrEqual(0)

    const next = seen[lastAssistantIdx + 1]
    expect(next?.role).toBe('user')
    const nextBlocks = Array.isArray(next?.content)
      ? (next!.content as Array<{ type?: string; tool_use_id?: string }>)
      : []
    const toolResultIds = nextBlocks
      .filter(b => b.type === 'tool_result')
      .map(b => b.tool_use_id)
    expect(toolResultIds).toContain(agentToolUseId)

    // === 断言 5: task-notification 必须出现在 messages 末尾(最后一条 user) ===
    const lastMsg = seen[seen.length - 1]
    expect(lastMsg?.role).toBe('user')
    const lastContent = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg?.content)
    expect(lastContent).toContain('<task-notification>')
  })

  it('does not merge when previous user has no tool_result (text-only chain stays strict alternation)', async () => {
    // 边界:父 transcript 末尾是 user(text) 而不是 user(tool_result),新增
    // prompt 不应触发合并 — mergeTrailingUserMessage 是 no-op,留给后续 turn
    // 让 model 自己处理 user → assistant 交替。
    const store = new TranscriptStore(tmpDir)
    const sessionId = await store.create({ cwd: '/x', model: 'm' })

    const userUuid = await appendUserMessageV2(
      store, sessionId, 'first prompt', 0, null, { cwd: '/x', sessionId },
    )
    const assistantUuid = await appendAssistantMessageV2(
      store, sessionId, [{ type: 'text', text: 'first reply' }],
      0, userUuid, { cwd: '/x', sessionId },
    )
    // 用户追问 — parentUuid 是 assistant 的 uuid,保持 parentUuid 链连贯
    await appendUserMessageV2(
      store, sessionId, 'follow up question', 0, assistantUuid, { cwd: '/x', sessionId },
    )

    const seen: Array<{ role: string; content: unknown }> = []
    const captureCaller: ModelCaller = (async function* (req: any) {
      seen.push(...req.messages)
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'message_stop' }
    }) as ModelCaller

    await collect(
      queryLoop(
        { prompt: 'another follow up', cwd: '/x', transcriptId: sessionId },
        { dataDir: tmpDir, modelCaller: captureCaller },
      ),
    )

    // transcript 加载后 messages 含 user → assistant → user,加新 prompt 得到 4 条
    // (最后一条 user 是 "another follow up")。mergeTrailingUserMessage 因 prev
    // user 不带 tool_result 而 no-op,保留 4 条 user/assistant 交替。
    expect(seen).toHaveLength(4)
    const lastMsg = seen[seen.length - 1]
    expect(lastMsg?.role).toBe('user')
    const lastContent = typeof lastMsg?.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg?.content)
    expect(lastContent).toContain('another follow up')
  })
})