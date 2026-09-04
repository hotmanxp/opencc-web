import { describe, it, expect } from 'vitest'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  OpencodeProvider,
  opencodeSpawnArgv,
  normalizeOpencodeModelArg,
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

  it('routes bare model ids through the hardcoded providers', () => {
    const { args } = opencodeSpawnArgv('opencode', ['run', '--format', 'json'], {
      prompt: 'hi',
      model: 'glm-5.2',
    })
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'OpenPlatformOAuth2/glm-5.2',
      'hi',
    ])
  })
})

describe('opencode/run.normalizeOpencodeModelArg', () => {
  it('passes through ids that already carry a provider', () => {
    expect(normalizeOpencodeModelArg('minimax-cn/MiniMax-M3')).toBe(
      'minimax-cn/MiniMax-M3',
    )
  })

  it('routes zhiniao-* models to the pa provider', () => {
    expect(normalizeOpencodeModelArg('zhiniao-glm-5.1')).toBe('pa/zhiniao-glm-5.1')
    expect(normalizeOpencodeModelArg('zhiniao-MiniMax-M2.7')).toBe(
      'pa/zhiniao-MiniMax-M2.7',
    )
  })

  it('routes all other bare ids to OpenPlatformOAuth2', () => {
    expect(normalizeOpencodeModelArg('glm-5.2')).toBe('OpenPlatformOAuth2/glm-5.2')
    expect(normalizeOpencodeModelArg('MiniMax-M3')).toBe(
      'OpenPlatformOAuth2/MiniMax-M3',
    )
  })

  it('trims whitespace and collapses blank input to empty string', () => {
    expect(normalizeOpencodeModelArg('  glm-5.2  ')).toBe(
      'OpenPlatformOAuth2/glm-5.2',
    )
    expect(normalizeOpencodeModelArg('   ')).toBe('')
  })
})

describe('opencode/run.startOpencodeRun (keyless mock cli)', () => {
  it('returns the final answer via the text + step_finish frames', async () => {
    const NONCE = `nonce-${Date.now()}-${Math.random()}`
    const out = await runOnce({ MOCK_NONCE: NONCE }, 'say the nonce')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe(NONCE)
    // bg vocabulary (zai-bg dialect), NOT opencode-native frame names — the
    // pump's mapSubagentEventType + the SSE drawer whitelist key off these.
    expect(out.events.some((e) => e.type === 'agentMessage')).toBe(true)
    expect(out.events.some((e) => e.type === 'turnCompleted')).toBe(true)
  })

  it('projects a real two-step tool run into drawer-native events', async () => {
    const out = await runOnce({ MOCK_MODE: 'toolcall', MOCK_NONCE: 'done' }, 'whoami')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe('done')
    const types = out.events.map((e) => e.type)
    // step1: turnStarted, toolCall+toolResult pair, turnCompleted
    // (reason 'tool-calls'); step2: turnStarted, agentMessage, turnCompleted.
    expect(types).toEqual([
      'turnStarted',
      'toolCall',
      'toolResult',
      'turnCompleted',
      'turnStarted',
      'agentMessage',
      'turnCompleted',
    ])
    const toolCall = out.events.find((e) => e.type === 'toolCall')!
    expect(toolCall.raw).toEqual({
      id: 'call-mock-1',
      name: 'bash',
      input: { command: 'whoami', description: 'mock' },
    })
    // The intermediate tool-calls finish must not leak into the answer.
    expect(out.events.filter((e) => e.type === 'agentMessage')).toHaveLength(1)
  })

  it('closes the child stdin so an EOF-gated CLI does not hang', async () => {
    // Regression (2026-09-03): real `opencode run` consumes an open stdin
    // pipe as extra prompt input and blocks until EOF. The mock only emits
    // frames after stdin closes; if the provider stops calling
    // `handle.stdin.end()` after spawn, this run hangs until timeout.
    const out = await runOnce({ MOCK_WAIT_STDIN_EOF: '1', MOCK_NONCE: 'after-eof' }, 'x')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe('after-eof')
  }, 15_000)

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
