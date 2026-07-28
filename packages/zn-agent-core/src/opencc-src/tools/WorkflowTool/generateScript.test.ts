import { describe, expect, test } from 'bun:test'
import { buildScriptGenerationPrompt } from './generateScript.js'

describe('buildScriptGenerationPrompt', () => {
  test('includes task description', () => {
    const p = buildScriptGenerationPrompt({
      task: 'audit src/ for security issues',
      workflowName: 'security-audit',
      args: undefined,
    })
    expect(p).toContain('security')
    expect(p).toContain('security-audit')
  })

  test('mentions spawnSubagent API', () => {
    const p = buildScriptGenerationPrompt({
      task: 'foo',
      workflowName: 'foo',
      args: undefined,
    })
    expect(p).toContain('spawnSubagent')
  })

  test('forbids require/import/process in instructions', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    expect(p).toContain('forbidden')
    expect(p).toContain('require')
  })

  test('serializes args correctly', () => {
    const p = buildScriptGenerationPrompt({
      task: 't',
      workflowName: 'w',
      args: ['a', 'b', 'c'],
    })
    expect(p).toContain('"a"')
    expect(p).toContain('"b"')
  })

  test('parses CLI args string and shows parsed object', () => {
    const p = buildScriptGenerationPrompt({
      task: 't',
      workflowName: 'w',
      args: '--name=ethan --word=hello --verbose',
    })
    expect(p).toContain('The user passed CLI args: `--name=ethan --word=hello --verbose`')
    expect(p).toContain('"name":"ethan"')
    expect(p).toContain('"word":"hello"')
    expect(p).toContain('"verbose":true')
  })

  test('CLI args empty string shows (none)', () => {
    const p = buildScriptGenerationPrompt({
      task: 't',
      workflowName: 'w',
      args: '',
    })
    expect(p).toContain('The user passed CLI args: (none)')
    expect(p).toContain('Parsed to object')
  })

  test('mentions __setMeta', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    expect(p).toContain('__setMeta')
  })

  test('mentions phase()', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    expect(p).toMatch(/phase\s*\(/)
  })

  test('mentions agent() global', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    expect(p).toMatch(/agent\s*\(/)
  })

  test('mentions parallel() global', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    expect(p).toMatch(/parallel\s*\(/)
  })

  test('teaches the abort-on-failure pattern', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    // The abort pattern: `if (!r.ok) return { aborted, details: r.error }`.
    // The prompt should explicitly teach this so generated scripts hard-fail
    // early-return instead of letting a downstream phase run on a failed gate.
    expect(p).toContain('aborted')
    expect(p).toContain('!r.ok')
  })

  test('teaches agentType for registry dispatch', () => {
    const p = buildScriptGenerationPrompt({ task: 't', workflowName: 'w', args: undefined })
    // The agentType field routes through OpenCC's agent registry. The
    // prompt should mention the field name and an example agent key so
    // generated scripts can opt into registry dispatch when they need
    // a specialized agent (TUI verifier, Explore, general-purpose, etc.).
    expect(p).toContain('agentType')
  })
})
