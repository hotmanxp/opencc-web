// src/tools/WorkflowTool/bundled/deepResearch.test.ts
import { describe, expect, test } from 'bun:test'
import { deepResearch } from './deepResearch.js'

describe('deepResearch (Plan14 parity)', () => {
  test('exposes the upstream whenToUse string', () => {
    expect(deepResearch.whenToUse).toContain('multi-source, fact-checked research report')
    expect(deepResearch.whenToUse).toContain('check if the question is specific enough')
  })
})
