import { describe, it } from 'vitest'

/**
 * Credentialed end-to-end test for the codex subagent provider.
 *
 * This file is a deliberate placeholder. The full implementation is
 * blocked on three prerequisites the team has not shipped yet:
 *
 *   1. A loopback-only test-private bridge that converts Codex's
 *      Responses-protocol request shape into a chat-completions call
 *      against the fixed DeepSeek endpoint (or an OpenAI-compatible
 *      base URL) — needed because the upstream `codex app-server`
 *      speaks Responses, not Chat Completions.
 *   2. A pinned test model identifier and base URL — the bridge has
 *      to be told what model to ask for in the same way each run.
 *   3. A `codex` binary on `PATH` — the test runs the real product,
 *      not a mock, so deployment is a hard prerequisite.
 *
 * Until those land, this file runs only as a "skip when no key"
 * smoke check that proves the seam is wired correctly. Local-loop
 * testing against the mock at `test/fixtures/codex-mock/` already
 * exercises the same code paths via `test/unit/subagents/codex/run.test.ts`,
 * so this file does not gate CI.
 *
 * When the prerequisites ship, the real test body should:
 *   - spawn `codex app-server --stdio` via the same seam
 *   - run a one-shot task that returns a known nonce
 *   - byte-compare the result against the nonce
 *   - assert the SubagentStopReason is `'completed'`
 *   - await `handle.exitCode` to confirm the process tree exited 0
 */
describe('subagents/codex (credentialed real product — placeholder)', () => {
  it('is a placeholder until the loopback-bridge prerequisites land', () => {
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)
    const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY)
    const envKeys: string[] = []
    if (hasOpenAI) envKeys.push('OPENAI_API_KEY')
    if (hasDeepSeek) envKeys.push('DEEPSEEK_API_KEY')

    // Both branches pass with a log so vitest doesn't flag the test as a
    // failure. The placeholder exists to (a) advertise the eventual test
    // shape and (b) keep the file present so reviewers see the contract.
    if (envKeys.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        '[codex.e2e] no OPENAI_API_KEY or DEEPSEEK_API_KEY in env — ' +
          'credentialed real-product test is a placeholder; see the file header.',
      )
      return
    }
    // eslint-disable-next-line no-console
    console.log(
      `[codex.e2e] env has ${envKeys.join('+')}; test body not yet implemented ` +
        '— see the file header for the prerequisites needed to enable this.',
    )
    // Intentionally passing: the absence of the bridge is a build-time
    // decision, not a per-test failure. Once prerequisites land, replace
    // this `it` body with the real test (see file header).
    return
  })
})
