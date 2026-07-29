// src/tools/WorkflowTool/workflowResumeStore.test.ts
import { describe, expect, it } from 'bun:test'
import {
  saveAgentResult,
  getCachedAgentResult,
  clearRunCache,
} from './workflowResumeStore.ts'

describe('workflowResumeStore', () => {
  it('returns cached result for matching (prompt, opts)', () => {
    const runId = 'wf-test-1'
    clearRunCache(runId)
    saveAgentResult(
      runId,
      { prompt: 'do thing', opts: { label: 'L' } },
      { report: 'cached-result', agentId: 'a1' },
    )
    const got = getCachedAgentResult(runId, {
      prompt: 'do thing',
      opts: { label: 'L' },
    })
    expect(got).toEqual({ report: 'cached-result', agentId: 'a1' })
  })

  it('returns undefined for non-matching prompt', () => {
    const runId = 'wf-test-2'
    clearRunCache(runId)
    saveAgentResult(
      runId,
      { prompt: 'A', opts: {} },
      { report: 'r1', agentId: 'a1' },
    )
    expect(
      getCachedAgentResult(runId, { prompt: 'B', opts: {} }),
    ).toBeUndefined()
  })

  it('treats opts key order as equivalent (JSON serialization)', () => {
    const runId = 'wf-test-3'
    clearRunCache(runId)
    saveAgentResult(
      runId,
      { prompt: 'X', opts: { a: 1, b: 2 } },
      { report: 'r3', agentId: 'a3' },
    )
    const got = getCachedAgentResult(runId, {
      prompt: 'X',
      opts: { b: 2, a: 1 },
    })
    expect(got).toEqual({ report: 'r3', agentId: 'a3' })
  })

  it('clearRunCache removes the run entries', () => {
    const runId = 'wf-test-4'
    clearRunCache(runId)
    saveAgentResult(
      runId,
      { prompt: 'Z', opts: {} },
      { report: 'r4', agentId: 'a4' },
    )
    expect(
      getCachedAgentResult(runId, { prompt: 'Z', opts: {} }),
    ).toBeDefined()
    clearRunCache(runId)
    expect(
      getCachedAgentResult(runId, { prompt: 'Z', opts: {} }),
    ).toBeUndefined()
  })
})
