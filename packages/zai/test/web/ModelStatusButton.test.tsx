// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModelStatusButton from '../../src/web/src/components/ModelStatusButton.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { ModelEntry } from '../../src/shared/settings.js'

const models: ModelEntry[] = [
  {
    alias: 'M3',
    model: 'MiniMax-M3',
    label: 'MiniMax-M3 (M3)',
    description: '最强',
    baseUrl: 'https://api.minimaxi.com/v1',
  },
  {
    alias: 'haiku',
    model: 'MiniMax-M2.7-highspeed',
    label: 'M2.7 · 快速',
    baseUrl: 'https://api.minimaxi.com/v1',
  },
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
    expect(screen.getByText('MiniMax-M3 (M3)')).toBeDefined()
  })

  it('opens Popover with the model list on click', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    // Click the badge to open the Popover.
    const badge = screen.getByText('MiniMax-M3 (M3)')
    fireEvent.click(badge)
    // The Popover content has a list with both models.
    expect(screen.getAllByText('M2.7 · 快速')).toHaveLength(1)
    // "MiniMax-M3 (M3)" appears in: badge label, Recent section row, and
    // provider group row — expect 3 occurrences in the TUI picker.
    expect(screen.getAllByText('MiniMax-M3 (M3)')).toHaveLength(3)
  })

  it('calls patchSessionModel when a non-current model is clicked', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)')) // open popover
    fireEvent.click(screen.getByText('M2.7 · 快速'))   // pick the other model
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'MiniMax-M2.7-highspeed')
  })

  it('does not call patchSessionModel when the current model is clicked', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)')) // open popover
    // Clicking the currently-selected model again should be a no-op.
    // Both the badge and the list item render "MiniMax-M3 (M3)" — pick the
    // one inside the popover (the list item).
    const matches = screen.getAllByText('MiniMax-M3 (M3)')
    fireEvent.click(matches[matches.length - 1]!)
    expect(patchSpy).not.toHaveBeenCalled()
  })
})

describe('ModelStatusButton TUI picker (extended)', () => {
  // Reuse the existing beforeEach that sets up sessions / availableModels / fetch.
  // Existing beforeEach sets:
  //   - sessions: [{ transcriptId: 'sess-1', model: 'MiniMax-M3', cwd: '/x', updatedAt: 1 }]
  //   - availableModels: 2 models with aliases 'M3' and 'haiku'
  //     (model strings: 'MiniMax-M3', 'MiniMax-M2.7-highspeed')
  //   - globalThis.fetch mocked to return settings with defaultModel: 'MiniMax-M3'
  //
  // data-testid values are `model-row-${entry.alias}`:
  //   - model-row-M3
  //   - model-row-haiku
  // Provider titles derive from alias prefix + baseUrl host. Test data
  // sets baseUrl 'https://api.minimaxi.com/v1' on both entries, so titles
  // are 'M3 (minimaxi.com)' and 'haiku (minimaxi.com)' and both render
  // under the same group.

  it('filters entries by search query', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)')) // open popover
    const search = screen.getByPlaceholderText(/Search/i) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'M2' } })
    // M2.7 entry still shown, M3 hidden
    expect(screen.queryByTestId('model-row-M3')).toBeNull()
    expect(screen.getByTestId('model-row-haiku')).toBeDefined()
  })

  it('shows no-match message when search returns empty', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)'))
    const search = screen.getByPlaceholderText(/Search/i) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'xyz' } })
    expect(screen.getByText('无匹配模型')).toBeDefined()
  })

  it('renders Recent section with session-derived models', async () => {
    // Existing beforeEach already has sessions[0].model = 'MiniMax-M3', so Recent
    // should render model-row-M3.
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)'))
    expect(screen.getByText('Recent')).toBeDefined()
    // Recent entry is the same M3 alias as current (M3 row also appears in
    // provider group, so use getAllByTestId to handle the duplicate testid).
    expect(screen.getAllByTestId('model-row-M3').length).toBeGreaterThanOrEqual(1)
  })

  it('dedupes Recent — same model in multiple sessions appears once', async () => {
    // Override sessions to have 3 entries: two with M3, one with M2.7-highspeed.
    useAgentStore.setState({
      sessions: [
        { transcriptId: 's-1', title: 'a', updatedAt: 3, model: 'MiniMax-M3' },
        { transcriptId: 's-2', title: 'b', updatedAt: 2, model: 'MiniMax-M3' },
        { transcriptId: 's-3', title: 'c', updatedAt: 1, model: 'MiniMax-M2.7-highspeed' },
      ],
    })
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)'))
    // M3 should appear once in Recent (the 2 sessions with M3 collapse to 1 entry).
    // Total M3 occurrences: 1 in Recent + 1 in provider group = 2.
    const m3Rows = screen.getAllByTestId('model-row-M3')
    expect(m3Rows.length).toBe(2) // 1 in Recent + 1 in provider group
  })

  it('formats provider title as "<profile> (<host>)"', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)'))
    // Test data has baseUrl 'https://api.minimaxi.com/v1'. URL.host returns
    // 'api.minimaxi.com' (full hostname). Profile is the alias (no '-' so
    // whole alias), title becomes 'M3 (api.minimaxi.com)'. The haiku entry
    // has a different profile ('haiku'), so it lands in its own group.
    expect(screen.getByText(/M3 \(api\.minimaxi\.com\)/i)).toBeDefined()
    expect(screen.getByText(/haiku \(api\.minimaxi\.com\)/i)).toBeDefined()
  })

  it('falls back to "default" host when baseUrl is absent', async () => {
    // Override availableModels with one entry lacking baseUrl. The badge
    // still shows the runtime-resolved M3 label, so click that to open.
    useAgentStore.setState({
      availableModels: [
        { alias: 'plain', model: 'plain-model', label: 'plain' },
      ],
    })
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3'))
    expect(screen.getByText(/plain \(default\)/i)).toBeDefined()
  })

  it('handles Enter key to select highlighted entry', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)')) // open popover
    // Initial selectedIndex = 0, which is the current model (M3) — no-op on Enter.
    // ArrowDown to move to next entry (haiku).
    const content = screen.getByTestId('model-picker-content')
    fireEvent.keyDown(content, { key: 'ArrowDown' })
    // Now selectedIndex = 1, the haiku entry.
    fireEvent.keyDown(content, { key: 'Enter' })
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'MiniMax-M2.7-highspeed')
  })

  it('handles ArrowDown to move selection', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)'))
    const content = screen.getByTestId('model-picker-content')
    // Initially selectedIndex = 0 (M3 row is current — selected because it's first in flatList).
    const initialSelected = content.querySelector('[data-selected="true"]')
    expect(initialSelected?.getAttribute('data-testid')).toBe('model-row-M3')
    // ArrowDown → selectedIndex = 1 (haiku).
    fireEvent.keyDown(content, { key: 'ArrowDown' })
    const afterDown = content.querySelector('[data-selected="true"]')
    expect(afterDown?.getAttribute('data-testid')).toBe('model-row-haiku')
  })

  it('keeps the keyboard highlight visible when search hides Recent', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('MiniMax-M3 (M3)')) // open popover
    // ArrowDown to move highlight into Recent → flatList index 1 (haiku).
    const content = screen.getByTestId('model-picker-content')
    fireEvent.keyDown(content, { key: 'ArrowDown' })
    // Type a search query that hides the Recent section (any non-empty
    // query flips `showRecent` false). After that, the provider-group
    // haiku row must still render data-selected="true".
    const search = screen.getByPlaceholderText(/Search/i) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'haiku' } })
    const selected = content.querySelectorAll('[data-selected="true"]')
    expect(selected.length).toBeGreaterThanOrEqual(1)
    expect(selected[0]?.getAttribute('data-testid')).toBe('model-row-haiku')
  })
})
