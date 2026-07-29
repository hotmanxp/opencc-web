import { describe, expect, it, vi } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

const minimalOpts: QueryOptions = {
  prompt: { role: 'user', content: 'hi' },
  cwd: '/tmp',
  model: 'm',
  tools: [],
  sessionId: 's-test',
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) out.push(x)
  return out
}

describe('buildOpenccQueryParams — deps.callModel translator', () => {
  it('throws clear "not implemented" when no modelCaller is supplied', async () => {
    const params = await buildOpenccQueryParams(minimalOpts, {})
    const callModel = params.deps!.callModel as any
    await expect(callModel({ messages: [], signal: new AbortController().signal }))
      .rejects.toThrow(/deps\.callModel not implemented/)
  })

  it('translates opencc request → zai ModelCaller shape and yields events through', async () => {
    const fakeEvents = [
      { type: 'message_start', message: { id: 'm1' } },
      { type: 'content_block_start', index: 0 },
      { type: 'message_stop' },
    ]
    async function* fakeZaiStream() {
      for (const ev of fakeEvents) yield ev
    }
    const modelCaller = vi.fn().mockReturnValue(fakeZaiStream())

    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })

    const openccReq = {
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'sys',
      tools: [{ name: 'Bash' }],
      signal: new AbortController().signal,
      options: { model: 'claude-test' },
    }
    const events = await collect(params.deps!.callModel(openccReq as any) as AsyncIterable<any>)

    // zai ModelCaller was called once with the translated request
    expect(modelCaller).toHaveBeenCalledTimes(1)
    const zaiReq = modelCaller.mock.calls[0][0]
    expect(zaiReq.model).toBe('claude-test')
    expect(zaiReq.systemPrompt).toBe('sys')
    expect(zaiReq.messages).toBe(openccReq.messages)
    expect(zaiReq.tools).toBe(openccReq.tools)
    expect(zaiReq.signal).toBe(openccReq.signal)
    // thinkingConfig intentionally dropped (not in zai shape)
    expect('thinkingConfig' in zaiReq).toBe(false)

    // Events from zai stream pass through untransformed
    expect(events).toEqual(fakeEvents)
  })

  it('uses "unknown" model when openccReq.options.model is absent', async () => {
    async function* empty() { /* no events */ }
    const modelCaller = vi.fn().mockReturnValue(empty())

    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })

    await collect(params.deps!.callModel({
      messages: [],
      systemPrompt: '',
      tools: [],
      signal: new AbortController().signal,
    } as any) as AsyncIterable<any>)

    expect(modelCaller.mock.calls[0][0].model).toBe('unknown')
  })
})
