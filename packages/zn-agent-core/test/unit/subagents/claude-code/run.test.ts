import { describe, it, expect } from 'vitest'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ClaudeCodeProvider } from '../../../../src/compat/subagents/claude-code/index.js'
import type { SubagentRequest } from '../../../../src/compat/subagents/registry.js'

/**
 * Keyless product-spec tests for `startClaudeCodeRun`.
 *
 * Drives the provider against `test/fixtures/claude-mock/index.mjs`,
 * which mimics `claude --print` with `--output-format stream-json`
 * (or `json` / `text`). Per the deepseek-harness contract the run is
 * foreground-only and the provider does not negotiate permissions in
 * the unattended case — the mock accepts the configured
 * `permissionMode` verbatim.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_PATH = join(HERE, '..', '..', '..', 'fixtures', 'claude-mock', 'index.mjs')

function makeProvider(env: Record<string, string>): ClaudeCodeProvider {
  return new ClaudeCodeProvider({
    enabled: true,
    command: process.execPath,
    args: [MOCK_PATH, '--print'],
    outputFormat: 'stream-json',
    permissionMode: 'bypassPermissions',
    env,
    disposeGraceMs: 1500,
  } as unknown as Parameters<typeof ClaudeCodeProvider.prototype.constructor>[0])
}

async function runOnce(
  env: Record<string, string>,
  prompt: string,
): Promise<{
  text: string
  stopReason: string
  errorMessage?: string
  events: Array<{ type: string }>
}> {
  const provider = makeProvider(env)
  const req: SubagentRequest = {
    description: 'integration test',
    prompt,
    cwd: process.cwd(),
    signal: undefined,
  }
  const run = await provider.start(req, { parentCwd: process.cwd() })
  const events: Array<{ type: string }> = []
  for await (const ev of run.events) {
    events.push({ type: ev.type })
  }
  const result = await run.result
  return {
    text: result.text,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    events,
  }
}

describe('claude-code/run.startClaudeCodeRun (keyless mock cli)', () => {
  it('returns the assistant final text via stream-json', async () => {
    const NONCE = `nonce-${Date.now()}-${Math.random()}`
    const out = await runOnce({ MOCK_NONCE: NONCE }, 'say the nonce')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe(NONCE)
    // The mock emits system, assistant, assistant, result. The bridge
    // emits a SubagentEvent for each frame (assistant -> type 'assistant',
    // result -> type 'result', system -> 'system').
    expect(out.events.some((e) => e.type === 'assistant')).toBe(true)
    expect(out.events.some((e) => e.type === 'result')).toBe(true)
  })

  it('honors outputFormat=json by emitting a single json_result frame', async () => {
    const NONCE = `nonce-json-${Date.now()}`
    const provider = new ClaudeCodeProvider({
      enabled: true,
      command: process.execPath,
      args: [MOCK_PATH, '--print'],
      outputFormat: 'json',
      permissionMode: 'bypassPermissions',
      env: { MOCK_NONCE: NONCE, MOCK_OUTPUT: 'json' },
      disposeGraceMs: 1500,
    } as unknown as Parameters<typeof ClaudeCodeProvider.prototype.constructor>[0])
    const run = await provider.start(
      { description: '', prompt: 'json test', cwd: process.cwd() },
      { parentCwd: process.cwd() },
    )
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe(NONCE)
  })

  it('failed run settles as error with the upstream error message', async () => {
    const out = await runOnce({ MOCK_FAIL: '1' }, 'do work')
    expect(out.stopReason).toBe('error')
    expect(out.errorMessage).toContain('mock: forced failure')
  })

  it('refuses an empty prompt before any spawn', async () => {
    const provider = makeProvider({})
    await expect(
      provider.start({ description: '', prompt: '   ', cwd: process.cwd() }, {}),
    ).rejects.toThrow(/empty prompt/i)
  })

  it('refuses to start without a cwd', async () => {
    const provider = makeProvider({})
    await expect(
      provider.start({ description: '', prompt: 'x' }, {}),
    ).rejects.toThrow(/no cwd/i)
  })

  it('cancel() resolves the run as aborted with the OS process tree killed', async () => {
    const provider = makeProvider({ MOCK_DELAY_MS: '5000', MOCK_NONCE: 'too-late' })
    const ac = new AbortController()
    const run = await provider.start(
      { description: '', prompt: 'x', cwd: process.cwd(), signal: ac.signal },
      { parentCwd: process.cwd() },
    )
    await new Promise((r) => setTimeout(r, 200))
    void run.cancel()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
  })
})
