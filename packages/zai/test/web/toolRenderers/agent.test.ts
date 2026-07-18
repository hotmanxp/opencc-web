// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { agentRenderer } from '../../../src/web/src/components/toolRenderers/agent.js'
import React from 'react'

describe('agentRenderer', () => {
  it('preview prefers description over prompt', () => {
    expect(
      agentRenderer.preview({
        description: '查找所有 Bash 工具调用',
        prompt: 'find all Bash usages',
      }),
    ).toBe('查找所有 Bash 工具调用')
  })
  it('preview falls back to first line of prompt when no description', () => {
    expect(
      agentRenderer.preview({
        prompt: 'first line of task\nrest of prompt ignored',
      }),
    ).toBe('first line of task')
  })
  it('preview is empty when both empty', () => {
    expect(agentRenderer.preview({ description: '', prompt: '' })).toBe('')
  })

  it('displayName appends (agent) to subagent_type', () => {
    expect(agentRenderer.displayName?.({ subagent_type: 'Explore' })).toBe(
      'Explore (agent)',
    )
  })
  it('displayName defaults to "general-purpose (agent)" when missing', () => {
    expect(agentRenderer.displayName?.({})).toBe('general-purpose (agent)')
  })
  it('displayName handles whitespace-only as missing', () => {
    expect(agentRenderer.displayName?.({ subagent_type: '   ' })).toBe(
      'general-purpose (agent)',
    )
  })

  it('renderInput returns React element with prompt', () => {
    const node = agentRenderer.renderInput?.({
      subagent_type: 'Plan',
      prompt: 'plan the refactor',
    })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput defined', () => {
    const node = agentRenderer.renderOutput?.(
      '<task_id>x</task_id>\n<status>running</status>',
      false,
    )!
    expect(React.isValidElement(node)).toBe(true)
  })
})
