import { describe, expect, it, vi } from 'vitest'

/**
 * Regression test for the parallel-tool-execution bug in
 * `translateCallModel` (compat/runtime/buildOpenccQueryParams.ts).
 *
 * Scenario (verified by user):
 *   1. Upstream LLM emits two parallel `tool_use` blocks in the same
 *      assistant message (e.g. Bash ls /etc/hostname + Bash whoami).
 *   2. Each tool_use streams its own `input_json_delta` fragments
 *      (Anthropic standard — one delta per tool_use, addressed by index).
 *   3. translateCallModel previously used a single `pendingToolInputJson`
 *      string that accumulated every `input_json_delta` across ALL
 *      tool_uses. On `content_block_stop` it parsed the concatenated
 *      buffer (e.g. `'{"command":"ls"}{"command":"whoami"}'`) which is
 *      invalid JSON; the catch swallowed the SyntaxError and left the
 *      tool's `input` as `{}`, which then tripped the empty-input
 *      throw at message_stop — aborting the query before opencc's
 *      StreamingToolExecutor ever ran the second (or Nth) tool_use.
 *
 * Fix: per-index accumulation via Map<index, string>, plus
 * address the tool_use block by its own index in the assistant content
 * array (not "last tool_use" via filter().at(-1)) so two parallel
 * tool_uses never cross-contaminate.
 *
 * This integration test exercises the full path: a mock model caller
 * yields two parallel tool_use blocks with valid input_json_deltas;
 * buildOpenccQueryParams must accumulate them independently and yield
 * a single terminal assistant Message with TWO tool_use blocks, each
 * carrying its own parsed input.
 */
describe('buildOpenccQueryParams — parallel tool_use blocks', () => {
  it('yields both tool_uses with independent inputs when the model streams two parallel Bash tool_use blocks', async () => {
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm-par', model: 'm' } }
      const calls = [
        { id: 'tu-1', command: 'ls /etc/hostname' },
        { id: 'tu-2', command: 'whoami' },
      ]
      for (const [index, call] of calls.entries()) {
        yield {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: 'Bash' },
        }
        yield {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ command: call.command }),
          },
        }
        yield { type: 'content_block_stop', index }
      }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      yield { type: 'message_stop' }
    }

    const { buildOpenccQueryParams } = await import(
      '../../../src/compat/runtime/buildOpenccQueryParams.js'
    )
    const params = await buildOpenccQueryParams(
      {
        prompt: { role: 'user', content: 'run both' },
        cwd: '/tmp',
        model: 'm',
        tools: [],
        sessionId: 's-par',
      },
      { modelCaller: vi.fn().mockReturnValue(stream()) as any },
    )

    const output: any[] = []
    for await (const message of params.deps!.callModel({
      messages: [{ role: 'user', content: 'run both' }],
      systemPrompt: '',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>) {
      output.push(message)
    }

    const assistant = output.find((m) => m?.type === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant?.message?.content).toEqual([
      {
        type: 'tool_use',
        id: 'tu-1',
        name: 'Bash',
        input: { command: 'ls /etc/hostname' },
      },
      {
        type: 'tool_use',
        id: 'tu-2',
        name: 'Bash',
        input: { command: 'whoami' },
      },
    ])

    // Both tool_uses should preserve the stop_reason so opencc's
    // queryLoop treats this as a tool_use turn and routes through
    // the parallel tool execution path (StreamingToolExecutor).
    expect(assistant?.message?.stop_reason).toBe('tool_use')
  }, 15_000)

  it('three parallel tool_use blocks each carry their own input', async () => {
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm-triple', model: 'm' } }
      const calls = [
        { id: 'tu-1', command: 'date' },
        { id: 'tu-2', command: 'uname -a' },
        { id: 'tu-3', command: 'pwd' },
      ]
      for (const [index, call] of calls.entries()) {
        yield {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: 'Bash' },
        }
        yield {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ command: call.command }),
          },
        }
        yield { type: 'content_block_stop', index }
      }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      yield { type: 'message_stop' }
    }

    const { buildOpenccQueryParams } = await import(
      '../../../src/compat/runtime/buildOpenccQueryParams.js'
    )
    const params = await buildOpenccQueryParams(
      {
        prompt: { role: 'user', content: 'run all three' },
        cwd: '/tmp',
        model: 'm',
        tools: [],
        sessionId: 's-triple',
      },
      { modelCaller: vi.fn().mockReturnValue(stream()) as any },
    )

    const output: any[] = []
    for await (const message of params.deps!.callModel({
      messages: [{ role: 'user', content: 'run all three' }],
      systemPrompt: '',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>) {
      output.push(message)
    }

    const assistant = output.find((m) => m?.type === 'assistant')
    expect(assistant?.message?.content).toHaveLength(3)
    expect(assistant?.message?.content[0].input).toEqual({ command: 'date' })
    expect(assistant?.message?.content[1].input).toEqual({ command: 'uname -a' })
    expect(assistant?.message?.content[2].input).toEqual({ command: 'pwd' })
  }, 15_000)
})

// The end-to-end vendor StreamingToolExecutor integration is intentionally
// not tested from this file: the vendor class transitively imports
// zustand's `createStore` (opencc-src/services/compact/compactWarningState
// .ts:8) which resolves to a different `createStore` under Node+tsx and
// crashes at module load. End-to-end coverage for the parallel-execution
// path lives in the bun-protocol integration tests, which run under Bun
// where vendor's createStore is the right one. The two tests above prove
// the root-cause fix (per-index input accumulation in translateCallModel)
// at the exact layer the bug lived at.
