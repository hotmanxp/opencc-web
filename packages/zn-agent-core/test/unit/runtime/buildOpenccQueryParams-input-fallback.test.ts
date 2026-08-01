import { describe, expect, it, vi } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

const minimalOpts: QueryOptions = {
  prompt: { role: 'user', content: 'hi' },
  cwd: '/tmp',
  model: 'm',
  tools: [],
  sessionId: 's-input-fallback',
}

/**
 * Drive `deps.callModel` with an Anthropic-style SSE stream and collect
 * the opencc assistant messages it yields. Throws are propagated up
 * (re-thrown from the for-await) so test bodies can assert with
 * `.rejects.toThrow(...)`.
 */
async function runToolStream(
  name: string,
  messages: unknown[],
  options: {
    thinking?: string
    partialJson?: string
    skipContentBlockStop?: boolean
  } = {},
): Promise<any[]> {
  async function* stream() {
    yield { type: 'message_start', message: { id: 'm1', model: 'm' } }
    let index = 0
    if (options.thinking) {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking' },
      }
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: options.thinking },
      }
      yield { type: 'content_block_stop', index }
      index++
    }
    yield {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: 'tu-1', name },
    }
    if (options.partialJson !== undefined) {
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: options.partialJson },
      }
    }
    if (!options.skipContentBlockStop) {
      yield { type: 'content_block_stop', index }
    }
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
    yield { type: 'message_stop' }
  }

  const modelCaller = vi.fn().mockReturnValue(stream())
  const params = await buildOpenccQueryParams(minimalOpts, {
    modelCaller: modelCaller as any,
  })
  const output = []
  for await (const message of params.deps!.callModel({
    messages,
    systemPrompt: '',
    tools: [],
    signal: new AbortController().signal,
    options: { model: 'm' },
  } as any) as AsyncIterable<any>) {
    output.push(message)
  }
  return output
}

describe('buildOpenccQueryParams — empty tool_use input yields with normalised {} (vendor retry)', () => {
  // Empty input no longer aborts the query. The assistant message yields
  // with `tu.input = {}` so the opencc queryLoop hands it to the tool
  // executor; vendor's `tool.inputSchema.safeParse()` fails and
  // synthesises a `<tool_use_error>InputValidationError: ...</tool_use_error>`
  // user message (see opencc-src/services/tools/toolExecution.ts:778-848)
  // which the LLM reads and uses to retry with explicit arguments on
  // the next turn.
  async function emptyInputAssistant(name: string) {
    return runToolStream(name, [{ role: 'user', content: 'hello' }])
  }

  it('does not throw when Bash tool_use has empty input', async () => {
    await expect(emptyInputAssistant('Bash')).resolves.toBeDefined()
  }, 15_000)

  it('yields an assistant message whose Bash tool_use has input normalised to {}', async () => {
    const output = await emptyInputAssistant('Bash')
    const asst = output.find((m: any) => m?.type === 'assistant')
    const tu = asst?.message?.content?.find((b: any) => b.type === 'tool_use')
    expect(tu?.id).toBe('tu-1')
    expect(tu?.name).toBe('Bash')
    expect(tu?.input).toEqual({})
  }, 15_000)

  it('does not throw for Read with empty input and a path-mentioning user prompt', async () => {
    const output = await runToolStream('Read', [
      { role: 'user', content: 'Read packages/zai/src/server/index.ts line 1-20' },
    ])
    const asst = output.find((m: any) => m?.type === 'assistant')
    const tu = asst?.message?.content?.find((b: any) => b.type === 'tool_use')
    expect(tu?.input).toEqual({})
  }, 15_000)

  it('does not synthesise input from thinking for Agent with empty input', async () => {
    const thinking = 'Inspect startup behavior and report the relevant call path.'
    const output = await runToolStream(
      'Agent',
      [{ role: 'user', content: 'Delegate this task' }],
      { thinking },
    )
    const asst = output.find((m: any) => m?.type === 'assistant')
    const tu = asst?.message?.content?.find((b: any) => b.type === 'tool_use')
    expect(tu?.input).toEqual({})
  }, 15_000)

  it('does not throw for Glob with empty input', async () => {
    const output = await emptyInputAssistant('Glob')
    const asst = output.find((m: any) => m?.type === 'assistant')
    const tu = asst?.message?.content?.find((b: any) => b.type === 'tool_use')
    expect(tu?.input).toEqual({})
  }, 15_000)

  it('normalises at message_stop when content_block_stop was skipped', async () => {
    // Observed with MiniMax-M3 proxy: content_block_stop sometimes never
    // arrives. The message_stop second-chance check must still normalise
    // empty inputs to {} so vendor validation produces the retry path.
    const output = await runToolStream('Bash', [{ role: 'user', content: 'hello' }], {
      skipContentBlockStop: true,
    })
    const asst = output.find((m: any) => m?.type === 'assistant')
    const tu = asst?.message?.content?.find((b: any) => b.type === 'tool_use')
    expect(tu?.id).toBe('tu-1')
    expect(tu?.input).toEqual({})
  }, 15_000)

  it('preserves valid input for every parallel tool_use block', async () => {
    async function* stream() {
      yield { type: 'message_start', message: { id: 'm-parallel', model: 'm' } }
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

    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: vi.fn().mockReturnValue(stream()) as any,
    })
    const output = []
    for await (const message of params.deps!.callModel({
      messages: [{ role: 'user', content: 'run both' }],
      systemPrompt: '',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>) {
      output.push(message)
    }

    const assistant = output.find((message: any) => message?.type === 'assistant')
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
  }, 15_000)

  it('does NOT throw when the upstream LLM streams valid input_json_delta', async () => {
    const output = await runToolStream(
      'Read',
      [{ role: 'user', content: 'Read wrong/path.ts' }],
      { partialJson: '{"file_path":"actual/path.ts","offset":7}' },
    )
    // translateCallModel yields stream_event wrappers for every primitive +
    // a terminal assistant Message at message_stop. The terminal assistant
    // is what carries the parsed tool_use input.
    const asst = output.find((m: any) => m?.type === 'assistant')
    const tu = asst?.message?.content?.find((b: any) => b.type === 'tool_use')
    expect(tu?.input).toEqual({ file_path: 'actual/path.ts', offset: 7 })
  }, 15_000)
})
