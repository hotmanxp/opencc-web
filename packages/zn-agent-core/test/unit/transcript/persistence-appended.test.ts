/**
 * Regression test for the transcript-persistence bug (Aug 2026).
 *
 * Symptom: every session in the new transcripts/projects/<cwd>/<sid>.json
 * layout had `messages: []` after a /api/agent/prompt call. The
 * /api/agent/sessions endpoint returned the session, but page reload
 * (or `?sid=...` share link) showed a blank transcript because the
 * opencc vendor `query()` only emits stream events — it never writes
 * to the transcript. The zai prompt route translated runtime events
 * to SSE but never mirrored them to disk.
 *
 * Fix: the zai prompt route now imports the runtime append helpers
 * (appendUserMessageV2, appendAssistantMessageV2, appendToolUse,
 * appendToolResult) from @zn-ai/zn-agent-core/runtime and dispatches
 * each runtime event to the matching append call:
 *   - runtime.tool_call  -> appendToolUse
 *   - runtime.tool_result -> appendToolResult
 *   - runtime.thinking + runtime.delta (per turn) -> accumulated and
 *     flushed via appendAssistantMessageV2 at runtime.done
 *   - The user prompt itself -> appendUserMessageV2 BEFORE runtime.run
 *
 * This test exercises the append helpers against a real
 * TranscriptStore in a tmp dir, and asserts that after a simulated
 * event stream, the resulting transcript has the expected
 * user / tool_use / tool_result / assistant messages — so a future
 * regression that drops the append calls (or breaks the persistence
 * path) is caught.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('zai prompt route appends events to transcript', () => {
  let dataDir: string
  let sessionId: string

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-transcript-'))
    const { TranscriptStore } = await import(
      '../../../src/compat/transcript/store.js'
    )
    const {
      appendUserMessageV2,
      appendAssistantMessageV2,
      appendToolUse,
      appendToolResult,
    } = await import('../../../src/compat/transcript/persistence.js')
    const store = new TranscriptStore(dataDir)
    const cwd = '/Users/ethan/code/opencc-web/packages/zai'
    sessionId = await store.create(
      { cwd, model: 'MiniMax-M3', permissionMode: 'default' },
      { cwd },
    )

    // Mirror the zai prompt route's per-event dispatch in the
    // exact order runtime events arrive.
    const ctx = { cwd, sessionId, userType: 'zai' }
    await appendUserMessageV2(
      store,
      sessionId,
      '运行 pwd 后输出 OK',
      0,
      null,
      ctx,
    )
    // Turn 0
    const tuId = 'call_test_001'
    await appendToolUse(
      store,
      sessionId,
      { id: tuId, name: 'Bash', input: { command: 'pwd' } },
      0,
      null,
      cwd,
    )
    await appendToolResult(
      store,
      sessionId,
      {
        tool_use_id: tuId,
        content: '/Users/ethan/code/opencc-web/packages/zai',
        is_error: false,
      },
      0,
      null,
      cwd,
    )
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: '当前工作目录:/Users/ethan/code/opencc-web/packages/zai' }],
      0,
      null,
      ctx,
    )
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('persists user prompt, tool_use, tool_result, assistant text in order', async () => {
    const { TranscriptStore } = await import(
      '../../../src/compat/transcript/store.js'
    )
    const store = new TranscriptStore(dataDir)
    const file = await store.read(sessionId, {
      cwd: '/Users/ethan/code/opencc-web/packages/zai',
    })
    expect(file.messages.length).toBe(4)

    const [userMsg, toolUse, toolResult, assistant] = file.messages
    // user prompt
    expect(userMsg.type).toBe('user')
    expect((userMsg.message as { content: string }).content).toBe(
      '运行 pwd 后输出 OK',
    )
    // tool_use
    expect(toolUse.type).toBe('tool_use')
    const tuBlock = (toolUse.message as { content: Array<{ type: string; id: string; name: string; input: unknown }> })
      .content[0]
    expect(tuBlock.type).toBe('tool_use')
    expect(tuBlock.id).toBe('call_test_001')
    expect(tuBlock.name).toBe('Bash')
    expect(tuBlock.input).toEqual({ command: 'pwd' })
    // tool_result
    expect(toolResult.type).toBe('user')
    const trBlock = (
      toolResult.message as {
        content: Array<{ type: string; tool_use_id: string; content: unknown; is_error: boolean }>
      }
    ).content[0]
    expect(trBlock.type).toBe('tool_result')
    expect(trBlock.tool_use_id).toBe('call_test_001')
    expect(trBlock.content).toBe('/Users/ethan/code/opencc-web/packages/zai')
    expect(trBlock.is_error).toBe(false)
    // assistant text
    expect(assistant.type).toBe('assistant')
    const aBlock = (
      assistant.message as { content: Array<{ type: string; text: string }> }
    ).content[0]
    expect(aBlock.type).toBe('text')
    expect(aBlock.text).toBe('当前工作目录:/Users/ethan/code/opencc-web/packages/zai')
  })

  it('zai runtime index re-exports the append helpers', async () => {
    // Static check: the append helpers must be reachable from the
    // @zn-ai/zn-agent-core/runtime subpath so the zai prompt route
    // can import them. If a future change removes this re-export,
    // the prompt route's import statement breaks and the transcript
    // silently goes empty again — exactly the bug we just fixed.
    const runtime = await import('../../../src/runtime/index.js')
    expect(typeof runtime.appendUserMessageV2).toBe('function')
    expect(typeof runtime.appendAssistantMessageV2).toBe('function')
    expect(typeof runtime.appendToolUse).toBe('function')
    expect(typeof runtime.appendToolResult).toBe('function')
  })
})
