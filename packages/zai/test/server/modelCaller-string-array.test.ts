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

  it('joins string[] sections with double newlines and drops the boundary marker', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    await callOnce(mc, [
      'section A',
      '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      'section B',
    ])
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    const text = args.system[0].text

    // Critical: boundary marker must NOT appear (it is an internal placeholder).
    expect(text).not.toContain('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    // Critical: must NOT be quoted. Old code wrapped each section in literal
    // double-quotes via JSON.stringify.
    expect(text).not.toMatch(/"section A"/)
    expect(text).not.toMatch(/"section B"/)
    // Critical: must NOT contain escaped \n (\n literal in the string),
    // which was the second artifact of JSON.stringify.
    expect(text).not.toContain('\\n')
    // Sections preserved, in order, joined with double newline.
    expect(text).toBe('section A\n\nsection B')
  })

  it('preserves embedded newlines inside a string[] section (does not collapse them)', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    await callOnce(mc, ['line1\nline2', 'next'])
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    const text = args.system[0].text
    expect(text).toBe('line1\nline2\n\nnext')
  })

  it('handles an empty string[] without crashing', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    await callOnce(mc, [])
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    expect(args.system[0].text).toBe('')
  })

  it('still JSON.stringifies each block in the legacy structured-block path', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    // Non-string entries force the third branch — preserve old behaviour.
    const structured = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]
    await callOnce(mc, structured)
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    // Each block individually JSON.stringify'd, joined with single \n.
    expect(args.system[0].text).toBe(
      `${JSON.stringify({ type: 'text', text: 'hello' })}\n${JSON.stringify({ type: 'text', text: 'world' })}`,
    )
  })

  it('coerces a mixed (string + object) array back through the legacy structured path', async () => {
    capturedCreateArgs.length = 0
    const mc = createAnthropicModelCaller()
    // Mixed types → `every(s => typeof s === 'string')` is false → falls
    // through to the legacy JSON.stringify branch.
    const mixed = ['section A', { type: 'text', text: 'B' }]
    await callOnce(mc, mixed)
    const args = capturedCreateArgs[0] as AnthropicCreateArgs
    // Both entries should be JSON-quoted by the legacy branch.
    expect(args.system[0].text).toBe(
      `${JSON.stringify('section A')}\n${JSON.stringify({ type: 'text', text: 'B' })}`,
    )
  })
})
