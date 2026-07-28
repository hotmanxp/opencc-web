// src/tools/WorkflowTool/bundled/index.test.ts
import { describe, expect, test } from 'bun:test'
import { initBundledWorkflows, getBundledSource } from './index.js'

describe('bundled workflow registration', () => {
  test('initBundledWorkflows registers deep-research into the registry', () => {
    const registered: { name: string; source: string }[] = []
    const mockRegistry = {
      registerBundled: (wf: { name: string; source: string }) => {
        registered.push({ name: wf.name, source: wf.source })
      },
    }
    initBundledWorkflows(mockRegistry as any)
    expect(registered.find(r => r.name === 'deep-research')).toBeDefined()
  })

  test('getBundledSource returns the deep-research script for "deep-research"', () => {
    const src = getBundledSource('deep-research')
    expect(src).toContain('userScript')
    // The 5-phase redesign (Scope→Search→Fetch→Verify→Synthesize) uses
    // the agent() wrapper (Plan1) and __setMeta() for the phase list.
    // spawnSubagent is still injected by the worker prelude — no need
    // for the script to call it directly.
    expect(src).toContain('agent(')
    expect(src).toContain('__setMeta')
    expect(src).toContain("title: 'Scope'")
    expect(src).toContain("title: 'Synthesize'")
  })

  test('getBundledSource returns undefined for unknown workflow', () => {
    const src = getBundledSource('does-not-exist')
    expect(src).toBeUndefined()
  })
})
