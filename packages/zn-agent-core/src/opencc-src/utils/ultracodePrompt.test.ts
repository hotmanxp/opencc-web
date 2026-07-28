// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { withUltracodePrompt, ULTRACODE_SUBAGENT_PROMPT } from './ultracodePrompt.js'

describe('ULTRACODE_SUBAGENT_PROMPT', () => {
  it('contains the ultracode opt-in rule', () => {
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('ultracode is on')
  })

  it('mentions all 4 core quality patterns', () => {
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('Adversarial verify')
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('Multi-modal sweep')
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('Completeness critic')
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('loop-until-dry')
  })

  it('is a workflow-orchestration script preamble', () => {
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('workflow orchestration script')
  })

  it('starts with the Ultracode block marker', () => {
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('**Ultracode.**')
  })

  it('includes the perspective-diverse and judge-panel patterns', () => {
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('Perspective-diverse verify')
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('Judge panel')
    expect(ULTRACODE_SUBAGENT_PROMPT).toContain('No silent caps')
  })
})

describe('withUltracodePrompt', () => {
  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    mock.restore()
  })

  it('returns the input array unchanged when ultracode is inactive', () => {
    mock.module('./ultracode.js', () => ({
      isUltracodeActive: () => false,
    }))
    return import(
      `./ultracodePrompt.ts?ts=${Date.now()}-${Math.random()}`
    ).then(mod => {
      const input = ['base prompt', 'env details']
      const out = mod.withUltracodePrompt(input)
      expect(out).toEqual(input)
    })
  })

  it('appends ULTRACODE_SUBAGENT_PROMPT when ultracode is active', () => {
    mock.module('./ultracode.js', () => ({
      isUltracodeActive: () => true,
    }))
    return import(
      `./ultracodePrompt.ts?ts=${Date.now()}-${Math.random()}`
    ).then(mod => {
      const input = ['base prompt']
      const out = mod.withUltracodePrompt(input)
      expect(out.length).toBe(2)
      expect(out[0]).toBe('base prompt')
      expect(out[1]).toBe(mod.ULTRACODE_SUBAGENT_PROMPT)
    })
  })
})
