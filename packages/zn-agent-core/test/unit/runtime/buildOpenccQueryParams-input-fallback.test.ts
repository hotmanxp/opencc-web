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

describe('buildOpenccQueryParams — empty tool_use input must throw (no fallbacks)', () => {
  it('throws when tool_use has empty input', async () => {
    await expect(
      runToolStream('Bash', [{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow(/empty input/i)
  }, 15_000)

  it('error message includes tool name and toolUseId', async () => {
    await expect(
      runToolStream('Bash', [{ role: 'user', content: 'hello' }]),
    ).rejects.toThrow(/Bash.*tu-1|sess-input.*tu-1|toolUseId=tu-1/i)
  }, 15_000)

  it('Bash with empty command throws (does not substitute pwd)', async () => {
    await expect(
      runToolStream('Bash', [{ role: 'user', content: 'check current dir' }]),
    ).rejects.toThrow(/empty input/i)
  }, 15_000)

  it('Read with empty input throws (does not substitute /dev/null and does not infer path from user prompt)', async () => {
    await expect(
      runToolStream('Read', [
        { role: 'user', content: 'Read packages/zai/src/server/index.ts line 1-20' },
      ]),
    ).rejects.toThrow(/empty input/i)
  }, 15_000)

  it('Agent with empty input throws (does not synthesize from thinking)', async () => {
    const thinking = 'Inspect startup behavior and report the relevant call path.'
    await expect(
      runToolStream('Agent', [{ role: 'user', content: 'Delegate this task' }], {
        thinking,
      }),
    ).rejects.toThrow(/empty input/i)
  }, 15_000)

  it('Glob with empty input throws', async () => {
    await expect(
      runToolStream('Glob', [{ role: 'user', content: 'find ts files' }]),
    ).rejects.toThrow(/empty input/i)
  }, 15_000)

  it('throws at message_stop when tool_use still has empty input', async () => {
    await expect(
      runToolStream('Bash', [{ role: 'user', content: 'hello' }], {
        skipContentBlockStop: true,
      }),
    ).rejects.toThrow(
      /\[buildOpenccQueryParams\] tool_use "Bash" emitted empty input.*toolUseId=tu-1/i,
    )
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
