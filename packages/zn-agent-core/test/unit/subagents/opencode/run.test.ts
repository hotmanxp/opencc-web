import { describe, it, expect } from 'vitest'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  OpencodeProvider,
  opencodeSpawnArgv,
  parseOpencodeConfig,
} from '../../../../src/compat/subagents/opencode/index.js'
import type {
  SubagentRequest,
  SubagentEvent,
  SubagentStopReason,
} from '../../../../src/compat/subagents/registry.js'

/**
 * Keyless product-spec tests for `startOpencodeRun`, driven against
 * `test/fixtures/opencode-mock/index.mjs` which mimics
 * `opencode run --format json`'s newline-delimited JSON event stream.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_PATH = join(HERE, '..', '..', '..', 'fixtures', 'opencode-mock', 'index.mjs')

function makeProvider(): OpencodeProvider {
  return new OpencodeProvider(
    parseOpencodeConfig({
      enabled: true,
      command: process.execPath,
      args: [MOCK_PATH, 'run', '--format', 'json'],
      disposeGraceMs: 1500,
    }),
  )
}

async function runOnce(
  env: Record<string, string>,
  prompt: string,
  model?: string,
): Promise<{
  text: string
  stopReason: SubagentStopReason
  errorMessage?: string
  diagnostic?: string
  events: SubagentEvent[]
}> {
  const provider = makeProvider()
  const req: SubagentRequest = {
    description: 'opencode integration test',
    prompt,
    cwd: process.cwd(),
    env,
    model,
  }
  const run = await provider.start(req, { parentCwd: process.cwd() })
  const events: SubagentEvent[] = []
  for await (const ev of run.events) events.push(ev)
  const result = await run.result
  return {
    text: result.text,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    diagnostic: result.diagnostic,
    events,
  }
}

describe('opencode/wire.opencodeSpawnArgv', () => {
  it('appends the positional prompt last', () => {
    const { command, args } = opencodeSpawnArgv('opencode', ['run', '--format', 'json'], {
      prompt: 'hello world',
    })
    expect(command).toBe('opencode')
    expect(args).toEqual(['run', '--format', 'json', 'hello world'])
  })

  it('inserts -m <model> before the prompt when a model is set', () => {
    const { args } = opencodeSpawnArgv('opencode', ['run', '--format', 'json'], {
      prompt: 'hi',
      model: 'minimax-cn/MiniMax-M3',
    })
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'minimax-cn/MiniMax-M3',
      'hi',
    ])
  })
})

describe('opencode/run.startOpencodeRun (keyless mock cli)', () => {
  it('returns the final answer via the text + step_finish frames', async () => {
    const NONCE = `nonce-${Date.now()}-${Math.random()}`
    const out = await runOnce({ MOCK_NONCE: NONCE }, 'say the nonce')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe(NONCE)
    expect(out.events.some((e) => e.type === 'text')).toBe(true)
    expect(out.events.some((e) => e.type === 'step_finish')).toBe(true)
  })

  it('dedupes repeated parts and joins distinct parts', async () => {
    const out = await runOnce({ MOCK_MODE: 'multtext' }, 'multi')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe('first part (final)\nsecond part')
  })

  it('passes a stray non-JSON line through as a log event without failing', async () => {
    const out = await runOnce({ MOCK_MODE: 'garbage', MOCK_NONCE: 'ok' }, 'x')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe('ok')
    expect(out.events.some((e) => e.type === 'log')).toBe(true)
  })

  it('settles error when the step finished with reason=error', async () => {
    const out = await runOnce({ MOCK_MODE: 'fail' }, 'do work')
    expect(out.stopReason).toBe('error')
    expect(out.errorMessage).toContain('mock: forced failure')
  })

  it('settles error when a stop finished without an answer', async () => {
    const out = await runOnce({ MOCK_MODE: 'noanswer' }, 'x')
    expect(out.stopReason).toBe('error')
    expect(out.diagnostic).toMatch(/no-answer/)
  })

  it('maps a length finish to max-tokens carrying the partial answer', async () => {
    const out = await runOnce({ MOCK_MODE: 'maxtokens', MOCK_NONCE: 'partial' }, 'x')
    expect(out.stopReason).toBe('max-tokens')
    expect(out.text).toBe('partial')
  })

  it('surfaces a non-zero exit without a finish as an error (auth-hang analog)', async () => {
    const out = await runOnce({ MOCK_MODE: 'exiterr' }, 'x')
    expect(out.stopReason).toBe('error')
    expect(out.errorMessage).toMatch(/not authenticated/)
  })

  it('refuses an empty prompt before any spawn', async () => {
    const provider = makeProvider()
    await expect(
      provider.start({ description: '', prompt: '   ', cwd: process.cwd() }, {}),
    ).rejects.toThrow(/empty prompt/i)
  })

  it('refuses to start without a cwd', async () => {
    const provider = makeProvider()
    await expect(
      provider.start({ description: '', prompt: 'x' }, {}),
    ).rejects.toThrow(/no cwd/i)
  })

  it('cancel() resolves the run as aborted with the OS tree killed', async () => {
    const provider = makeProvider()
    const ac = new AbortController()
    const run = await provider.start(
      {
        description: '',
        prompt: 'x',
        cwd: process.cwd(),
        env: { MOCK_MODE: 'normal', MOCK_DELAY_MS: '6000', MOCK_NONCE: 'too-late' },
        signal: ac.signal,
      },
      { parentCwd: process.cwd() },
    )
    await new Promise((r) => setTimeout(r, 250))
    void run.cancel()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
  })
})
