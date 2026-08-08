// @vitest-environment happy-dom
import { describe, expect, test, beforeEach, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentStore, type V2TaskItem } from "../store/useAgentStore.js";
import { useAppStore } from "../store/useAppStore.js";
import { api } from "../lib/api.js";

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

  test("'prompt' branch pushes only the raw /cmd args (no rendered prompt line)", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      type: "prompt",
      payload: { rendered: "Hello alice" },
    } as any)
    await typeAndSubmit("/greet alice")
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      const tail = msgs[msgs.length - 1]
      expect(tail).toMatchObject({ type: "user.text", text: "/greet alice" })
      expect((tail as { isRenderedPrompt?: boolean }).isRenderedPrompt).toBe(
        false,
      )
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
      expect((tail as { isRenderedPrompt?: boolean }).isRenderedPrompt).toBe(false)
    })
  })
})

describe('AgentInputBox — 状态行合并 v2 任务摘要', () => {
  test('空 v2 时状态行只显示 ● 就绪, 不展示任务摘要', () => {
    render(<AgentInputBox />);
    const row = screen.getByTestId('agent-input-status-row');
    expect(row).toHaveTextContent('就绪');
    expect(row).not.toHaveTextContent('任务');
    expect(screen.queryByTestId('agent-input-task-summary')).toBeNull();
  });

  test('有 v2 任务时状态行显示 1/3 任务 · 1 进行中', () => {
    useAgentStore.setState({
      v2TasksBySession: {
        'sess-1': [
          v2('v1', 'a', 'completed'),
          v2('v2', 'b', 'in_progress'),
          v2('v3', 'c', 'pending'),
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

  test('多个 v2 任务完成态时状态行只显示一份合并摘要', () => {
    useAgentStore.setState({
      v2TasksBySession: {
        'sess-1': [
          v2('v1', 'A', 'completed'),
          v2('v2', 'B', 'pending'),
        ],
      },
    })
    render(<AgentInputBox />);
    const summary = screen.getByTestId('agent-input-task-summary');
    expect(summary).toHaveTextContent('1/2 任务');
    expect(summary).toHaveTextContent('1 待开始');
    // 全完成时染绿
    useAgentStore.setState({
      v2TasksBySession: {
        'sess-1': [
          v2('v1', 'A', 'completed'),
          v2('v2', 'B', 'completed'),
        ],
      },
    })
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
      v2TasksBySession: {
        'sess-1': [
          v2('v1', 'a', 'completed'),
          v2('v2', 'b', 'in_progress'),
          v2('v3', 'c', 'pending'),
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
    // 流式期间 opacity 降到 0.7, 让 spinner 抢眼同时任务文字仍可读
    expect((summary as HTMLElement).style.opacity).toBe('0.7');
  });

  // 修复: 状态行任务摘要可点击 → 弹出 TodoDropdown 列出 v2 任务详情.
  // 之前合并到状态行后丢了 onClick, 用户无法查看任务列表.
  test('点击任务摘要展开 popover, 渲染 v2 任务列表', async () => {
    useAgentStore.setState({
      v2TasksBySession: {
        'sess-1': [
          v2('v1', 'in-progress-task', 'in_progress'),
          v2('v2', 'pending-task', 'pending'),
        ],
      },
    })
    render(<AgentInputBox />);
    fireEvent.click(screen.getByTestId('agent-input-task-summary'))
    await waitFor(() => expect(screen.getByTestId('todo-dropdown')).toBeInTheDocument())
    expect(screen.getByTestId('v2-task-dropdown-item-in_progress')).toHaveTextContent('in-progress-task')
    expect(screen.getByTestId('v2-task-dropdown-item-pending')).toHaveTextContent('pending-task')
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

describe('AgentInputBox — share button', () => {
  beforeEach(() => {
    useAppStore.setState({
      instanceContext: {
        cwd: '/tmp',
        cwdName: 'tmp',
        branch: null,
        host: '0.0.0.0',
        port: 9888,
        ips: ['192.168.1.5'],
      },
    });
  });

  test('share button renders', () => {
    render(<AgentInputBox />);
    expect(screen.getByTestId('share-button')).toBeInTheDocument();
  });

  test('share button disabled when no sessionId', () => {
    useAgentStore.setState({ sessionId: null });
    render(<AgentInputBox />);
    expect(screen.getByTestId('share-button')).toBeDisabled();
  });

  test('clicking share button opens popover with IP list', async () => {
    render(<AgentInputBox />);
    fireEvent.click(screen.getByTestId('share-button'));
    await waitFor(() => {
      expect(screen.getByText(/192.168.1.5/)).toBeInTheDocument();
    });
  });
})

describe('AgentInputBox — 移动端 [⚡] 按钮', () => {
  it('isMobile=true 时渲染 mobile-quick-drawer-toggle,点击触发 setQuickDrawerOpen(true)', () => {
    useAppStore.setState({ isMobile: true, quickDrawerOpen: false })
    render(<AgentInputBox />)
    const btn = screen.getByTestId('mobile-quick-drawer-toggle')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(useAppStore.getState().quickDrawerOpen).toBe(true)
  })

  it('isMobile=false 时不渲染该按钮', () => {
    useAppStore.setState({ isMobile: false })
    render(<AgentInputBox />)
    expect(screen.queryByTestId('mobile-quick-drawer-toggle')).toBeNull()
  })
})

// 修复: 首条带图片附件的消息发出去后, UI 必须渲染 user.text + 图片缩略图.
// commit 87a44c0a (Jul 26 2026) 误删图片分支的 pushUserMsg, 用错误的"UI 走 transcript
// 刷新路径"注释掩盖, 实际 loadTranscript 从未在 send 后触发, 首条带图消息不渲染.
// 回归测试: 上传一张图 + 输入文字, 点发送 → store 必须立即多一条 user.text 且
// attachments 非空.
describe('AgentInputBox — 消息排队 (追齐 OPENCC)', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
    useAgentStore.setState({
      status: 'streaming',
      queuedPrompts: [],
      messages: [],
      sendSeq: 0,
    })
  })

  test('streaming 时输入框不禁用', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    expect(ta.disabled).toBe(false)
  })

  test('streaming 时发送: 后端响应 queued:true → 不 push user.text (消息排队等待)', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      sessionId: 'sess-1',
      queued: true,
      queueLength: 1,
      pending: [{ id: 'q1', text: 'second message' }],
    } as any)
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'second message' } })
    fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter', shiftKey: false })
    await waitFor(() => expect(vi.mocked(api.post)).toHaveBeenCalled())
    // 排队消息不立即写 transcript — 由 queue.changed 事件在真正开始执行时写入
    expect(useAgentStore.getState().messages).toEqual([])
  })

  test('排队预览区渲染 queuedPrompts, 点 × 取消', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ removed: true } as any)
    useAgentStore.setState({
      queuedPrompts: [
        { id: 'q1', text: 'first queued' },
        { id: 'q2', text: 'second queued' },
      ],
    })
    render(<AgentInputBox />)
    const preview = screen.getByTestId('queued-prompts-preview')
    expect(preview).toHaveTextContent('first queued')
    expect(preview).toHaveTextContent('second queued')
    // 点 q1 的取消按钮 → POST /agent/queue/cancel
    const q1 = screen.getByTestId('queued-prompt-q1')
    const cancelBtn = q1.querySelector('button')
    fireEvent.click(cancelBtn!)
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/agent/queue/cancel',
        expect.objectContaining({ sessionId: 'sess-1', promptId: 'q1' }),
      ),
    )
    // 本地立即移除, 避免闪烁
    expect(
      useAgentStore.getState().queuedPrompts.map((p) => p.id),
    ).not.toContain('q1')
  })

  test('排队消息开始执行(从 queuedPrompts 消失)→ pushUserMsg 写入 transcript', async () => {
    useAgentStore.setState({
      queuedPrompts: [{ id: 'q1', text: 'first queued' }],
      messages: [],
    })
    render(<AgentInputBox />)
    // 模拟后端 queue.changed: q1 被消费开始执行, 从排队列表消失
    act(() => {
      useAgentStore.setState({ queuedPrompts: [] })
    })
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      expect(
        msgs.some(
          (m) => (m as { type?: string }).type === 'user.text' && (m as { text?: string }).text === 'first queued',
        ),
      ).toBe(true)
    })
  })

  test('挂载时队列已有消息, 消息被消费 → 仍 push 到 transcript(不依赖 render 中间态)', async () => {
    // 组件挂载时 queuedPrompts 已含 q1(reload / HMR 后队列非空), 直接消费消失。
    useAgentStore.setState({
      queuedPrompts: [{ id: 'q1', text: 'mount queued' }],
      messages: [],
    })
    render(<AgentInputBox />)
    act(() => {
      useAgentStore.setState({ queuedPrompts: [] })
    })
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      expect(
        msgs.some(
          (m) => (m as { type?: string }).type === 'user.text' && (m as { text?: string }).text === 'mount queued',
        ),
      ).toBe(true)
    })
  })

  test('被取消的排队消息不写 transcript', async () => {
    useAgentStore.setState({
      queuedPrompts: [{ id: 'q1', text: 'to be canceled' }],
      messages: [],
    })
    render(<AgentInputBox />)
    // 用户点取消
    const q1 = screen.getByTestId('queued-prompt-q1')
    fireEvent.click(q1.querySelector('button')!)
    await waitFor(() =>
      expect(
        useAgentStore.getState().queuedPrompts.map((p) => p.id),
      ).not.toContain('q1'),
    )
    // 模拟 queue.changed 确认移除(重复移除 no-op)
    act(() => {
      useAgentStore.setState({ queuedPrompts: [] })
    })
    expect(
      useAgentStore.getState().messages.some(
        (m) => (m as { text?: string }).text === 'to be canceled',
      ),
    ).toBe(false)
  })
})

describe('AgentInputBox — 首条消息带图片附件时 UI 立即渲染', () => {
  beforeAll(() => {
    // happy-dom 没有 URL.createObjectURL/revokeObjectURL, 提前注入避免抛错.
    if (typeof (URL as any).createObjectURL !== 'function') {
      ;(URL as any).createObjectURL = vi.fn(() => 'blob:mock')
    }
    if (typeof (URL as any).revokeObjectURL !== 'function') {
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })

  beforeEach(() => {
    vi.mocked(api.post).mockReset()
    vi.mocked(api.post).mockResolvedValue({ sessionId: 'sess-new' } as any)
  })

  it('图片 + 文字一起发: store 立即新增一条带 attachments 的 user.text', async () => {
    // vi.spyOn readImageAsBase64 立刻 resolve, 不依赖 vi.doMock 模块缓存.
    const imageReader = await import('../lib/imageReader.js')
    const spy = vi
      .spyOn(imageReader, 'readImageAsBase64')
      .mockResolvedValue({
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,AAA',
        size: 1024,
        filename: 'pasted.png',
      })
    try {
      render(<AgentInputBox />)
      const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
      fireEvent.change(ta, { target: { value: 'describe this' } })

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['fake-bytes'], 'pasted.png', { type: 'image/png' })
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fireEvent.change(fileInput)

      // 等 spy 至少被调一次 + addAttachments 内部 setState 把状态切到 ready.
      await waitFor(() => expect(spy).toHaveBeenCalled())

      // 点发送
      fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter', shiftKey: false })

      // /agent/prompt 必须被调用一次 (说明 attachments 走完了 addAttachments 路径)
      await waitFor(() =>
        expect(vi.mocked(api.post)).toHaveBeenCalledWith(
          '/agent/prompt',
          expect.objectContaining({
            prompt: 'describe this',
            contentBlocks: expect.any(Array),
          }),
          expect.anything(),
        ),
      )

      const msgs = useAgentStore.getState().messages
      const userMsg = msgs.find(
        (m) =>
          (m as { type?: string }).type === 'user.text' &&
          (m as { text?: string }).text === 'describe this',
      )
      expect(userMsg).toBeDefined()
      expect((userMsg as { attachments?: unknown[] }).attachments).toBeDefined()
      expect(((userMsg as { attachments?: unknown[] }).attachments ?? []).length).toBe(1)
      expect((userMsg as { isRenderedPrompt?: boolean }).isRenderedPrompt).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('仅图片 (无文字) 也能渲染 user.text', async () => {
    const imageReader = await import('../lib/imageReader.js')
    const spy = vi
      .spyOn(imageReader, 'readImageAsBase64')
      .mockResolvedValue({
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,AAA',
        size: 1024,
        filename: 'pasted.png',
      })
    try {
      render(<AgentInputBox />)
      const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['fake-bytes'], 'pasted.png', { type: 'image/png' })
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fireEvent.change(fileInput)

      await waitFor(() => expect(spy).toHaveBeenCalled())

      fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter', shiftKey: false })

      await waitFor(() => {
        const msgs = useAgentStore.getState().messages
        const userMsg = msgs.find((m) => (m as { type?: string }).type === 'user.text')
        expect(userMsg).toBeDefined()
        expect((userMsg as { text?: string }).text).toBe('')
        expect((userMsg as { attachments?: unknown[] }).attachments?.length).toBe(1)
      })
    } finally {
      spy.mockRestore()
    }
  })
})
