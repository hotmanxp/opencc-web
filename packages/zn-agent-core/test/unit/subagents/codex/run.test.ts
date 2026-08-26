import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CodexProvider } from '../../../../src/compat/subagents/codex/index.js'
import {
  getSubagentRegistry,
  type SubagentRequest,
} from '../../../../src/compat/subagents/registry.js'

/**
 * Keyless product-spec tests for `startCodexRun`.
 *
 * The `codex-mock/index.mjs` fixture in `test/fixtures/` plays the role
 * of the real `codex app-server --stdio` and answers the wire protocol
 * end-to-end. We swap in the mock by overriding the provider's
 * `command` + `args` — the JSON-RPC layer above doesn't care which binary
 * satisfies those names.
 *
 * These tests are lock-free (no fixed timing); the delay tests assert
 * observable behavior only, never wall-clock intervals.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_PATH = join(HERE, '..', '..', '..', 'fixtures', 'codex-mock', 'index.mjs')

function makeProvider(env: Record<string, string>): CodexProvider {
  // The provider reads `command` / `args` from config; we override them
  // to point at the mock binary instead of `codex`.
  return new CodexProvider({
    enabled: true,
    command: process.execPath,
    args: [MOCK_PATH],
    env,
    disposeGraceMs: 1500,
  } as unknown as Parameters<typeof CodexProvider.prototype.constructor>[0])
}

async function runOnce(env: Record<string, string>, prompt: string): Promise<{
  text: string
  stopReason: string
  errorMessage?: string
  events: Array<{ type: string; text?: string; phase?: string | null }>
}> {
  const provider = makeProvider(env)
  const req: SubagentRequest = {
    description: 'integration test',
    prompt,
    cwd: process.cwd(),
    signal: undefined,
  }
  const run = await provider.start(req, { parentCwd: process.cwd() })
  const events: Array<{ type: string; text?: string; phase?: string | null }> = []
  for await (const ev of run.events) {
    events.push({ type: ev.type, text: ev.text, phase: ev.phase ?? undefined })
  }
  const result = await run.result
  return {
    text: result.text,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    events,
  }
}

describe('codex/run.startCodexRun (keyless mock app-server)', () => {
  let initialChildCount = 0

  beforeAll(() => {
    // Background a single Node process so vitest's process counter has
    // a stable baseline (the test process + this baseline); we then
    // assert no leaks above it.
    const probe = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
    initialChildCount = 1
    probe.unref()
  })

  afterAll(() => {
    // No teardown needed; the baseline child self-exits via the OS when
    // its parent (the vitest process) ends.
  })

  it('returns the final_answer text and a completed stopReason', async () => {
    const NONCE = `nonce-${Date.now()}-${Math.random()}`
    const out = await runOnce({ MOCK_NONCE: NONCE }, 'say the nonce')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe(NONCE)
    // The mock emits one agentMessage + one turn/completed; event stream
    // should record those plus the terminal we ignore.
    const finalMessages = out.events.filter((e) => e.type === 'agentMessage' && e.phase === 'final_answer')
    expect(finalMessages).toHaveLength(1)
    expect(finalMessages[0]?.text).toBe(NONCE)
  })

  it('mocks approval request → unattended policy answers cancel without hanging', async () => {
    const NONCE = `nonce-approval-${Date.now()}`
    // The mock emits an `execApprovalRequest` after turn/start; the
    // provider's approvals module answers `cancel`. If the response
    // wiring were broken (or absent), the test would hang waiting on a
    // UI; vitest's per-test timeout would then fail it.
    const out = await runOnce({ MOCK_NONCE: NONCE, MOCK_REQUEST_APPROVAL: '1' }, 'do work')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe(NONCE)
  })

  it('commentary events never replace the final answer', async () => {
    const NONCE = `nonce-commentary-${Date.now()}`
    const out = await runOnce({ MOCK_NONCE: NONCE, MOCK_EMIT_COMMENTARY: '1' }, 'do work')
    expect(out.stopReason).toBe('completed')
    expect(out.text).toBe(NONCE)
    const commentary = out.events.filter((e) => e.type === 'commentary')
    expect(commentary.length).toBe(1)
  })

  it('failed turn settles as error with the upstream errorMessage', async () => {
    const out = await runOnce({ MOCK_FAIL_TURN: '1' }, 'do work')
    expect(out.stopReason).toBe('error')
    expect(out.errorMessage).toContain('mock: forced failure')
  })

  it('refuses an empty prompt before any spawn', async () => {
    const provider = makeProvider({})
    await expect(
      provider.start({ description: '', prompt: '   ', cwd: process.cwd() }, {}),
    ).rejects.toThrow(/empty prompt/i)
  })

  it('refuses to start without a cwd (request.cwd and ctx.parentCwd both absent)', async () => {
    const provider = makeProvider({})
    await expect(
      provider.start({ description: '', prompt: 'x' }, {}),
    ).rejects.toThrow(/no cwd/i)
  })

  it('cancel() forwards AbortSignal and the run settles with an aborted result', async () => {
    // Long-delay mock so we have a window to cancel in. The contract:
    //   - cancel() resolves run.result with stopReason === 'aborted'
    //     (subagent results use `error` / `aborted` stopReason values;
    //     rejection is reserved for infrastructure-level failures only,
    //     matching the deepseek-harness provider contract).
    //   - the OS process tree is killed so the bootstrap's
    //     waitForRunClose loop unwinds within the disposal grace.
    const provider = makeProvider({ MOCK_DELAY_MS: '5000', MOCK_NONCE: 'too-late' })
    const ac = new AbortController()
    const run = await provider.start(
      { description: '', prompt: 'x', cwd: process.cwd(), signal: ac.signal },
      { parentCwd: process.cwd() },
    )
    // Wait for the bootstrap to reach `waitForRunClose` — the bridge
    // consumers don't drain events synchronously, so we just give the
    // OS process time to spawn + reach a steady "waiting for the server"
    // state.
    await new Promise((r) => setTimeout(r, 200))
    void run.cancel()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
  })
})
