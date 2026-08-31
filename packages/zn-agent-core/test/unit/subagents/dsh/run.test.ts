import { describe, it, expect, afterEach } from 'vitest'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SubagentRegistry,
  NO_START_CAPABILITIES,
  type SubagentEvent,
  type SubagentRequest,
  type SubagentResult,
} from '../../../../src/compat/subagents/registry.js'
import { apply, DshProvider, parseDshConfig } from '../../../../src/compat/subagents/dsh/index.js'
import {
  startDshRun,
  dshSpawnArgv,
  dshChildOutcome,
  AssistantTextFold,
  type DshRunSpec,
} from '../../../../src/compat/subagents/dsh/run.js'
import { dshFailureDiagnostic } from '../../../../src/compat/subagents/dsh/invariant.js'

/**
 * Keyless loopback tests for the dsh provider against
 * `test/fixtures/dsh-mock/index.mjs` — same fixture discipline as
 * claude-code / codex (fake binary = `process.execPath` + fixture path in
 * `args`). The fixture asserts `--profile` presence, proving argv wiring.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_PATH = join(HERE, '..', '..', '..', 'fixtures', 'dsh-mock', 'index.mjs')

function baseSpec(overrides: Partial<DshRunSpec> = {}): DshRunSpec {
  const config = parseDshConfig({ enabled: true })
  return {
    command: process.execPath,
    args: [MOCK_PATH],
    profile: config.profile,
    patches: [],
    provider: config.provider,
    model: config.model,
    initializeTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
    disposeGraceMs: 500,
    ...overrides,
  }
}

function makeRequest(overrides: Partial<SubagentRequest> = {}): SubagentRequest {
  return {
    description: 'mock task',
    prompt: 'do the thing',
    ...overrides,
  }
}

const activeRuns: Array<{ cancel: () => Promise<void> }> = []

afterEach(async () => {
  while (activeRuns.length) {
    try {
      await activeRuns.pop()!.cancel()
    } catch {
      // best-effort cleanup
    }
  }
})

async function runOnce(
  request: SubagentRequest,
  specOverrides: Partial<DshRunSpec> = {},
): Promise<{ events: SubagentEvent[]; result: SubagentResult }> {
  const run = await startDshRun(request, { parentCwd: HERE }, baseSpec(specOverrides))
  activeRuns.push(run)
  const events: SubagentEvent[] = []
  for await (const ev of run.events) events.push(ev)
  const result = await run.result
  return { events, result }
}

describe('dsh provider — config & registration', () => {
  it('apply without config is a no-op (never registers)', () => {
    const registry = new SubagentRegistry()
    expect(apply(registry)).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('apply with enabled:false is a no-op', () => {
    const registry = new SubagentRegistry()
    expect(apply(registry, { enabled: false })).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('apply with enabled:true registers the dsh provider', () => {
    const registry = new SubagentRegistry()
    const dispose = apply(registry, { enabled: true })
    expect(typeof dispose).toBe('function')
    expect(registry.list()).toEqual(['dsh'])
    dispose!()
    expect(registry.list()).toEqual([])
  })

  it('advertises dsh parity capabilities: agentOptions only + route defaults', () => {
    const provider = new DshProvider(parseDshConfig({ enabled: true }))
    expect(provider.name).toBe('dsh')
    expect(provider.inheritsParentContext).toBe(false)
    expect(provider.capabilities).toEqual({
      ...NO_START_CAPABILITIES,
      agentOptions: true,
    })
    expect(provider.agentRouteDefaults).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
  })

  it('rejects relative dshHome at parse time (dsh apply parity)', () => {
    expect(() => parseDshConfig({ enabled: true, dshHome: 'relative/path' })).toThrow()
    expect(() => parseDshConfig({ enabled: true, dshHome: '/abs/path' })).not.toThrow()
  })
})

describe('dshSpawnArgv', () => {
  it('builds base args, --profile and repeated --patch args', () => {
    const { command, args } = dshSpawnArgv(
      'dsh',
      ['/launcher/path/dsh'],
      { profile: 'sdk', patches: ['/p/a.yml', '/p/b.yml'] },
    )
    expect(command).toBe('dsh')
    expect(args).toEqual([
      '/launcher/path/dsh',
      '--profile', 'sdk',
      '--patch', '/p/a.yml',
      '--patch', '/p/b.yml',
    ])
  })
})

describe('dshChildOutcome — dsh sdkChildOutcome parity', () => {
  it('maps terminal kinds like dsh (subagent-dsh-sdk/src/run.ts:147-182)', () => {
    expect(dshChildOutcome({ kind: 'completed' })).toEqual({ stopReason: 'completed' })
    expect(dshChildOutcome({ kind: 'max-tokens' })).toEqual({ stopReason: 'max-tokens' })
    expect(dshChildOutcome({ kind: 'aborted' })).toEqual({ stopReason: 'aborted' })
    expect(dshChildOutcome({ kind: 'aborted', reason: { kind: 'disposed' } })).toEqual({
      stopReason: 'aborted',
      diagnostic: dshFailureDiagnostic('session-run', 'child-disposed'),
    })
    expect(dshChildOutcome({ kind: 'blocked' })).toEqual({ stopReason: 'refusal' })
    expect(dshChildOutcome({ kind: 'error' }).diagnostic).toContain('child-error')
    expect(dshChildOutcome({ kind: 'interrupted' })).toEqual({ stopReason: 'error' })
    expect(dshChildOutcome(undefined).diagnostic).toContain('missing-terminal')
    expect(dshChildOutcome({ kind: 'weird' }).diagnostic).toContain('child-unknown')
  })
})

describe('AssistantTextFold — dsh AssistantOutputFold parity', () => {
  it('last non-empty assistant/message wins over chunks', () => {
    const fold = new AssistantTextFold()
    fold.push({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'partial ' } } })
    fold.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A' }] } } })
    fold.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B' }] } } })
    fold.push({ type: 'assistant/message', data: { message: { content: [] } } })
    expect(fold.collect()).toBe('B')
  })

  it('joins text-delta chunks when no message landed', () => {
    const fold = new AssistantTextFold()
    fold.push({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'he' } } })
    fold.push({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'llo' } } })
    expect(fold.collect()).toBe('hello')
  })
})

describe('dsh run — loopback against dsh-mock', () => {
  it('happy path: initialize → prompt → message + turn/end → idle', async () => {
    process.env.MOCK_NONCE = 'nonce-happy'
    process.env.MOCK_TURN_KIND = 'completed'
    process.env.MOCK_EMIT = 'message'
    const { events, result } = await runOnce(makeRequest())
    expect(result).toMatchObject({ text: 'nonce-happy', stopReason: 'completed' })
    // Session events are forwarded with their native type.
    expect(events.some((e) => e.type === 'assistant/message')).toBe(true)
    expect(events.some((e) => e.type === 'turn/end')).toBe(true)
  })

  it('chunks-only fold: streamed text-delta becomes the answer', async () => {
    process.env.MOCK_NONCE = 'chunky'
    process.env.MOCK_EMIT = 'chunks'
    process.env.MOCK_TURN_KIND = 'completed'
    const { result } = await runOnce(makeRequest())
    expect(result.text).toBe('hello chunky')
    expect(result.stopReason).toBe('completed')
  })

  it('max-tokens terminal maps to max-tokens stopReason', async () => {
    process.env.MOCK_NONCE = 'cut-off'
    process.env.MOCK_EMIT = 'message'
    process.env.MOCK_TURN_KIND = 'max-tokens'
    const { result } = await runOnce(makeRequest())
    expect(result.stopReason).toBe('max-tokens')
    // dsh parity: partial output survives non-completed settlements.
    expect(result.text).toBe('cut-off')
  })

  it('blocked terminal maps to refusal (dsh sdkChildOutcome parity)', async () => {
    process.env.MOCK_NONCE = 'blocked-answer'
    process.env.MOCK_TURN_KIND = 'blocked'
    const { result } = await runOnce(makeRequest())
    expect(result.stopReason).toBe('refusal')
  })

  it('no turn/end frame settles as error/missing-terminal', async () => {
    process.env.MOCK_NONCE = 'orphan'
    process.env.MOCK_TURN_KIND = 'none'
    const { result } = await runOnce(makeRequest())
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('missing-terminal')
  })

  it('transport death before idle settles as error/transport', async () => {
    process.env.MOCK_EXIT_EARLY = '1'
    const { result } = await runOnce(makeRequest())
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('transport')
    delete process.env.MOCK_EXIT_EARLY
  })

  it('session/prompt server error settles as error', async () => {
    process.env.MOCK_FAIL_PROMPT = '1'
    const { result } = await runOnce(makeRequest())
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('mock: prompt rejected')
    delete process.env.MOCK_FAIL_PROMPT
  })

  it('initialize timeout is bounded and settles as error', async () => {
    process.env.MOCK_INIT_HANG = '1'
    const { result } = await runOnce(makeRequest(), { initializeTimeoutMs: 150 })
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('initialize')
    delete process.env.MOCK_INIT_HANG
  })

  it('cancel settles aborted with the partial answer preserved', async () => {
    process.env.MOCK_NONCE = 'partial-cancel'
    process.env.MOCK_EMIT = 'message'
    process.env.MOCK_HOLD = '1' // never go idle — caller must cancel
    const run = await startDshRun(makeRequest(), { parentCwd: HERE }, baseSpec())
    const iter = run.events[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.value?.type).toBe('assistant/message')
    await iter.return?.()
    await run.cancel()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.text).toBe('partial-cancel')
    expect(result.errorMessage).toBe('cancelled by caller')
    delete process.env.MOCK_HOLD
  })

  it('subagent notifications are forwarded for SSE timeline', async () => {
    process.env.MOCK_NONCE = 'with-children'
    process.env.MOCK_TURN_KIND = 'completed'
    process.env.MOCK_EMIT_SUBAGENT = '1'
    const { events } = await runOnce(makeRequest())
    expect(events.some((e) => e.type === 'subagent_started')).toBe(true)
    expect(events.some((e) => e.type === 'subagent_finished')).toBe(true)
    delete process.env.MOCK_EMIT_SUBAGENT
  })

  it('empty prompt and missing cwd fail loud before spawn', async () => {
    await expect(
      startDshRun(makeRequest({ prompt: '  ' }), { parentCwd: HERE }, baseSpec()),
    ).rejects.toThrow(/subagent-dsh/)
    await expect(
      startDshRun(makeRequest(), {}, baseSpec()),
    ).rejects.toThrow(/no cwd/)
  })
})
