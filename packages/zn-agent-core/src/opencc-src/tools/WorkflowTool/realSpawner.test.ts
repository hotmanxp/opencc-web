import { describe, expect, it, test } from 'bun:test'
import {
  buildRealSpawner,
  type RunAgentFn,
  type CreateUserMessageFn,
} from './realSpawner.js'
import type {
  LocalSpawner,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/**
 * These tests cover the spawner-resolution contract enforced by
 * buildRealSpawner. The end-to-end "run a real workflow in a real
 * worker" path is covered by:
 *   - src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts
 *     (full pipeline with a fake parent spawner)
 *   - src/tasks/LocalWorkflowTask/schedulerBridge.test.ts
 *     (worker bridge routing)
 *   - Manual TUI verification of `/opencc-bug-hunt` and `/slow-test`
 *
 * Why a separate unit test? `mock.module()` on LocalWorkflowTask
 * leaks across test files in bun, so the wiring must be exercised
 * at the boundary that this module owns — the spawner that
 * WorkflowTool hands to the task. The deps injection point on
 * buildRealSpawner lets us assert behavior without a worker.
 */

function makeToolUseCtx(
  allAgents: Array<{ agentType: string; [k: string]: unknown }> = [],
  extra: Record<string, unknown> = {},
) {
  return {
    options: { agentDefinitions: { allAgents } },
    ...extra,
  }
}

describe('buildRealSpawner', () => {
  // Regression: the legacy no-op fallback used to return
  // `{ agentId: 'pending', report: prompt }`. When runAgent can't
  // load (deps=null) the new spawner still returns a clearly
  // distinct agentId and a structured error report — never the
  // prompt string and never 'pending'.
  test('returns a non-no-op spawner when runAgent cannot load', async () => {
    const spawner = await buildRealSpawner(
      makeToolUseCtx() as never,
      undefined,
      'wf_test',
      { runAgent: null, createUserMessage: null },
    )
    const result = await spawner('the prompt', {})
    expect(result.agentId).not.toBe('pending')
    expect(result.report).not.toBe('the prompt')
    expect(result.report).toContain('Error')
  })

  // When the parent's toolUseContext has no agentDefinitions at
  // all, the spawner must surface that as a structured error report
  // (not the prompt, not 'pending'). The old no-op would have
  // returned `{ agentId: 'pending', report: prompt }` here too.
  test('returns an unknown-agentType error when agentDefinitions is empty', async () => {
    // Provide real deps so we exercise the agentType-lookup branch
    // rather than the deps-null branch.
    const fakeRunAgent: RunAgentFn = async function* () {
      // Should not be reached — the spawner should reject first
      // because the agentType lookup fails before runAgent is
      // called.
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'should not be reached' }] } }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx() as never, // empty agentDefinitions
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('the prompt', {})
    expect(result.agentId).not.toBe('pending')
    expect(result.report).not.toBe('the prompt')
    expect(result.report).toMatch(/unknown agentType/)
  })

  // Happy path: when agentDefinitions is populated and runAgent
  // yields an assistant message with text, the spawner returns
  // that text as the report. This proves the real pipeline (deps
  // injection → runAgent stream → text extraction) works end-to-end
  // at the unit level.
  test('returns the streamed assistant text as the report', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }] },
      }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      }
    }
    const fakeCreateUserMessage: CreateUserMessageFn = ({ content }) => ({
      type: 'user',
      content,
    })
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: fakeCreateUserMessage },
    )
    const result = await spawner('say hi', {})
    expect(result.agentId).toMatch(/^wf-/)
    expect(result.report).toBe('hello world')
  })

  // On a thrown error from runAgent, the spawner returns a
  // structured error report rather than rejecting. This is
  // important because the LocalWorkflowTask wrapper expects a
  // SpawnResult shape, not a Promise rejection.
  test('returns an Error report when runAgent throws', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      throw new Error('LLM exploded')
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('do thing', {})
    expect(result.agentId).toMatch(/^wf-/)
    expect(result.report).toMatch(/subagent run failed.*LLM exploded/)
  })

  // When runAgent yields no assistant text at all, the spawner
  // returns a placeholder "(empty response ...)" string. Never
  // the prompt, never an undefined.
  test('returns an empty-response placeholder when no text was streamed', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield { type: 'progress', content: 'thinking...' }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.agentId).toMatch(/^wf-/)
    expect(result.report).toBe('(empty response from subagent)')
  })

  // The agentType in opts overrides the default 'general-purpose'
  // when looking up the agent definition. The user can route a
  // specific subagent to a specialized agent (e.g. 'Explore' for
  // read-only search).
  test('routes opts.agentType to the matching AgentDefinition', async () => {
    let captured: { agentType?: string } = {}
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      const def = (opts as { agentDefinition: { agentType?: string } }).agentDefinition
      captured.agentType = def.agentType
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([
        { agentType: 'general-purpose' },
        { agentType: 'Explore' },
      ]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('find bugs', { agentType: 'Explore' })
    expect(captured.agentType).toBe('Explore')
  })

  // Regression: realSpawner MUST pass `availableTools` to runAgent.
  // runAgent() destructures `availableTools` (required) and crashes
  // with `Cannot read properties of undefined (reading 'filter')` if
  // it's missing. The crash surfaces as an error report, the
  // script's safeParse() returns null, and every agent() call in
  // opencc-bug-hunt returns 0 candidates — same end-user symptom as
  // the original no-op spawner (panel 0 total). Without this test
  // a future refactor of realSpawner can silently remove the field
  // and the unit suite stays green (the existing tests use a
  // mocked runAgent that doesn't validate the call shape).
  test('passes availableTools to runAgent (regression for availableTools=undefined crash)', async () => {
    let captured: { availableTools?: unknown } = {}
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      captured = opts as { availableTools?: unknown }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const parentTools = [{ name: 'Bash' }, { name: 'Read' }]
    // Use the helper but add `tools` to the existing options
    // (don't replace the whole options object — the agent lookup
    // would then fail and runAgent would never be called).
    const baseCtx = makeToolUseCtx([{ agentType: 'general-purpose' }])
    const ctx = {
      ...baseCtx,
      options: { ...baseCtx.options, tools: parentTools },
    }
    const spawner = await buildRealSpawner(
      ctx as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('anything', {})
    // Must be the parent's tool pool (or an empty array if the
    // parent didn't provide one). Never undefined.
    expect(captured.availableTools).toBeDefined()
    expect(captured.availableTools).toEqual(parentTools)
  })

  test('falls back to empty array when toolUseContext.options.tools is missing', async () => {
    let captured: { availableTools?: unknown } = {}
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      captured = opts as { availableTools?: unknown }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const ctx = makeToolUseCtx([{ agentType: 'general-purpose' }])
    const spawner = await buildRealSpawner(
      ctx as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('anything', {})
    expect(captured.availableTools).toEqual([])
  })

  // The real spawner accumulates token / tool counts across the
  // runAgent stream so the /workflows panel can render real numbers
  // instead of "—". tokensUsed sums input_tokens + output_tokens
  // from each assistant message's `usage` field (cache tokens
  // excluded — see comments in realSpawner.ts). toolsUsed counts
  // tool_use blocks.
  test('accumulates tokensUsed across assistant messages', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'first' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: ' second' }],
          usage: { input_tokens: 200, output_tokens: 75 },
        },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.report).toBe('first second')
    // 100+50 + 200+75 = 425
    expect(result.tokensUsed).toBe(425)
  })

  test('counts tool_use blocks as toolsUsed', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 't1', name: 'Read' },
            { type: 'tool_use', id: 't2', name: 'Bash' },
          ],
        },
      }
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: ' more' },
            { type: 'tool_use', id: 't3', name: 'Edit' },
          ],
        },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.report).toBe('thinking more')
    expect(result.toolsUsed).toBe(3)
  })

  test('returns 0 tokensUsed/toolsUsed when stream has no usage info', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'no usage' }] },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    // Counters stay at 0 (not undefined) so the UI can render
    // "0 tok · 0 tools" rather than "—". This is a deliberate
    // divergence from the SpawnResult's optional fields: a real
    // runAgent call always produces these counters, even if zero.
    expect(result.tokensUsed).toBe(0)
    expect(result.toolsUsed).toBe(0)
  })

  // Activity section: each tool_use block is captured as a
  // { name, inputSummary, at } record. The summary picks the most
  // informative field from the tool's `input` object (file_path for
  // Read, command for Bash, pattern for Grep, etc.).
  test('captures tool_use blocks as toolCalls with picked summary', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'reading source' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/src/foo.ts' } },
          ],
        },
      }
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: 'src/' } },
          ],
        },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.toolsUsed).toBe(3)
    expect(result.toolCalls).toEqual([
      { name: 'Read', inputSummary: '/src/foo.ts', at: expect.any(Number) },
      { name: 'Bash', inputSummary: 'ls -la', at: expect.any(Number) },
      { name: 'Grep', inputSummary: 'TODO in src/', at: expect.any(Number) },
    ])
  })

  test('caps toolCalls history at 50 entries', async () => {
    // Build 60 tool_use blocks; only the first 50 should be kept
    // (the cap protects against long-running agents blowing up memory).
    const blocks = Array.from({ length: 60 }, (_, i) => ({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: `/src/file-${i}.ts` },
    }))
    const fakeRunAgent: RunAgentFn = async function* () {
      yield { type: 'assistant', message: { content: blocks } }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    // The cap is 50, not 60; toolsUsed is the true count (60).
    expect(result.toolsUsed).toBe(60)
    expect(result.toolCalls).toHaveLength(50)
  })

  test('falls back to first-string-field for unknown tool names', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'codegraph_search', input: { query: 'foo bar' } },
          ],
        },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    // The summary picks the first string field ("query" → "foo bar")
    // because the tool name isn't in the known switch.
    expect(result.toolCalls![0]!.inputSummary).toBe('foo bar')
  })

  // Regression: the Anthropic SDK mutates `m.message.usage` on the
  // LAST yielded message in the `message_delta` event handler
  // (claude.ts:2259). The mutation runs AFTER the message has
  // been yielded. If the spawner reads `usage` during the for-await
  // loop, it always sees undefined and the /workflows panel shows
  // "0 tok" for completed agents (e.g. opencc-bug-hunt F3: 18 tools
  // but 0 tokens). The fix: keep a ref to the last assistant
  // message and re-read its usage field AFTER the loop completes.
  test('captures tokensUsed from the last assistant message after the stream ends', async () => {
    // Simulate the SDK's mutate-after-yield pattern: we yield
    // messages first, then mutate their usage fields in the order
    // the SDK would (assistant message_delta fires AFTER the
    // message has been yielded to consumers).
    const first: {
      type: 'assistant'
      message: {
        content: Array<{ type: string; text: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }
    } = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello ' }] },
    }
    const second: typeof first = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'world' }] },
    }
    const fakeRunAgent: RunAgentFn = async function* () {
      yield first
      yield second
      // Now mutate (as the SDK would have done during message_delta).
      first.message.usage = { input_tokens: 50, output_tokens: 10 }
      second.message.usage = { input_tokens: 200, output_tokens: 75 }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.report).toBe('hello world')
    // The post-loop read picks up the LAST message's usage
    // (200+75=275). The in-loop reads picked up the first
    // message's usage (50+10=60) earlier, but the guard
    // `if (finalTotal > tokensUsed)` keeps the higher value.
    expect(result.tokensUsed).toBe(275)
  })

  // Captures the model from the streamed assistant message. The
  // /workflows panel shows the model in the per-agent row; without
  // this the user only ever sees "unknown" for scripts that don't
  // pass `model` explicitly in agent() opts (opencc-bug-hunt.js
  // is one such script).
  test('captures model from the streamed assistant message', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }], model: 'MiniMax-M3' },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.model).toBe('MiniMax-M3')
  })

  test('leaves model undefined when no assistant message has one', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield { type: 'progress', content: 'thinking' }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    const result = await spawner('anything', {})
    expect(result.model).toBeUndefined()
  })

  // Live progress: opts.onProgress is invoked once per assistant
  // message in the stream so callers (e.g. LocalWorkflowTask) can
  // tick up tokensUsed / toolsUsed in their own state store while
  // the agent is still running — the /workflows panel otherwise
  // shows "unknown" / "—" for the entire duration of an in-flight
  // agent (the data only lands in SpawnResult after the loop
  // completes).
  test('invokes onProgress once per assistant message with cumulative counters', async () => {
    const progress: Array<{
      tokensUsed?: number
      toolsUsed?: number
      toolCalls?: unknown[]
      model?: string
    }> = []
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'a ' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'MiniMax-M3',
        },
      }
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'b' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 20, output_tokens: 7 },
        },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('p', {
      onProgress: p => progress.push(p),
    })
    // Two assistant messages → at least two progress events (the
    // post-loop final event is a bonus; the contract here is "at
    // least once per assistant message").
    expect(progress.length).toBeGreaterThanOrEqual(2)
    // First progress event after the first assistant message
    expect(progress[0]!.tokensUsed).toBe(15) // 10+5
    expect(progress[0]!.toolsUsed).toBe(1)
    expect(progress[0]!.toolCalls).toHaveLength(1)
    expect(progress[0]!.model).toBe('MiniMax-M3')
    // Second progress event after the second assistant message
    expect(progress[1]!.tokensUsed).toBe(42) // 15+20+7
    expect(progress[1]!.toolsUsed).toBe(2)
    expect(progress[1]!.toolCalls).toHaveLength(2)
  })

  // After the post-loop usage re-read (which captures the SDK's
  // mutate-after-yield pattern on the last assistant message),
  // onProgress is called ONE MORE TIME with the corrected final
  // token count. This lets the UI converge to the authoritative
  // value rather than the in-loop estimate.
  test('invokes onProgress after post-loop usage re-read with corrected tokensUsed', async () => {
    const progress: Array<{ tokensUsed?: number }> = []
    // Simulate SDK's mutate-after-yield pattern
    const first = {
      type: 'assistant' as const,
      message: { content: [{ type: 'text', text: 'a' }] },
    }
    const second = {
      type: 'assistant' as const,
      message: { content: [{ type: 'text', text: 'b' }] },
    }
    const fakeRunAgent: RunAgentFn = async function* () {
      yield first
      yield second
      // Mutate AFTER yield (the SDK pattern)
      ;(first.message as typeof first.message & { usage?: { input_tokens: number; output_tokens: number } }).usage = { input_tokens: 10, output_tokens: 5 }
      ;(second.message as typeof second.message & { usage?: { input_tokens: number; output_tokens: number } }).usage = { input_tokens: 999, output_tokens: 999 }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('p', { onProgress: p => progress.push(p) })
    // The last progress event must reflect the post-loop correction
    // (999+999=1998, not the in-loop estimate of 15).
    const last = progress[progress.length - 1]!
    expect(last.tokensUsed).toBe(1998)
  })

  // onProgress is optional — callers that don't pass it (legacy
  // no-op, ad-hoc LocalSpawner implementations) must not crash.
  test('does not throw when onProgress is omitted', async () => {
    const fakeRunAgent: RunAgentFn = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    // No onProgress at all
    const result = await spawner('p', {})
    expect(result.report).toBe('ok')
  })

  // When the stream has no assistant messages, onProgress should
  // never be called (no data to report).
  test('does not invoke onProgress when no assistant messages were streamed', async () => {
    let calls = 0
    const fakeRunAgent: RunAgentFn = async function* () {
      yield { type: 'progress', content: 'thinking' }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([{ agentType: 'general-purpose' }]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('p', { onProgress: () => calls++ })
    expect(calls).toBe(0)
  })

  // Workflow author can scope a subagent's tool allowlist for one
  // specific call without registering a new agent type. When
  // opts.tools is a string array, the spawner shadows agentDef's
  // `tools` field with that array and forwards the shadow to
  // runAgent. disallowedTools is untouched.
  test('opts.tools replaces agentDef.tools for the call', async () => {
    let captured: { tools?: unknown } = {}
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      const def = (opts as { agentDefinition: { tools?: unknown } }).agentDefinition
      captured.tools = def.tools
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([
        { agentType: 'general-purpose', tools: ['*'] },
      ]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('read only', { tools: ['Read'] })
    expect(captured.tools).toEqual(['Read'])
  })

  // The spawner does NOT validate tool names — it just forwards
  // opts.tools verbatim. resolveAgentTools (called inside runAgent)
  // owns the lenient-drop policy. Verifying pass-through here pins
  // the contract: the spawner is a pass-through, not a filter.
  test('opts.tools passes unknown names through to runAgent', async () => {
    let captured: { tools?: unknown } = {}
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      const def = (opts as { agentDefinition: { tools?: unknown } }).agentDefinition
      captured.tools = def.tools
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([
        { agentType: 'general-purpose', tools: ['*'] },
      ]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('mixed', { tools: ['Read', 'Bash', 'Foo'] })
    expect(captured.tools).toEqual(['Read', 'Bash', 'Foo'])
  })

  // Backward compatibility: when opts.tools is absent, the
  // agentDefinition forwarded to runAgent IS the registry object
  // (identity check, not a spread copy). This guarantees the
  // fast-path adds zero allocations for existing call sites.
  test('omitting opts.tools forwards the original agentDef (no shadow)', async () => {
    let captured: { def?: unknown } = {}
    const registryDef = { agentType: 'general-purpose', tools: ['Read', 'Grep'] }
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      captured.def = (opts as { agentDefinition: unknown }).agentDefinition
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }
    }
    const spawner = await buildRealSpawner(
      makeToolUseCtx([registryDef]) as never,
      undefined,
      'wf_test',
      { runAgent: fakeRunAgent, createUserMessage: (() => ({})) as CreateUserMessageFn },
    )
    await spawner('no override', {})
    expect(captured.def).toBe(registryDef)
  })
})

// Schema handling: when opts.schema is set, the spawner injects a
// StructuredOutputTool (bound to that schema) into the subagent's tool
// pool, then validates whatever the subagent passed as the `data` arg.
// The bound tool's name is `StructuredOutput_<8chars>` (random per call)
// — we capture the actual name by inspecting availableTools rather than
// hard-coding it.
describe('schema handling', () => {
  test('injects StructuredOutputTool and validates result when opts.schema is set', async () => {
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    }

    const runAgentCalls: Array<{ availableTools: unknown[] }> = []
    const fakeRunAgent: RunAgentFn = async function* (opts) {
      const tools = (opts as { availableTools: Array<{ name: string }> }).availableTools
      runAgentCalls.push({ availableTools: tools })
      // Find the actual bound tool name (random per call) and call it
      const boundTool = tools.find(t => t.name.startsWith('StructuredOutput_'))
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: boundTool?.name ?? 'StructuredOutput_unknown',
              input: { data: { summary: 'hello' } },
            },
          ],
          model: 'claude-sonnet-4-6',
        },
      }
    }

    const fakeCreateUserMessage: CreateUserMessageFn = args => ({
      type: 'user',
      content: args.content,
    })

    const toolUseCtx = {
      options: {
        tools: [],
        agentDefinitions: {
          allAgents: [{ agentType: 'general-purpose' }],
        },
      },
    }

    const spawner = await buildRealSpawner(
      toolUseCtx as never,
      {},
      'task-1',
      {
        runAgent: fakeRunAgent,
        createUserMessage: fakeCreateUserMessage,
      },
    )

    const result = await spawner('test prompt', { schema } as never)
    // On success, result.structuredOutput is the raw value the
    // subagent emitted (already schema-validated). Not the
    // `{ok,value}` envelope — only the failure path uses the
    // envelope shape.
    expect(result.structuredOutput).toEqual({ summary: 'hello' })
    expect(runAgentCalls[0]?.availableTools.length).toBeGreaterThan(0)
    // The tool pool should contain a StructuredOutput_* tool
    const injectedTool = (
      runAgentCalls[0]?.availableTools as Array<{ name: string }>
    ).find(t => t.name.startsWith('StructuredOutput_'))
    expect(injectedTool).toBeDefined()
  })

  test('returns ok:false result when subagent never called StructuredOutput', async () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } }

    const fakeRunAgent: RunAgentFn = async function* () {
      // Subagent writes answer as plain text, no tool_use
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'plain answer' }], model: 'm' },
      }
    }

    const toolUseCtx = {
      options: {
        tools: [],
        agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
      },
    }
    const spawner = await buildRealSpawner(
      toolUseCtx as never,
      {},
      'task-1',
      {
        runAgent: fakeRunAgent,
        createUserMessage: (a: { content: string }) => ({
          type: 'user',
          content: a.content,
        }),
      },
    )
    const result = await spawner('test', { schema } as never)
    expect(result.structuredOutput).toEqual({
      ok: false,
      error: expect.stringMatching(/without calling StructuredOutput/i),
    })
  })

  // I2: regression tests for the runtime JSON text fallback (added 2026-06-22
  // to support non-firstParty models per opencc-minimax-jsonschema-not-enforced).
  // Each test pins one of the 3 accepted shapes + the C1 prose-with-JSON guard
  // + the "tool call wins over text" regression.
  describe('JSON text fallback (non-firstParty model support)', () => {
    function makeTextOnlySpawner(reportText: string) {
      const fakeRunAgent: RunAgentFn = async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: reportText }], model: 'm' },
        }
      }
      const toolUseCtx = {
        options: {
          tools: [],
          agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
        },
      }
      return buildRealSpawner(toolUseCtx as never, {}, 'task-1', {
        runAgent: fakeRunAgent,
        createUserMessage: (a: { content: string }) => ({
          type: 'user',
          content: a.content,
        }),
      })
    }

    test('{"data": {...}} shape (StructuredOutput mimicry) → unwrap and validate', async () => {
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner('{"data":{"type":"node"}}')
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ type: 'node' })
    })

    test('flat {field: value} shape → validate as-is', async () => {
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner('{"type":"node"}')
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ type: 'node' })
    })

    test('bare scalar "node" + single-field schema → wrap and validate', async () => {
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner('"node"')
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ type: 'node' })
    })

    test('valid JSON but schema-invalid ({"type": 42}) → still failure envelope', async () => {
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner('{"type": 42}')
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toMatchObject({ ok: false })
      expect((result.structuredOutput as { error: string }).error).toMatch(
        /without calling StructuredOutput/i,
      )
    })

    test('extracts JSON from prose-with-JSON-prefix ("The answer is {...}")', async () => {
      // LLMs commonly wrap their JSON answer in a sentence ("The answer is
      // {\"type\":\"node\"} because..."). The active extractor finds the
      // first balanced JSON value and parses it, instead of rejecting the
      // whole text. This is the most common LLM behavior in practice.
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner(
        'The answer is {"type":"node"} because I read package.json',
      )
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ type: 'node' })
    })

    test('extracts JSON followed by trailing prose ("{...} and some notes")', async () => {
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner(
        '{"type":"node"} and some trailing notes',
      )
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ type: 'node' })
    })

    test('plain non-JSON prose still falls to failure envelope', async () => {
      // Active extraction does NOT rescue genuinely non-JSON text. If the
      // LLM emits just prose with no JSON value, the runtime falls through
      // to the failure envelope — caller distinguishes "forgot" from
      // "bad data".
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const spawner = await makeTextOnlySpawner(
        "I looked but couldn't find any manifest file",
      )
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toMatchObject({ ok: false })
    })

    test('regression: StructuredOutput tool call wins over text fallback', async () => {
      // When the LLM calls StructuredOutput AND also emits prose, the
      // tool call must be the source of truth — text fallback must NOT
      // override the captured tool_use value.
      const schema = {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
      }
      const fakeRunAgent: RunAgentFn = async function* (opts) {
        // Emit prose FIRST, then the StructuredOutput tool_use with a
        // different (correct) value.
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I think it might be python or something' },
            ],
            model: 'm',
          },
        }
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: (opts.availableTools as Array<{ name: string }>)
                  .map(t => t.name)
                  .find(n => n.startsWith('StructuredOutput_'))!,
                input: { data: { type: 'rust' } },
              },
            ],
            model: 'm',
          },
        }
      }
      const toolUseCtx = {
        options: {
          tools: [],
          agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
        },
      }
      const spawner = await buildRealSpawner(toolUseCtx as never, {}, 'task-1', {
        runAgent: fakeRunAgent,
        createUserMessage: (a: { content: string }) => ({
          type: 'user',
          content: a.content,
        }),
      })
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ type: 'rust' })
    })

    test('captured StructuredOutput invalid (LLM called with wrong shape) + valid text → text wins', async () => {
      // Real-world pattern (observed in wf_818582ef transcript): LLM
      // calls StructuredOutput multiple times with `{"data": ""}` (empty
      // string, not the expected object), then gives up and writes the
      // real answer as prose: "The version from package.json is 0.18.0".
      // The runtime must recover via text fallback instead of surfacing
      // the captured-but-invalid envelope.
      const schema = {
        type: 'object',
        properties: { version: { type: 'string' } },
        required: ['version'],
      }
      const fakeRunAgent: RunAgentFn = async function* (opts) {
        // 1. LLM calls StructuredOutput with wrong shape (empty string).
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: (opts.availableTools as Array<{ name: string }>)
                  .map(t => t.name)
                  .find(n => n.startsWith('StructuredOutput_'))!,
                input: { data: '' },
              },
            ],
            model: 'm',
          },
        }
        // 2. LLM gives up on the tool and writes the answer in prose.
        yield {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'The tool keeps rejecting. The version from package.json is "0.18.0".',
              },
            ],
            model: 'm',
          },
        }
      }
      const toolUseCtx = {
        options: {
          tools: [],
          agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
        },
      }
      const spawner = await buildRealSpawner(toolUseCtx as never, {}, 'task-1', {
        runAgent: fakeRunAgent,
        createUserMessage: (a: { content: string }) => ({
          type: 'user',
          content: a.content,
        }),
      })
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toEqual({ version: '0.18.0' })
    })

    test('I1: scalar text + multi-field schema → skip scalar branch, failure envelope', async () => {
      // Scalar wrapping could match the WRONG property in a multi-field
      // schema. The runtime must skip the scalar branch and fall through
      // to the failure envelope instead of guessing the field.
      const schema = {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          type: { type: 'string' },
        },
        required: ['reason', 'type'],
      }
      const spawner = await makeTextOnlySpawner('"node"')
      const result = await spawner('test', { schema } as never)
      expect(result.structuredOutput).toMatchObject({ ok: false })
    })
  })

  test('returns ok:false envelope when subagent calls StructuredOutput with data violating schema', async () => {
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    }

    const runAgentCalls: Array<{ availableTools: Array<{ name: string }> }> = []
    const fakeRunAgent = async function* (opts: { availableTools: Array<{ name: string }> }) {
      runAgentCalls.push({ availableTools: opts.availableTools })
      const bound = opts.availableTools.find(t => t.name.startsWith('StructuredOutput_'))
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: bound?.name ?? 'StructuredOutput_unknown',
              // Pass wrong type (number instead of string) to violate schema
              input: { data: { summary: 42 } },
            },
          ],
          model: 'claude-sonnet-4-6',
        },
      }
    } as unknown as AsyncGenerator<unknown, void>

    const toolUseCtx = {
      options: {
        tools: [],
        agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
      },
    }
    const spawner = await buildRealSpawner(
      toolUseCtx as never, {}, 'task-1',
      {
        runAgent: fakeRunAgent as never,
        createUserMessage: (a: { content: string }) => ({ type: 'user', content: a.content }),
      },
    )
    const result = await spawner('test', { schema } as never)
    expect(result.structuredOutput).toEqual({
      ok: false,
      error: expect.stringMatching(/must be string|invalid type/i),
    })
  })
})

// isolation:worktree — when opts.isolation === 'worktree', the spawner
// must wrap the subagent run in a fresh git worktree via
// withWorktreeIsolation, expose the worktree path in SpawnResult, and
// surface isolationRemoved (true when the helper auto-removed the
// worktree because git diff was empty, false when it kept it). These
// tests exercise the real git worktree flow against the actual repo
// because there's no fs injection seam in realSpawner (we trust the
// helper's behavior, which is itself unit-tested in
// runtime/isolation.test.ts).
describe('isolation:worktree', () => {
  it('wraps the subagent in a worktree when opts.isolation=worktree', async () => {
    const fakeRunAgent = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'worktree result' }], model: 'm' },
      }
    } as unknown as AsyncGenerator<unknown, void>

    const toolUseCtx = {
      options: {
        tools: [],
        agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
      },
    }
    const spawner = await buildRealSpawner(
      toolUseCtx as never, {}, 'task-1',
      {
        runAgent: fakeRunAgent as never,
        createUserMessage: (a: { content: string }) => ({ type: 'user', content: a.content }),
      },
    )
    const result = await spawner('p', { isolation: 'worktree' } as never)
    // The worktree path is what we care about — the spawner must
    // have wrapped the run in withWorktreeIsolation. The actual
    // `isolationRemoved` value depends on git diff inside the
    // worktree, which can be non-empty due to repo-level EOL
    // rewrites (e.g. python/requirements.txt is text/CRLF) — that's
    // a property of the test repo, not the spawner contract.
    expect(result.worktreePath).toMatch(/^\/tmp\/opencc-worktree-/)
    expect(typeof result.isolationRemoved).toBe('boolean')
  })

  it('exposes worktreePath in SpawnResult when isolation=worktree', async () => {
    const fakeRunAgent = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'modified' }], model: 'm' },
      }
    } as unknown as AsyncGenerator<unknown, void>

    const toolUseCtx = {
      options: {
        tools: [],
        agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
      },
    }
    const spawner = await buildRealSpawner(
      toolUseCtx as never, {}, 'task-1',
      {
        runAgent: fakeRunAgent as never,
        createUserMessage: (a: { content: string }) => ({ type: 'user', content: a.content }),
      },
    )
    const result = await spawner('p', { isolation: 'worktree' } as never)
    expect(result.worktreePath).toBeDefined()
    expect(typeof result.worktreePath).toBe('string')
  })

  it('does not set worktreePath when isolation is omitted', async () => {
    const fakeRunAgent = async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'no worktree' }], model: 'm' },
      }
    } as unknown as AsyncGenerator<unknown, void>

    const toolUseCtx = {
      options: {
        tools: [],
        agentDefinitions: { allAgents: [{ agentType: 'general-purpose' }] },
      },
    }
    const spawner = await buildRealSpawner(
      toolUseCtx as never, {}, 'task-1',
      {
        runAgent: fakeRunAgent as never,
        createUserMessage: (a: { content: string }) => ({ type: 'user', content: a.content }),
      },
    )
    const result = await spawner('p', {} as never)
    expect(result.worktreePath).toBeUndefined()
    expect(result.isolationRemoved).toBeUndefined()
  })
})

// Pin down the LocalSpawner return-type contract so a future refactor
// can't accidentally widen it (the LocalWorkflowTask wrapper
// specifically expects { agentId, report }).
describe('LocalSpawner return type contract', () => {
  test('spawner returns an object with agentId and report strings', async () => {
    const spawner: LocalSpawner = await buildRealSpawner(
      makeToolUseCtx() as never,
      undefined,
      'wf_test',
      { runAgent: null, createUserMessage: null },
    )
    const result = await spawner('p', {})
    expect(typeof result.agentId).toBe('string')
    expect(typeof result.report).toBe('string')
    expect(result.agentId.length).toBeGreaterThan(0)
    expect(result.report.length).toBeGreaterThan(0)
  })
})
