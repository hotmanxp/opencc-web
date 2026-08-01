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

async function runToolStream(
  name: string,
  messages: unknown[],
  options: { thinking?: string; partialJson?: string } = {},
) {
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
    yield { type: 'content_block_stop', index }
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

function toolUseFrom(output: any[]) {
  return output[0]?.message?.content?.find((block: any) => block.type === 'tool_use')
}

describe('buildOpenccQueryParams missing input_json_delta fallback', () => {
  it('infers Read file_path from the most recent user prompt', async () => {
    const output = await runToolStream('Read', [
      { role: 'user', content: 'Ignore old/path.ts' },
      { role: 'assistant', content: 'Okay' },
      { role: 'user', content: 'Read packages/zai/src/server/index.ts line 1-20' },
    ])

    expect(toolUseFrom(output).input).toEqual({
      file_path: 'packages/zai/src/server/index.ts',
    })
  }, 15_000)

  it('throws input_json_delta required for WebSearch', async () => {
    await expect(runToolStream('WebSearch', [
      { role: 'user', content: 'Search the web for OpenCC' },
    ])).rejects.toThrow(/input_json_delta required.*WebSearch/i)
  })

  it('keeps Agent synthesis from the latest thinking block', async () => {
    const thinking = 'Inspect startup behavior and report the relevant call path.'
    const output = await runToolStream('Agent', [
      { role: 'user', content: 'Delegate this task' },
    ], { thinking })

    expect(toolUseFrom(output).input).toEqual({
      description: thinking,
      prompt: thinking,
      subagent_type: 'general-purpose',
    })
  })

  it('keeps the harmless Bash pwd fallback', async () => {
    const output = await runToolStream('Bash', [
      { role: 'user', content: 'Check the current directory' },
    ])

    expect(toolUseFrom(output).input).toEqual({ command: 'pwd' })
  })

  it('does not replace valid streamed tool input', async () => {
    const output = await runToolStream('Read', [
      { role: 'user', content: 'Read wrong/path.ts' },
    ], { partialJson: '{"file_path":"actual/path.ts","offset":7}' })

    expect(toolUseFrom(output).input).toEqual({
      file_path: 'actual/path.ts',
      offset: 7,
    })
  })

  it('synthesizes a recoverable tool result when no Read path can be inferred', async () => {
    const output = await runToolStream('Read', [
      { role: 'user', content: 'Read the file I meant' },
    ])

    expect(output[0]?.message?.content).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      tool_use_id: 'tu-1',
      is_error: true,
      content: expect.stringMatching(/no path could be inferred.*explicit file_path/i),
    }))
  })
})
