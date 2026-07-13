// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModelStatusButton from '../../src/web/src/components/ModelStatusButton.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { ModelEntry } from '../../src/shared/settings.js'

const models: ModelEntry[] = [
  { alias: 'M3', model: 'MiniMax-M3', label: 'M3 · 默认最强', description: '最强' },
  { alias: 'haiku', model: 'MiniMax-M2.7-highspeed', label: 'M2.7 · 快速' },
]

beforeEach(() => {
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    sessions: [{
      transcriptId: 'sess-1',
      title: 'test',
      updatedAt: 1,
      cwd: '/x',
      // Default to no model set — exercises the unknown / settings-fetched
      // model path. Tests that need a specific model will override.
      model: 'MiniMax-M3',
    }],
    messages: [],
    status: 'idle',
    cwd: '/x',
    availableModels: models,
  })
  // Stub fetch for the useConversationInfo hook's settings call.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      defaultModel: 'MiniMax-M3',
      baseURL: null,
      models,
    }),
  } as Response)
})

describe('ModelStatusButton', () => {
  it('renders the alias.label of the current model', async () => {
    render(<ModelStatusButton />)
    // Wait for the settings fetch to settle so displayLabel resolves.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByText('M3 · 默认最强')).toBeDefined()
  })

  it('opens Popover with the model list on click', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    // Click the badge to open the Popover.
    const badge = screen.getByText('M3 · 默认最强')
    fireEvent.click(badge)
    // The Popover content has a list with both models.
    expect(screen.getAllByText('M2.7 · 快速')).toHaveLength(1)
    // "M3 · 默认最强" appears both in the badge label and in the popover
    // list item (current model is also listed) — expect 2 occurrences.
    expect(screen.getAllByText('M3 · 默认最强')).toHaveLength(2)
  })

  it('calls patchSessionModel when a non-current model is clicked', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强')) // open popover
    fireEvent.click(screen.getByText('M2.7 · 快速'))   // pick the other model
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'MiniMax-M2.7-highspeed')
  })

  it('does not call patchSessionModel when the current model is clicked', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强')) // open popover
    // Clicking the currently-selected model again should be a no-op.
    // Both the badge and the list item render "M3 · 默认最强" — pick the
    // one inside the popover (the list item).
    const matches = screen.getAllByText('M3 · 默认最强')
    fireEvent.click(matches[matches.length - 1]!)
    expect(patchSpy).not.toHaveBeenCalled()
  })
})
