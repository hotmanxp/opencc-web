// @vitest-environment happy-dom
import { describe, expect, test, beforeEach, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentStore, type TodoItem, type V2TaskItem } from "../store/useAgentStore.js";
import { api } from "../lib/api.js";

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({
  content, status, activeForm: content,
});
const v2 = (id: string, subject: string, status: V2TaskItem["status"]): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0,
});

import AgentInputBox from "./AgentInputBox.js";

// 避免 ConversationInfoButton / api 等副作用; 只关注状态行渲染.
vi.mock("../components/ConversationInfoButton.js", () => ({
  default: () => null,
}))
vi.mock("../lib/api.js", () => ({
  api: {
    post: vi.fn(async () => ({})),
  },
}))

// AgentInputBox 挂载时调裸 fetch("/api/slash") 拉 slash items. 之前没 mock
// → happy-dom 触发真请求 → ECONNREFUSED,导致整个 describe 挂掉. 我们只关心
// transcript-collapse 按钮的渲染,不关心 slash 数据,直接 resolve 一个空 items.
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  )
})

beforeEach(() => {
  useAgentStore.setState({
    sessionId: 'sess-1',
    messages: [],
    status: 'idle',
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    todosBySession: {},
    v2TasksBySession: {},
  })
})

describe('AgentInputBox — slash command UI visibility', () => {
  // mockReset to clear any default-return setup other suites may have left.
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
  })

  async function typeAndSubmit(text: string) {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: text } })
    fireEvent.keyDown(ta, { key: "Enter", code: "Enter", shiftKey: false })
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
  }

  test("'prompt' branch pushes the raw /cmd args and a rendered user.text", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      type: "prompt",
      payload: { rendered: "Hello alice" },
    } as any)
    await typeAndSubmit("/greet alice")
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      const tail = msgs.slice(-2)
      expect(tail[0]).toMatchObject({ type: "user.text", text: "/greet alice" })
      expect(tail[1]).toMatchObject({
        type: "user.text",
        text: "Hello alice",
        isRenderedPrompt: true,
      })
    })
  })

  test("'unknown' branch pushes exactly one user.text without isRenderedPrompt", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      type: "unknown",
      payload: { input: "/greet" },
    } as any)
    useAgentStore.setState({
      sessionId: "sess-1",
      messages: [],
      status: "idle",
      sendSeq: 0,
    })
    await typeAndSubmit("/greet alice")
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      const tail = msgs[msgs.length - 1]
      expect(tail).toMatchObject({ type: "user.text", text: "/greet alice" })
      expect((tail as { isRenderedPrompt?: boolean }).isRenderedPrompt).toBeUndefined()
    })
  })
})

describe('AgentInputBox — 状态行合并任务摘要', () => {
  test('空 todos + 空 v2 时状态行只显示 ● 就绪, 不展示任务摘要', () => {
    render(<AgentInputBox />);
    const row = screen.getByTestId('agent-input-status-row');
    expect(row).toHaveTextContent('就绪');
    expect(row).not.toHaveTextContent('任务');
    expect(screen.queryByTestId('agent-input-task-summary')).toBeNull();
  });

  test('有 todos 时状态行显示 1/3 任务 · 1 进行中', () => {
    useAgentStore.setState({
      todosBySession: {
        'sess-1': [
          todo('a', 'completed'),
          todo('b', 'in_progress'),
          todo('c', 'pending'),
        ],
      },
    })
    render(<AgentInputBox />);
    const row = screen.getByTestId('agent-input-status-row');
    expect(row).toHaveTextContent('就绪');
    const summary = screen.getByTestId('agent-input-task-summary');
    expect(summary).toHaveTextContent('1/3 任务');
    expect(summary).toHaveTextContent('1 进行中');
    expect(summary).toHaveTextContent('1 待开始');
  });

  test('合并 todos + v2 时状态行只显示一份合并摘要', () => {
    useAgentStore.setState({
      todosBySession: {
        'sess-1': [todo('old', 'completed')],
      },
      v2TasksBySession: {
        'sess-1': [
          v2('v1', 'A', 'completed'),
          v2('v2', 'B', 'pending'),
        ],
      },
    })
    render(<AgentInputBox />);
    const summary = screen.getByTestId('agent-input-task-summary');
    expect(summary).toHaveTextContent('2/3 任务');
    expect(summary).toHaveTextContent('1 待开始');
    // 全完成时染绿
    useAgentStore.setState({
      todosBySession: { 'sess-1': [todo('a', 'completed')] },
      v2TasksBySession: { 'sess-1': [v2('v1', 'A', 'completed')] },
    })
    useAgentStore.setState({
      todosBySession: { 'sess-1': [todo('a', 'completed'), todo('b', 'completed')] },
      v2TasksBySession: { 'sess-1': [] },
    })
    // 第二个 setState 会触发合并后的状态, 此时 2/2 全完成
    render(<AgentInputBox />);
    // 第二次 render 之前 store 已更新, summary 应该反映 2/2 全完成
    // 注: render 是独立调用, 上一个组件已卸载, 此处只校验最后一次 store 状态.
    const summary2 = screen.getAllByTestId('agent-input-task-summary').at(-1)!;
    expect(summary2).toHaveTextContent('2/2 任务');
  });

  test('stream 期间状态行仍显示任务摘要 (降透明, 不再隐藏)', () => {
    // 修复: 之前 streaming 时整段任务摘要不渲染, 用户反馈"对话进行中时被
    // 遮挡/看不到任务进度". 现在改为始终渲染, 流式期间 opacity 降到 0.65
    // 让 spinner (✶✷✸✹) 抢视觉焦点, 任务数字保留可读.
    useAgentStore.setState({ status: 'streaming' });
    useAgentStore.setState({
      todosBySession: {
        'sess-1': [
          todo('a', 'completed'),
          todo('b', 'in_progress'),
          todo('c', 'pending'),
        ],
      },
    })
    render(<AgentInputBox />);
    const row = screen.getByTestId('agent-input-status-row');
    expect(row).toHaveTextContent('对话中…');
    // 摘要仍在, 不再被条件渲染剥除
    const summary = screen.getByTestId('agent-input-task-summary');
    expect(summary).toHaveTextContent('1/3 任务');
    expect(summary).toHaveTextContent('1 进行中');
    expect(summary).toHaveTextContent('1 待开始');
    // 流式期间 opacity 降到 0.65, 让 spinner 抢眼
    expect((summary as HTMLElement).style.opacity).toBe('0.65');
  });

  // 修复: 状态行任务摘要可点击 → 弹出 TodoDropdown 列出 todo + v2 详情.
  // 之前合并到状态行后丢了 onClick, 用户无法查看任务列表.
  test('点击任务摘要展开 popover, 渲染合并的 todo + v2 列表', async () => {
    useAgentStore.setState({
      todosBySession: {
        'sess-1': [todo('old', 'in_progress')],
      },
      v2TasksBySession: {
        'sess-1': [v2('v1', 'A', 'pending')],
      },
    })
    render(<AgentInputBox />);
    fireEvent.click(screen.getByTestId('agent-input-task-summary'))
    await waitFor(() => expect(screen.getByTestId('todo-dropdown')).toBeInTheDocument())
    expect(screen.getByTestId('todo-dropdown-item-in_progress')).toHaveTextContent('old')
    expect(screen.getByTestId('v2-task-dropdown-item-pending')).toHaveTextContent('A')
  });
})

describe('AgentInputBox — 右侧分屏 toggle (split-pane)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('默认渲染在状态行最右侧, 默认关闭', () => {
    render(<AgentInputBox />)
    const btn = screen.getByTestId('split-pane-toggle-inputbox')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  test('点击翻转并写入 STORAGE_KEYS.open, 再次点击翻回', () => {
    render(<AgentInputBox />)
    const btn = screen.getByTestId('split-pane-toggle-inputbox')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('zai.splitPane.open')).toBe('true')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem('zai.splitPane.open')).toBe('false')
  })

  test('已打开状态下刷新 (新挂载) 直接读取 localStorage 进入开启态', () => {
    localStorage.setItem('zai.splitPane.open', 'true')
    render(<AgentInputBox />)
    const btn = screen.getByTestId('split-pane-toggle-inputbox')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('AgentInputBox — transcript lock (分屏开启时不渲染折叠按钮)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('splitPaneOpen=false → transcript-collapse 按钮可被查到', () => {
    render(<AgentInputBox />)
    expect(screen.getByTestId('transcript-collapse-button')).toBeInTheDocument()
  })

  test('splitPaneOpen=true → transcript-collapse 按钮完全不渲染', () => {
    localStorage.setItem('zai.splitPane.open', 'true')
    render(<AgentInputBox />)
    expect(screen.queryByTestId('transcript-collapse-button')).toBeNull()
  })

  test('点击 transcript-collapse 按钮在 unlocked 态可翻转 transcriptCollapsed', () => {
    render(<AgentInputBox />)
    const before = useAgentStore.getState().transcriptCollapsed
    fireEvent.click(screen.getByTestId('transcript-collapse-button'))
    const after = useAgentStore.getState().transcriptCollapsed
    expect(after).toBe(!before)
  })

  test('splitPaneOpen=true 时 transcriptCollapsed 已被 hook 锁为 true', () => {
    useAgentStore.setState({ transcriptCollapsed: false })
    localStorage.setItem('zai.splitPane.open', 'true')
    render(<AgentInputBox />)
    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
    expect(screen.queryByTestId('transcript-collapse-button')).toBeNull()
  })
})