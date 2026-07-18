// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModeStatusButton from '../../src/web/src/components/ModeStatusButton.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

// Default mode for all tests below; the default session has no explicit
// permissionMode, so useAgentStore returns 'default' (the fallback in the component).
beforeEach(() => {
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    sessions: [{
      transcriptId: 'sess-1',
      title: 'test',
      updatedAt: 1,
      cwd: '/x',
      // No permissionMode → component falls back to 'default'.
    }],
    availableModels: [],
  })
})

// Restore spies between tests so a spy created in one test (e.g. T6's
// patchSessionMode spy) does not bleed into T7/T8 which assert it was
// NOT called.
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModeStatusButton', () => {
  // T1: trigger button shows current-mode badge
  it('renders the trigger button with current mode badge', () => {
    render(<ModeStatusButton />)
    // The default mode is 'default'. MODE_META.default.badgeLabel === 'default on'.
    const trigger = screen.getByTestId('mode-status-button')
    expect(trigger.textContent).toContain('default on')
    expect(trigger.textContent).toContain('shift+tab')
  })

  // T2: clicking the trigger opens the popover with 5 rows
  it('opens the popover with 5 rows on click', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Five distinct rows, one per mode.
    expect(screen.getByTestId('mode-row-default')).toBeDefined()
    expect(screen.getByTestId('mode-row-acceptEdits')).toBeDefined()
    expect(screen.getByTestId('mode-row-plan')).toBeDefined()
    expect(screen.getByTestId('mode-row-bypassPermissions')).toBeDefined()
    expect(screen.getByTestId('mode-row-dontAsk')).toBeDefined()
  })

  // T3: current-mode row carries data-current="true" and bold title
  it('marks the current mode row with data-current="true"', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    const currentRow = screen.getByTestId('mode-row-default')
    expect(currentRow.getAttribute('data-current')).toBe('true')
    // Title element is the first <span> inside the title block; bold weight = 600 inline.
    const titleSpan = currentRow.querySelector('span > span') as HTMLSpanElement | null
    // The first nested <span> in the row is the ● marker; the title is in
    // a child <div> → first <span> there. Query via querySelectorAll.
    const allSpans = currentRow.querySelectorAll('span')
    const titleEl = Array.from(allSpans).find((s) => s.textContent === 'default')
    expect(titleEl).toBeDefined()
    expect((titleEl as HTMLSpanElement | undefined)?.style.fontWeight).toBe('600')
  })

  // T4: non-current rows carry data-current="false"
  it('marks non-current mode rows with data-current="false"', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    expect(screen.getByTestId('mode-row-acceptEdits').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('mode-row-plan').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('mode-row-bypassPermissions').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('mode-row-dontAsk').getAttribute('data-current')).toBe('false')
  })

  // T5: hovering a row updates data-selected on that row only
  it('marks the hovered row with data-selected="true"', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    const planRow = screen.getByTestId('mode-row-plan')
    fireEvent.mouseEnter(planRow)
    expect(planRow.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('mode-row-default').getAttribute('data-selected')).toBe('false')
    expect(screen.getByTestId('mode-row-acceptEdits').getAttribute('data-selected')).toBe('false')
  })

  // T6: clicking a non-current row calls patchSessionMode
  it('calls patchSessionMode when a non-current mode row is clicked', () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionMode')
      .mockResolvedValue(undefined)
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    fireEvent.click(screen.getByTestId('mode-row-plan'))
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'plan')
  })

  // T7: clicking the current-mode row is a no-op
  it('does not call patchSessionMode when the current mode row is clicked', () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionMode')
      .mockResolvedValue(undefined)
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Current mode is 'default' (no permissionMode set on session) → row is a no-op.
    fireEvent.click(screen.getByTestId('mode-row-default'))
    expect(patchSpy).not.toHaveBeenCalled()
  })

  // T8: with no active session, click is a no-op
  it('does not call patchSessionMode when there is no active session', () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionMode')
      .mockResolvedValue(undefined)
    useAgentStore.setState({ sessionId: null, activeSessionId: null })
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    fireEvent.click(screen.getByTestId('mode-row-acceptEdits'))
    expect(patchSpy).not.toHaveBeenCalled()
  })

  // T9: header shows "Modes" and renders the two keycap-style spans
  it('renders the header with "Modes" title and the ⇧ + tab keycaps', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Title
    const title = screen.getByTestId('mode-picker-title')
    expect(title.textContent).toBe('Modes')
    // Two keycap spans exist: ⇧ and tab. The "+" in between is a plain span.
    const content = screen.getByTestId('mode-picker-content')
    const kbdSpans = Array.from(content.querySelectorAll('span')).filter(
      (s) => s.textContent === '⇧' || s.textContent === 'tab',
    )
    expect(kbdSpans).toHaveLength(2)
    // Both have a border style applied (the KBD_BASE constant).
    kbdSpans.forEach((s) => {
      const inline = (s as HTMLSpanElement).style.border
      expect(inline).toContain('1px solid')
    })
  })

  // T10: each row renders its corresponding antd icon as an SVG
  it('renders an antd icon SVG inside every mode row', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Every row should contain an <svg class="anticon ...">.
    const rows = [
      'mode-row-default',
      'mode-row-acceptEdits',
      'mode-row-plan',
      'mode-row-bypassPermissions',
      'mode-row-dontAsk',
    ]
    for (const testid of rows) {
      const row = screen.getByTestId(testid)
      // AntD icons render as <span class="anticon"><svg>...</svg></span>;
      // the `anticon` class lives on the wrapper span, not the inner <svg>.
      const wrapper = row.querySelector('span.anticon')
      expect(wrapper, `expected antd icon wrapper in ${testid}`).toBeTruthy()
    }
  })
})
