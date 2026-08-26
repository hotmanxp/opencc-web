import { describe, it, expect } from 'vitest'
import {
  SubagentRegistry,
  SubagentError,
  type SubagentEvent,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRun,
  type SubagentContext,
} from '../../../src/compat/subagents/registry.js'

/**
 * Tests for the SubagentRegistry. We use synthetic providers — no real
 * subprocess or OS dependency — to verify the dispatch surface in
 * isolation. Provider-internal behavior (e.g. JSON-RPC shape) is covered
 * by the codex provider tests in `codex/`.
 */

function makeRecordingProvider(name: string): SubagentProvider & {
  lastRequest: SubagentRequest | null
  lastContext: SubagentContext | null
} {
  const proxy = {
    name,
    inheritsParentContext: false,
    capabilities: { noStartCapabilities: true } as const,
    lastRequest: null as SubagentRequest | null,
    lastContext: null as SubagentContext | null,
    async start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun> {
      proxy.lastRequest = req
      proxy.lastContext = ctx
      return {
        id: `${name}-run-1`,
        events: (async function* (): AsyncGenerator<SubagentEvent> {
          // No-op: a registry-level test doesn't care about provider events,
          // only that `start()` was called with the right args.
        })(),
        result: Promise.resolve<SubagentResult>({ text: 'ok', stopReason: 'completed' }),
        async cancel() {
          // no-op
        },
      }
    },
  }
  return proxy
}

describe('subagents/registry.SubagentRegistry', () => {
  it('registerProvider persists a provider retrievable by name', () => {
    const reg = new SubagentRegistry()
    const provider = makeRecordingProvider('codex')
    reg.registerProvider(provider)
    expect(reg.getProvider('codex')).toBe(provider)
    expect(reg.list()).toEqual(['codex'])
  })

  it('registerProvider throws on a duplicate name', () => {
    const reg = new SubagentRegistry()
    reg.registerProvider(makeRecordingProvider('codex'))
    expect(() => reg.registerProvider(makeRecordingProvider('codex'))).toThrowError(SubagentError)
    expect(() => reg.registerProvider(makeRecordingProvider('codex'))).toThrow(/already/)
  })

  it('the disposer returned by registerProvider unregisters idempotently', () => {
    const reg = new SubagentRegistry()
    const provider = makeRecordingProvider('codex')
    const dispose = reg.registerProvider(provider)
    expect(reg.getProvider('codex')).toBe(provider)
    dispose()
    expect(reg.getProvider('codex')).toBeUndefined()
    // Calling the disposer again is a silent no-op (matches HMR safety).
    expect(() => dispose()).not.toThrow()
  })

  it('list() returns names in insertion order', () => {
    const reg = new SubagentRegistry()
    reg.registerProvider(makeRecordingProvider('first'))
    reg.registerProvider(makeRecordingProvider('second'))
    reg.registerProvider(makeRecordingProvider('third'))
    expect(reg.list()).toEqual(['first', 'second', 'third'])
  })

  it('startProvider dispatches the named provider and forwards the request + context', async () => {
    const reg = new SubagentRegistry()
    const provider = makeRecordingProvider('codex')
    reg.registerProvider(provider)
    const ctx: SubagentContext = { parentCwd: '/tmp/run' }
    const run = await reg.startProvider(
      'codex',
      { description: 'do thing', prompt: 'say hi', cwd: '/tmp/run', signal: new AbortController().signal },
      ctx,
    )
    expect(run.id).toBe('codex-run-1')
    expect(provider.lastRequest?.description).toBe('do thing')
    expect(provider.lastRequest?.prompt).toBe('say hi')
    expect(provider.lastRequest?.cwd).toBe('/tmp/run')
    expect(provider.lastContext).toBe(ctx)
    const result = await run.result
    expect(result.text).toBe('ok')
    expect(result.stopReason).toBe('completed')
  })

  it('startProvider throws SubagentError with PROVIDER_NOT_FOUND when the name is unknown', async () => {
    const reg = new SubagentRegistry()
    await expect(reg.startProvider('nope', { description: '', prompt: '' })).rejects.toBeInstanceOf(
      SubagentError,
    )
    await expect(reg.startProvider('nope', { description: '', prompt: '' })).rejects.toThrow(
      /no provider named 'nope'/,
    )
  })

  it('startProvider throws synchronously-ish, not pending forever, for unknown names', async () => {
    // The contract: an unknown name fails the tool call with a typed error
    // the AgentTool layer can surface to the model. Long-hanging is not OK.
    const reg = new SubagentRegistry()
    let resolved = false
    try {
      await reg.startProvider('nope', { description: '', prompt: '' })
    } catch {
      resolved = true
    }
    expect(resolved).toBe(true)
  })
})
