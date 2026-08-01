/**
 * Tests for `wrapZaiModelCallerAsCallModel` — the adapter that bridges
 * zai's `createAnthropicModelCaller` (zai-ModelCaller shape) to the
 * vendor `queryModelWithStreaming` shape that the headless `QueryEngine`
 * expects via `QueryDeps.callModel`.
 *
 * Background: the new `OpenccRuntime` runs the headless `QueryEngine`
 * with `deps.callModel` defaulting to vendor's `queryModelWithStreaming`,
 * which reads `ANTHROPIC_API_KEY` from `process.env` only. zai-server
 * uses `createAnthropicModelCaller`, which reads from
 * `~/.zai/settings.json` env / `~/.claude.json` providerProfiles, so we
 * have to inject it via `OpenccRuntimeOptions.callModel`. But the input
 * shapes differ:
 *
 *   - vendor callModel: { messages, systemPrompt, thinkingConfig, tools,
 *     signal, options: { model, fastMode, ... } }
 *   - zai ModelCaller:  { model, systemPrompt, messages, tools, signal }
 *
 * The adapter must lift `options.model` (and friends) up to the zai
 * input, and pass stream events through unchanged (zai already yields
 * vendor snake_case `StreamEvent`).
 *
 * Test-first (TDD). These tests are written BEFORE the implementation
 * and will be the gate for the green step.
 */
import { describe, expect, it } from 'vitest'
import { wrapZaiModelCallerAsCallModel } from '../../src/server/services/modelCallerAdapter.js'
import type { ModelCaller } from '@zn-ai/zn-agent-core/runtime'

// Minimal stand-in: a zai-ModelCaller that yields one pre-canned
// message_start → content_block_delta → message_stop sequence and
// records the request it received. Lets us assert the adapter
// (a) extracts `options.model` to the zai input, (b) passes the
// rest through, (c) yields the events unchanged.
function makeFakeZaiModelCaller(opts: {
  events: Array<Record<string, unknown>>
  onCall?: (req: any) => void
}): ModelCaller {
  return (async function* (req: any) {
    opts.onCall?.(req)
    for (const ev of opts.events) {
      yield ev
    }
  }) as unknown as ModelCaller
}

describe('wrapZaiModelCallerAsCallModel — zai-ModelCaller <-> vendor callModel bridge', () => {
  it('lifts options.model to the zai input and yields events unchanged', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_stop' },
    ]
    let capturedReq: any = null
    const zaiCaller = makeFakeZaiModelCaller({
      events,
      onCall: (req) => { capturedReq = req },
    })
    const wrapped = wrapZaiModelCallerAsCallModel(zaiCaller)

    const out: any[] = []
    for await (const ev of wrapped({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'sys',
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'MiniMax-M3' },
    } as any)) {
      out.push(ev)
    }

    expect(capturedReq).toBeTruthy()
    expect(capturedReq.model).toBe('MiniMax-M3')
    expect(capturedReq.systemPrompt).toBe('sys')
    expect(capturedReq.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(capturedReq.signal).toBeInstanceOf(AbortSignal)
    expect(out).toEqual(events)
  })

  it('falls back to a default model when options.model is missing', async () => {
    let capturedReq: any = null
    const zaiCaller = makeFakeZaiModelCaller({
      events: [{ type: 'message_stop' }],
      onCall: (req) => { capturedReq = req },
    })
    const wrapped = wrapZaiModelCallerAsCallModel(zaiCaller, {
      fallbackModel: 'MiniMax-M2.7-highspeed',
    })

    for await (const _ of wrapped({
      messages: [],
      systemPrompt: '',
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {},
    } as any)) { /* drain */ }

    expect(capturedReq.model).toBe('MiniMax-M2.7-highspeed')
  })

  it('forwards the abort signal so mid-stream abort tears down cleanly', async () => {
    const ac = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const zaiCaller = makeFakeZaiModelCaller({
      events: [{ type: 'message_stop' }],
      onCall: (req) => { capturedSignal = req.signal },
    })
    const wrapped = wrapZaiModelCallerAsCallModel(zaiCaller)

    for await (const _ of wrapped({
      messages: [],
      systemPrompt: '',
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: ac.signal,
      options: { model: 'MiniMax-M3' },
    } as any)) { /* drain */ }

    expect(capturedSignal).toBe(ac.signal)
  })
})
