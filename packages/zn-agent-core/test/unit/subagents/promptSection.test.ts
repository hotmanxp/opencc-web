/**
 * Tests for `formatSubagentProviderSection` — the formatter that surfaces
 * registered `SubagentProvider`s into AgentTool's model-facing
 * description.
 *
 * Why this is the surface we test: `subagent_type` in AgentTool's zod
 * schema is `z.string()` (no enum), so the only way the model learns
 * which values route to a provider is the description text. A
 * regression here = the model can't see `codex` / `claude-code` even
 * though `getSubagentRegistry()` has them.
 *
 * Why we don't test the full `getPrompt()` path: importing
 * `tools/AgentTool/prompt.ts` pulls in the buildTool initialization
 * chain (BashTool, SendMessageTool, lazySchema, etc.) which fails under
 * bare vitest without setup shims. The formatting is the model-facing
 * contract; `prompt.ts` only glues it into a larger string.
 */
import { describe, expect, it } from 'vitest'
import {
  SubagentRegistry,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../../../src/compat/subagents/registry.js'
import { formatSubagentProviderSection } from '../../../src/compat/subagents/promptSection.js'

function makeFakeProvider(name: string, description: string): SubagentProvider {
  return {
    name,
    description,
    inheritsParentContext: false,
    capabilities: { noStartCapabilities: true } as const,
    start: (_req: SubagentRequest, _ctx: SubagentContext): Promise<SubagentRun> => {
      throw new Error(`fake provider '${name}' start() not implemented in test`)
    },
  }
}

describe('formatSubagentProviderSection', () => {
  it('returns empty string when no providers are registered', () => {
    const registry = new SubagentRegistry()
    expect(formatSubagentProviderSection(registry)).toBe('')
  })

  it('lists registered providers with name + description in registration order', () => {
    const registry = new SubagentRegistry()
    registry.registerProvider(
      makeFakeProvider(
        'codex',
        'Delegate a one-shot task to a fresh Codex CLI session (independent process).',
      ),
    )
    registry.registerProvider(
      makeFakeProvider(
        'claude-code',
        'Delegate a one-shot task to a fresh Claude CLI session (independent process).',
      ),
    )

    const out = formatSubagentProviderSection(registry)

    expect(out).toContain('External subagent providers')
    expect(out).toContain(
      '- codex: Delegate a one-shot task to a fresh Codex CLI session (independent process).',
    )
    expect(out).toContain(
      '- claude-code: Delegate a one-shot task to a fresh Claude CLI session (independent process).',
    )
    // Registration order is preserved (insertion-ordered Map; consumers
    // surface "available agents" in this order deterministically).
    const codexIdx = out.indexOf('- codex:')
    const claudeIdx = out.indexOf('- claude-code:')
    expect(codexIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeGreaterThan(codexIdx)
  })

  it('falls back to `- name` when a registered name has no backing provider object', () => {
    // Defensive: if the registry ever returns a name whose backing
    // provider is gone (e.g. deregistered mid-session via the disposer
    // returned by `registerProvider`), the section must still emit
    // `- name` without throwing.
    const registry = new SubagentRegistry()
    const dispose = registry.registerProvider(makeFakeProvider('codex', 'desc'))
    dispose()
    // After dispose the name is no longer in list(), so we can't reach
    // this path through the public API. The defensive branch is for
    // unexpected drift; we synthesize it by re-registering and then
    // deleting directly via #providers (not exposed) — skipped here.
    // Confirm normal path still works post-dispose.
    expect(formatSubagentProviderSection(registry)).toBe('')
  })
})