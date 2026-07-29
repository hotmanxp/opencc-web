// src/tools/WorkflowTool/bundled/deep-research-phases.test.ts
import { describe, expect, it } from 'bun:test'
import { deepResearch, deepResearchSource, DEEP_RESEARCH_PHASES } from './deepResearch.ts'

describe('deepResearch metadata', () => {
  it('declares 5 phases matching upstream design', () => {
    expect(DEEP_RESEARCH_PHASES).toHaveLength(5)
    expect(DEEP_RESEARCH_PHASES.map(p => p.title)).toEqual([
      'Scope', 'Search', 'Fetch', 'Verify', 'Synthesize',
    ])
  })

  it('has a non-empty description for each phase', () => {
    for (const phase of DEEP_RESEARCH_PHASES) {
      expect(phase.detail).toBeTruthy()
      expect(phase.detail.length).toBeGreaterThan(10)
    }
  })

  it('exports workflow name "deep-research"', () => {
    expect(deepResearch.name).toBe('deep-research')
    expect(deepResearch.source).toBe('bundled')
  })

  it('exports a non-empty script source', () => {
    expect(typeof deepResearchSource).toBe('string')
    expect(deepResearchSource.length).toBeGreaterThan(500)
    expect(deepResearchSource).toMatch(/async function userScript/)
  })
})