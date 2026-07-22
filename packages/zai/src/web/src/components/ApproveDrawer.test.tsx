// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ApproveDrawer from './ApproveDrawer.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  cleanup()
  useAgentStore.setState({
    pendingApprove: null,
    pendingAsk: null,
    sessionId: 's1',
  } as any)
  // @ts-ignore — silence fetch mock
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
})

function setPendingWith(content = '# Hello\n\nThis is content.'): void {
  useAgentStore.setState({
    pendingApprove: {
      toolUseId: 'tu-1',
      sessionId: 's1',
      title: 'My Plan',
      summary: 'Quick summary',
      content,
      displayPath: null,
      decision: null,
      comment: '',
      status: 'pending',
    },
  } as any)
}

describe('ApproveDrawer', () => {
  test('no pending → drawer closed (cannot find open button text)', () => {
    render(<ApproveDrawer />)
    // AntD renders title text inside drawer header only when open.
    expect(screen.queryByText('My Plan')).toBeNull()
  })

  test('renders markdown content when pending', () => {
    setPendingWith()
    render(<ApproveDrawer />)
    expect(screen.getByText('My Plan')).toBeDefined()
    expect(screen.getByText('Hello')).toBeDefined()
    expect(screen.getByText('Quick summary')).toBeDefined()
  })

  test('shows file source path when displayPath is set', () => {
    useAgentStore.setState({
      pendingApprove: {
        toolUseId: 'tu-1', sessionId: 's1', title: 'Plan',
        content: 'content', displayPath: 'docs/plan.md',
        decision: null, comment: '', status: 'pending',
      },
    } as any)
    render(<ApproveDrawer />)
    expect(screen.getByText(/docs\/plan\.md/)).toBeDefined()
  })

  test('approve button calls submitApprove("approved") with empty comment', async () => {
    setPendingWith()
    render(<ApproveDrawer />)
    const approveBtn = screen.getByRole('button', { name: /approve/i })
    fireEvent.click(approveBtn)
    await waitFor(() => {
      expect(useAgentStore.getState().pendingApprove?.status).toBe('submitting')
    })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/agent/approve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Session-Id': 's1' }),
        body: JSON.stringify({ toolUseId: 'tu-1', decision: 'approved' }),
      }),
    )
  })

  test('reject with comment → POST decision="rejected", comment included', async () => {
    setPendingWith()
    render(<ApproveDrawer />)
    const ta = screen.getByTestId('approve-drawer-comment') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'fix the API section' } })
    // Comment now non-empty → reject button enabled and direct (no Popconfirm).
    const rejBtn = screen.getByRole('button', { name: /reject/i })
    fireEvent.click(rejBtn)
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled()
    })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/agent/approve',
      expect.objectContaining({
        body: JSON.stringify({ toolUseId: 'tu-1', decision: 'rejected', comment: 'fix the API section' }),
      }),
    )
  })

  test('reject with empty comment → submits will error out client-side', async () => {
    setPendingWith()
    render(<ApproveDrawer />)
    // Empty comment means a Popconfirm wraps the Reject button. Click it.
    const rejBtn = screen.getByRole('button', { name: /reject/i })
    fireEvent.click(rejBtn)
    // The Popconfirm's "Reject anyway" appears.
    const confirm = await screen.findByText('Reject anyway')
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(useAgentStore.getState().pendingApprove?.status).toBe('submitting')
    })
  })
})
