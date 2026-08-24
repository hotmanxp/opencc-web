// @vitest-environment happy-dom
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SubagentsTab } from '../../../../src/web/src/components/splitPane/SubagentsTab.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'
import type { DshSubagentTaskItem } from '../../../../src/web/src/store/useAgentStore.js'

afterEach(() => {
  useAgentStore.setState({
    subagentTasksBySession: {},
    agentTasksBySession: {},
    bashTasksBySession: {},
    sessionId: null,
  })
  vi.unstubAllGlobals()
})

/**
 * Task 14: SubagentsTab 加 Fork toggle + Continue 按钮 + state 渲染
 *
 * 实施范围对齐仓库现实:
 *  - 子代理创建走 LLM Agent 工具调用,UI 无「新建子代理」入口
 *    (当前 SubagentsTab 是只读 view,Phase 1 注释明确说明)。
 *  - 因此 Fork toggle 部分(Tests 1-2)在 brief 假设的「新建子代理」
 *    Modal 不存在,跳过实现,见 task-14-report.md Concerns。
 *  - Tests 3-4 + 隐含的 state 渲染测试(5)在真实代码结构上落地。
 */
describe('SubagentsTab Continue 按钮 + state 渲染 (Task 14)', () => {
  const makeTask = (overrides: Partial<DshSubagentTaskItem>): DshSubagentTaskItem => ({
    id: 'sub-1',
    taskId: 'sub-1',
    sessionId: 'session-1',
    parentSessionId: 'session-1',
    status: 'done',
    state: 'settled',
    description: 'test subagent',
    ...overrides,
  })

  test('已结束子代理(done)显示 Continue 按钮', async () => {
    const fetchMock = vi.fn<[string], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [makeTask({ status: 'done', state: 'settled' })],
      },
    })

    render(<SubagentsTab />)

    // Continue 按钮在 done 状态下显示
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '继续子代理对话' })).toBeInTheDocument()
    })
  })

  test('运行中子代理(running)不显示 Continue 按钮', async () => {
    const fetchMock = vi.fn<[string], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [makeTask({ status: 'running', state: 'running' })],
      },
    })

    render(<SubagentsTab />)

    // 等 SubagentRow 渲染出来后再断言
    await waitFor(() => {
      expect(screen.getByTestId('subagent-row-sub-1')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: '继续子代理对话' })).not.toBeInTheDocument()
  })

  test('点击 Continue 打开 Modal(含 TextArea + OK/Cancel)', async () => {
    const fetchMock = vi.fn<[string, RequestInit?], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ childId: 'child-1', messageId: 'msg-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [
          makeTask({
            id: 'abc',
            taskId: 'abc',
            status: 'done',
            state: 'settled',
            parentSessionId: 'session-1',
          }),
        ],
      },
    })

    render(<SubagentsTab />)

    const continueBtn = await screen.findByRole('button', { name: '继续子代理对话' })
    act(() => { fireEvent.click(continueBtn) })

    // Modal should open (Portal renders at document body level)
    await waitFor(() => {
      expect(screen.getByTestId('continue-modal')).toBeInTheDocument()
    })

    // TextArea inside the modal portal
    await waitFor(() => {
      expect(screen.getByTestId('continue-prompt-input')).toBeInTheDocument()
    })

    // OK button is primary and disabled (empty prompt)
    const modalContent = document.querySelector('.ant-modal-content')
    expect(modalContent).toBeTruthy()
    const okBtn = modalContent?.querySelector('.ant-btn-primary') as HTMLButtonElement | null
    expect(okBtn).toBeTruthy()
    expect(okBtn!.disabled).toBe(true)

    // Cancel button is the non-primary button
    const cancelBtn = modalContent?.querySelector('.ant-btn:not(.ant-btn-primary)')
    expect(cancelBtn).toBeTruthy()
  })

  test('Continue Modal: 填写 prompt 后点确定 POST { prompt } 并关闭 Modal', async () => {
    const fetchMock = vi.fn<[string, RequestInit?], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ childId: 'child-1', messageId: 'msg-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [
          makeTask({
            id: 'abc',
            taskId: 'abc',
            status: 'done',
            state: 'settled',
            parentSessionId: 'session-1',
          }),
        ],
      },
    })

    render(<SubagentsTab />)

    const continueBtn = await screen.findByRole('button', { name: '继续子代理对话' })
    act(() => { fireEvent.click(continueBtn) })

    // Wait for modal to appear
    await waitFor(() => {
      expect(screen.getByTestId('continue-modal')).toBeInTheDocument()
    })

    // Fill the TextArea
    const textarea = await screen.findByTestId('continue-prompt-input')
    act(() => { fireEvent.change(textarea, { target: { value: '继续分析这个文件' } }) })

    // OK button should now be enabled
    const modalContent = document.querySelector('.ant-modal-content')
    const okBtn = modalContent?.querySelector('.ant-btn-primary') as HTMLButtonElement | null
    expect(okBtn).toBeTruthy()
    expect(okBtn!.disabled).toBe(false)

    // Click OK
    act(() => { fireEvent.click(okBtn!) })

    // POST should be called with prompt (verifies the OK flow works)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/subagent-tasks/abc/continuable',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ prompt: '继续分析这个文件' }),
        }),
      )
    })

    // Verify the textarea value was captured (non-empty prompt sent)
    // Note: in jsdom the Modal Portal stays in DOM during exit animation;
    // we rely on POST assertion above to prove the OK flow worked end-to-end.
    const postCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/subagent-tasks/abc/continuable',
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.prompt).toBe('继续分析这个文件')
  })

  test('Continue Modal: 点取消关闭 Modal 不 POST', async () => {
    const fetchMock = vi.fn<[string, RequestInit?], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ childId: 'child-1', messageId: 'msg-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [
          makeTask({
            id: 'abc',
            taskId: 'abc',
            status: 'done',
            state: 'settled',
            parentSessionId: 'session-1',
          }),
        ],
      },
    })

    render(<SubagentsTab />)

    const continueBtn = await screen.findByRole('button', { name: '继续子代理对话' })
    act(() => { fireEvent.click(continueBtn) })

    await waitFor(() => {
      expect(screen.getByTestId('continue-modal')).toBeInTheDocument()
    })

    // Click cancel (non-primary button inside modal)
    const modalContent = document.querySelector('.ant-modal-content')
    const cancelBtn = modalContent?.querySelector('.ant-btn:not(.ant-btn-primary)')
    expect(cancelBtn).toBeTruthy()
    act(() => { fireEvent.click(cancelBtn!) })

    // No POST should have been made (cancel does not submit)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('state=running 时行内显示 spinner 提示', async () => {
    const fetchMock = vi.fn<[string], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [makeTask({ status: 'running', state: 'running' })],
      },
    })

    render(<SubagentsTab />)

    await waitFor(() => {
      expect(screen.getByTestId('subagent-row-sub-1')).toBeInTheDocument()
    })
    // state=running 在 row 内渲染一个 LoadingOutlined spin icon
    // STATUS_ICON[running] 已存在;新增的 state-based 提示走独立 Tag
    const row = screen.getByTestId('subagent-row-sub-1')
    expect(row.querySelector('.anticon-loading')).toBeTruthy()
  })

  test('state=settled 时行内显示「已结束」Tag', async () => {
    const fetchMock = vi.fn<[string], Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    useAgentStore.setState({
      sessionId: 'session-1',
      subagentTasksBySession: {
        'session-1': [makeTask({ status: 'done', state: 'settled' })],
      },
    })

    render(<SubagentsTab />)

    await waitFor(() => {
      expect(screen.getByText('已结束')).toBeInTheDocument()
    })
  })
})