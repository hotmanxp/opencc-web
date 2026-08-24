// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import MobileAgent from '../../../src/web/src/pages/MobileAgent.tsx'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.ts'

// Mock heavy sub-components that MobileAgent depends on
vi.mock('../../../src/web/src/pages/AgentConversation.js', () => ({
  default: () => <div data-testid="agent-conversation">AgentConversation</div>,
}))
vi.mock('../../../src/web/src/components/MobileHeader.js', () => ({
  default: () => <div data-testid="mobile-header">MobileHeader</div>,
}))
vi.mock('../../../src/web/src/components/MobileSessionDrawer.js', () => ({
  default: () => <div data-testid="mobile-session-drawer">MobileSessionDrawer</div>,
}))
vi.mock('../../../src/web/src/components/TaskDrawer.js', () => ({
  TaskDrawer: () => <div data-testid="task-drawer">TaskDrawer</div>,
}))
vi.mock('../../../src/web/src/components/ApproveDrawer.jsx', () => ({
  default: () => <div data-testid="approve-drawer">ApproveDrawer</div>,
}))
vi.mock('../../../src/web/src/components/SettingsDrawer.js', () => ({
  default: () => <div data-testid="settings-drawer">SettingsDrawer</div>,
}))
vi.mock('../../../src/web/src/components/conversation/FilePreviewDrawer.js', () => ({
  FilePreviewDrawer: () => <div data-testid="file-preview-drawer">FilePreviewDrawer</div>,
}))
vi.mock('../../../src/web/src/components/ConfigStatusBar.js', () => ({
  default: () => <div data-testid="config-status-bar">ConfigStatusBar</div>,
}))
vi.mock('../../../src/web/src/components/MobileQuickDrawer.jsx', () => ({
  default: () => <div data-testid="mobile-quick-drawer">MobileQuickDrawer</div>,
}))
vi.mock('../../../src/web/src/components/UpdateNotifier.js', () => ({
  UpdateNotifier: () => <div data-testid="update-notifier">UpdateNotifier</div>,
}))
vi.mock('../../../src/web/src/components/SessionCwdBridge.js', () => ({
  SessionCwdBridge: () => <div data-testid="session-cwd-bridge">SessionCwdBridge</div>,
}))
vi.mock('../../../src/web/src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))
vi.mock('../../../src/web/src/hooks/useSubmitPrompt.js', () => ({
  useSubmitPrompt: () => ({ submitPrompt: vi.fn() }),
}))
vi.mock('../../../src/web/src/hooks/useBashRepl.js', () => ({
  useBashRepl: () => ({ topCommands: [], refreshTopCommands: vi.fn(), exec: vi.fn() }),
}))
vi.mock('../../../src/web/src/hooks/useQuickPrompts.js', () => ({
  useQuickPrompts: () => ({ prompts: [], add: vi.fn(), remove: vi.fn(), clear: vi.fn() }),
}))

beforeEach(() => {
  useAgentStore.setState({
    sessions: [{ id: 's1', createdAt: Date.now() }],
    sessionId: 's1',
    subagentTasksBySession: {},
  })
})

describe('MobileAgent subagent 列表', () => {
  it('有 subagent 时显示折叠面板头部', () => {
    useAgentStore.getState().applySubagentStart({
      type: 'subagent.start',
      ts: 0,
      sessionId: 's1',
      runId: 'r1',
      provider: 'spawn',
      id: 'x',
      local: true,
    })
    const { container } = render(<MobileAgent />)
    // Check the store has the subagent
    const state = useAgentStore.getState()
    expect(state.subagentTasksBySession['s1']?.length).toBe(1)
    // Check the SubagentList appears in the DOM
    const subagentHeader = container.querySelector('.ant-collapse-header')
    expect(subagentHeader).not.toBeNull()
  })
})
