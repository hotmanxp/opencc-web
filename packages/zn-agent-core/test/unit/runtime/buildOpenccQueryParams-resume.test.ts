import { describe, expect, it, vi } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { OpenccAdapterConfig } from '../../../src/compat/runtime/types.js'

// Vendor bundle load (loadAgentDefinitions → reads disk caches) can push
// a single first-run past vitest's default 5s timeout. Bump to 20s.
const TIMEOUT = 20_000

/**
 * Session continuity / resume: when `opts.transcriptId` matches an existing
 * transcript file, the bridge must preload its prior turns into
 * `params.messages` so the LLM sees the full conversation history. Without
 * this preload, every turn is single-turn and the model can't recall facts
 * from prior turns in the same session.
 */
describe('buildOpenccQueryParams — session continuity (transcript preload)', () => {
  it('preloads prior transcript turns into params.messages before the new prompt', { timeout: TIMEOUT }, async () => {
    const transcriptStore = {
      read: vi.fn().mockResolvedValue({
        version: 2,
        transcriptId: 's-test',
        meta: { cwd: '/tmp', model: 'unknown', createdAt: 1, updatedAt: 1 },
        messages: [
          {
            uuid: 'turn-1-user',
            parentUuid: null,
            type: 'user',
            timestamp: 1_000,
            version: '2',
            message: { role: 'user', content: '我叫Ethan,最喜欢蓝色' },
          },
          {
            uuid: 'turn-1-asst',
            parentUuid: 'turn-1-user',
            type: 'assistant',
            timestamp: 2_000,
            version: '2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '好的,我记住了。' }],
            },
          },
        ],
      }),
    } as any

    const config: OpenccAdapterConfig = {
      modelCaller: makeNoopModelCaller(),
      transcriptStore,
    }

    const params = await buildOpenccQueryParams(
      {
        prompt: '你还记得我叫什么名字吗?最喜欢什么颜色?',
        cwd: '/tmp',
        transcriptId: 's-test',
        sessionId: 's-test',
        model: 'm',
        tools: [],
      },
      config,
    )

    // The preloaded user + assistant turns come first, then the new user
    // prompt lands at the tail of the messages array. The LLM now sees
    // the full conversation context, not just the current turn.
    const messages = params.messages as Array<{ type: string; message: { role: string; content: unknown } }>
    expect(messages).toHaveLength(3)
    expect(messages[0].message.role).toBe('user')
    expect(messages[0].message.content).toBe('我叫Ethan,最喜欢蓝色')
    expect(messages[1].message.role).toBe('assistant')
    expect(messages[2].message.role).toBe('user')
    expect(messages[2].message.content).toBe('你还记得我叫什么名字吗?最喜欢什么颜色?')

    // Stable uuids from the transcript are reused so subsequent resumes
    // reference the same wire-id.
    expect((messages[0] as any).uuid).toBe('turn-1-user')
    expect((messages[1] as any).uuid).toBe('turn-1-asst')
  })

  it('falls through to single-turn behavior when transcriptStore is not wired', { timeout: TIMEOUT }, async () => {
    const params = await buildOpenccQueryParams(
      {
        prompt: 'first turn',
        cwd: '/tmp',
        transcriptId: 's-test',
        sessionId: 's-test',
        model: 'm',
        tools: [],
      },
      { modelCaller: makeNoopModelCaller() },
    )

    const messages = params.messages as Array<{ message: { content: unknown } }>
    expect(messages).toHaveLength(1)
    expect(messages[0].message.content).toBe('first turn')
  })

  it('falls through to single-turn behavior when transcript file does not exist', { timeout: TIMEOUT }, async () => {
    const transcriptStore = {
      read: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    } as any

    const params = await buildOpenccQueryParams(
      {
        prompt: 'first turn',
        cwd: '/tmp',
        transcriptId: 's-test',
        sessionId: 's-test',
        model: 'm',
        tools: [],
      },
      {
        modelCaller: makeNoopModelCaller(),
        transcriptStore,
      },
    )

    const messages = params.messages as Array<{ message: { content: unknown } }>
    expect(messages).toHaveLength(1)
    expect(messages[0].message.content).toBe('first turn')
  })
})

// A ModelCaller that returns an empty async generator. The tests above never
// actually invoke `deps.callModel` — they only inspect `params.messages` —
// but `buildOpenccQueryParams` requires the field to satisfy its optional
// modelCaller wiring.
function makeNoopModelCaller(): any {
  return () => (async function* () { /* no events */ })()
}