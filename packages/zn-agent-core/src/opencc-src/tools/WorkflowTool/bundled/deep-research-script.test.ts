// src/tools/WorkflowTool/bundled/deep-research-script.test.ts
import { describe, expect, it } from 'bun:test'
import * as vm from 'node:vm'
import { deepResearchSource } from './deepResearch.ts'

/**
 * Integration tests for the deepResearch bundled workflow script.
 *
 * The script source is a template literal emitted by deepResearch.ts and
 * executed by the Workflow runtime inside a `node:vm` sandbox with the
 * worker prelude injected as globals (agent, parallel, phase, log,
 * __setMeta, budget, args). These tests run that exact source in a fresh
 * vm context with mocked globals so we can assert the 5-phase pipeline
 * end-to-end without touching the real agent pool.
 *
 * Mock contract (matches Plan1 workerScript.ts:131):
 *   - agent() resolves to { ok, structuredOutput, report, label, phase }
 *   - structuredOutput is the RAW validated value on success
 *     (e.g. { angles: [{label, prompt}, ...] } directly, NOT
 *     { ok: true, value: { angles: [...] } })
 *
 * The mock prompt keys match the script's prompts literally:
 *   - Scope prompt begins with "Decompose"
 *   - Fetch prompt begins with "Fetch this URL"
 *   - Verify prompt contains "skeptical fact-checker"
 *   - Search prompts are generated dynamically from angle.prompt, so
 *     we match by phase + label prefix instead.
 */
describe('deepResearchSource integration', () => {
  it('runs through all 5 phases and produces a markdown report', async () => {
    const calls: Array<{ phase: string; prompt: string; label?: string }> = []
    const setMetas: unknown[] = []

    const mockAgent = async (
      prompt: string,
      opts: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      calls.push({ phase: String(opts.phase ?? '?'), prompt, label: opts.label as string | undefined })

      // Scope: produce 3 lens angles as OBJECTS with label + prompt (matches schema)
      if (prompt.includes('Decompose')) {
        return {
          ok: true,
          structuredOutput: {
            angles: [
              { label: 'background', prompt: 'Search for: history of France capital' },
              { label: 'current-state', prompt: 'Search for: Paris current status' },
              { label: 'critiques', prompt: 'Search for: Paris criticism' },
            ],
            verification_focus: ['dates', 'statistics'],
          },
          label: opts.label,
          phase: opts.phase,
        }
      }

      // Search agents: no schema; script reads r.report and runs URL regex.
      // We must provide a `report` containing URLs.
      if (typeof opts.label === 'string' && opts.label.startsWith('search:')) {
        return {
          ok: true,
          structuredOutput: undefined,
          report: 'See https://a.test/1 and https://b.test/2 for relevant results.',
          label: opts.label,
          phase: opts.phase,
        }
      }

      // Fetch: schema with claims array
      if (prompt.includes('Fetch this URL')) {
        const urlMatch = /URL:\s*(\S+)/.exec(prompt)
        const url = urlMatch ? urlMatch[1] : 'https://unknown.test/'
        return {
          ok: true,
          structuredOutput: {
            claims: [
              { claim: 'Test claim', quote: 'supporting text', url },
            ],
          },
          label: opts.label,
          phase: opts.phase,
        }
      }

      // Verify: 3-vote skeptical fact-checker
      if (prompt.includes('skeptical fact-checker')) {
        return {
          ok: true,
          structuredOutput: { vote: 'SUPPORTED', reason: 'ok' },
          label: opts.label,
          phase: opts.phase,
        }
      }

      // Synthesize + fallthrough: default
      return {
        ok: true,
        structuredOutput: {},
        label: opts.label,
        phase: opts.phase,
      }
    }

    const ctx: Record<string, unknown> = {
      agent: mockAgent,
      parallel: async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map(f => f())),
      __setMeta: (m: unknown) => { setMetas.push(m) },
      phase: () => {},
      log: () => {},
      budget: { total: 0, used: 0, remaining: () => 0 },
      args: 'What is the capital of France?',
    }
    vm.createContext(ctx as vm.Context)

    // Strip the `export const meta = { ... };` block (the test sets its own
    // meta via the mock __setMeta; the bundled meta lives in TS-land) and
    // the `export` keyword so the rest runs as plain script.
    const code = deepResearchSource
      .replace(/^export const meta[\s\S]*?};\s*/m, '')
      .replace(/^export\s+/gm, '')
    vm.runInContext(code, ctx as vm.Context)

    const userScript = (ctx as { userScript?: (a: unknown) => Promise<unknown> }).userScript
    if (!userScript) throw new Error('userScript not defined after running source')

    const result = await userScript('What is the capital of France?')

    expect(typeof result).toBe('string')
    expect(result).toMatch(/^# Deep research: /)
    expect(result).toContain('Verified')
    const phaseSet = new Set(calls.map(c => c.phase))
    // Scope/Search/Fetch/Verify each spawn agents; Synthesize is in-script
    // formatting with no agent call, so we check __setMeta for it instead.
    expect(phaseSet.has('Scope')).toBe(true)
    expect(phaseSet.has('Search')).toBe(true)
    expect(phaseSet.has('Fetch')).toBe(true)
    expect(phaseSet.has('Verify')).toBe(true)
    expect(setMetas).toHaveLength(1)
    expect((setMetas[0] as { phases?: Array<{ title?: string }> }).phases).toHaveLength(5)
    const metaPhaseTitles = ((setMetas[0] as { phases: Array<{ title: string }> }).phases).map(p => p.title)
    expect(metaPhaseTitles).toContain('Synthesize')
  })

  it('returns a usage message when args is empty', async () => {
    const ctx: Record<string, unknown> = {
      agent: async () => ({ ok: true, structuredOutput: {} }),
      parallel: async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map(f => f())),
      __setMeta: () => {},
      phase: () => {},
      log: () => {},
      budget: { total: 0, used: 0, remaining: () => 0 },
      args: '',
    }
    vm.createContext(ctx as vm.Context)
    const code = deepResearchSource
      .replace(/^export const meta[\s\S]*?};\s*/m, '')
      .replace(/^export\s+/gm, '')
    vm.runInContext(code, ctx as vm.Context)
    const userScript = (ctx as { userScript?: (a: unknown) => Promise<unknown> }).userScript
    if (!userScript) throw new Error('userScript not defined after running source')
    const result = await userScript('')
    expect(result).toBe('Usage: /deep-research <question>')
  })
})
