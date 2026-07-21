import { describe, it, expect, vi } from 'vitest'
import type { Anthropic } from '@anthropic-ai/sdk'

// Mock node:fs so the zai settings reader doesn't read the user's real
// ~/.zai/settings.json. We just need it to return a valid settings object
// with ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL so getAnthropicClient is
// happy to construct the singleton.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn((file: string) => {
      // Return a minimal but valid settings blob for any path the runtime reads.
      if (typeof file === 'string' && file.endsWith('settings.json')) {
        return JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'test-token',
            ANTHROPIC_BASE_URL: 'https://example.invalid',
          },
          model: 'MiniMax-M3',
        })
      }
      return actual.readFileSync(file)
    }),
  }
})

// Mock the Anthropic SDK so messages.create captures the args we'd send to the
// real upstream. We don't want this test to make any network call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capturedCreateArgs: any[] = []

vi.mock('@anthropic-ai/sdk', () => {
  // Minimal stub of an Anthropic Messages stream — yields just `message_stop` so
  // modelCaller's for-await + break-on-message_stop path terminates cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function* messageStopStream(this: any) {
    yield { type: 'message_stop' }
  }

  class FakeAnthropic {
    messages = {
      create: vi.fn(async (args: any) => {
        capturedCreateArgs.push(args)
        return {
          // The caller does `for await (const event of stream)`, so we need an
          // async iterable. Bind `this` so accidental SDK internals don't blow up.
          [Symbol.asyncIterator]: messageStopStream.bind(this),
        }
      }),
    }
  }

  return { default: FakeAnthropic }
})

// Import after mocks so the module reads the mocked fs/SKD.
import { createAnthropicModelCaller } from '../../src/server/services/modelCaller.js'
import type { ModelCaller } from '@zn-ai/zai-agent-core/runtime'

interface AnthropicCreateArgs {
  model: string
  max_tokens: number
  system: Array<{ type: 'text'; text: string }>
  messages: Anthropic.Messages.MessageParam[]
  tools?: Anthropic.Messages.ToolUnion[]
  stream?: boolean
}

async function callOnce(mc: ModelCaller, systemPrompt: unknown) {
  const gen = mc({
    model: 'MiniMax-M3',
    // The bug only reproduces when systemPrompt is a string[], so we cast to
    // bypass the type — exactly what `req: any` masking lets happen at runtime.
    systemPrompt: systemPrompt as never,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
  } as never)
  // Drain the generator so the messages.create call lands.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _event of gen) {
    // no-op
  }
}

describe('createAnthropicModelCaller — systemPrompt normalization', () => {
  it('passes a plain string through unchanged', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    await callOnce(mc, 'just a string')
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    expect(args.system).toEqual([{ type: 'text', text: 'just a string' }])
  })

  it('splits on the boundary marker into two text blocks (cache_control on static half)', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    await callOnce(mc, [
      'section A',
      '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      'section B',
    ])
    const args = capturedCreateArgs[0] as AnthropicCreateArgs

    // Two text blocks emitted, so Anthropic can scope prompt cache to the
    // static half via cache_control. See zai-agent-core/systemPrompt for the
    // boundary contract.
    expect(args.system).toHaveLength(2)
    // Static half: cacheable.
    expect(args.system[0]).toEqual({
      type: 'text',
      text: 'section A',
      cache_control: { type: 'ephemeral' },
    })
    // Dynamic half: stays fresh every turn.
    expect(args.system[1]).toEqual({ type: 'text', text: 'section B' })
    // Critical: boundary marker must NOT appear in either block.
    expect(args.system[0].text).not.toContain('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    expect(args.system[1].text).not.toContain('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  })

  it('preserves embedded newlines inside a string[] section (does not collapse them)', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    // No boundary marker → single text block, sections joined with \n\n.
    await callOnce(mc, ['line1\nline2', 'next'])
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    expect(args.system).toHaveLength(1)
    expect(args.system[0].text).toBe('line1\nline2\n\nnext')
  })

  it('handles an empty string[] without crashing', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    await callOnce(mc, [])
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    expect(args.system[0].text).toBe('')
  })

  it('passes legacy structured-block entries through as JSON.stringify(text) blocks', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    // Non-string entries force the third branch — preserve old shape (one
    // block per entry, JSON.stringify'd inside a { type: 'text', text }).
    const structured = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]
    await callOnce(mc, structured)
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    expect(args.system).toEqual([
      { type: 'text', text: JSON.stringify({ type: 'text', text: 'hello' }) },
      { type: 'text', text: JSON.stringify({ type: 'text', text: 'world' }) },
    ])
  })

  it('coerces a mixed (string + object) array back through the legacy structured path', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    // Mixed types → `every(s => typeof s === 'string')` is false → falls
    // through to the legacy JSON.stringify branch. Each entry becomes its
    // own text block.
    const mixed = ['section A', { type: 'text', text: 'B' }]
    await callOnce(mc, mixed)
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    expect(args.system).toEqual([
      { type: 'text', text: JSON.stringify('section A') },
      { type: 'text', text: JSON.stringify({ type: 'text', text: 'B' }) },
    ])
  })
})
