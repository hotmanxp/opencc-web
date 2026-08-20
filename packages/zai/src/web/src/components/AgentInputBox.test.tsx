// @vitest-environment happy-dom
import { describe, expect, test, beforeEach, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentStore, type V2TaskItem } from "../store/useAgentStore.js";
import { useAppStore } from "../store/useAppStore.js";
import { api } from "../lib/api.js";
import { AGENT_INPUT_INSERT_EVENT } from "../lib/agentInputEvents.js";

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
// → happy-dom 触发真请求 → ECONNREFUSED,导致整个 describe 挂掉. 这里 stub
// 出 handoff builtin 命令项,让 web composer 输入 `/` 触发下拉时能看到它;
// 测试不需要关注其它 slash 数据.
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              kind: "command",
              name: "handoff",
              description: "交接当前会话:消息多时生成交接文档,消息少时恢复最近的交接",
              argumentHint: "[--pick <filename>]",
              type: "prompt",
              source: "builtin",
              isBuiltIn: true,
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
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

  test("'/' 触发下拉里出现 handoff builtin 命令", async () => {
    // /api/slash mock (above beforeAll) 已返回 handoff 项.
    // 输入 "/" 后 dropdown 应该列出 handoff 命令.
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "/" } })
    // 等 slash items 异步加载 + dropdown 渲染
    await waitFor(() => {
      expect(screen.getByText("/handoff")).toBeInTheDocument()
    })
  })
})

// Mirror-backdrop 高亮: 输入 `/<已知命令名>` 时在输入框内把 token 染紫,
// 视觉与下方 slash dropdown 紫色块对齐。普通文本路径不渲染 backdrop
// (避免无谓的 DOM 与样式开销)。
describe('AgentInputBox — 已知命令输入框内 token 高亮', () => {
  // 触发 slash items 异步加载 + 等待 dropdown 渲染出 /handoff。
  // 不能直接测内部 state — slashItems 内部 state 加载完成才进 deriveCommandToken。
  // 必须先用 "/" 让 fetch mock resolve 后 dropdown 显示 handoff,说明 items 已加载。
  async function loadSlashItemsAndReset(ta: HTMLTextAreaElement) {
    fireEvent.change(ta, { target: { value: "/" } })
    await waitFor(() => {
      expect(screen.getByText("/handoff")).toBeInTheDocument()
    })
    // 清空,避免影响下一个用例的断言
    fireEvent.change(ta, { target: { value: "" } })
  }

  test('输入开头为已知命令名, backdrop 渲染带 mark 的 /name 紫色块', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    await loadSlashItemsAndReset(ta)
    // 输入 "/handoff some args" 触发高亮
    fireEvent.change(ta, { target: { value: "/handoff some args" } })
    const backdrop = await waitFor(() => {
      const el = document.querySelector('[data-input-backdrop]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(backdrop.getAttribute('data-decoration')).toBe('token')
    // mark 内文本 = "/handoff" (不含尾部空格, 贴齐 deepseek-harness 行为)
    const mark = backdrop.querySelector('[data-decoration="token-mark"]')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('/handoff')
    // backdrop 整段 = 原 input (mark 文本 + 普通 span 文本),逐字对齐 antd textarea 文本
    expect(backdrop.textContent).toBe('/handoff some args')
  })

  test('输入开头为未知命令名, 不渲染 backdrop', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    await loadSlashItemsAndReset(ta)
    fireEvent.change(ta, { target: { value: "/totally-unknown-cmd" } })
    // backdrop 不挂载 (装饰层对未知命令短路, 避免误染普通文本)
    expect(document.querySelector('[data-input-backdrop]')).toBeNull()
  })

  test('输入不以 / 起首, 不渲染 backdrop', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    await loadSlashItemsAndReset(ta)
    fireEvent.change(ta, { target: { value: "plain text no slash" } })
    expect(document.querySelector('[data-input-backdrop]')).toBeNull()
  })

  test('输入框清空 / 输入变普通文本后, backdrop 立即卸载', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    await loadSlashItemsAndReset(ta)
    // 进入高亮态
    fireEvent.change(ta, { target: { value: "/handoff " } })
    await waitFor(() => {
      expect(document.querySelector('[data-input-backdrop]')).not.toBeNull()
    })
    // 切回普通文本 → backdrop 立即消失
    fireEvent.change(ta, { target: { value: "no longer a command" } })
    await waitFor(() => {
      expect(document.querySelector('[data-input-backdrop]')).toBeNull()
    })
  })

  test('已知命令名前缀匹配 (输入 /hando 但 slashItems 没 /hando 条目), 不渲染 backdrop', async () => {
    // handoff 是完整 name,/hando 是部分匹配 — deriveCommandToken 只在
    // 完整 word match 时返回高亮,避免把"前缀巧合"的输入也染紫。
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    await loadSlashItemsAndReset(ta)
    fireEvent.change(ta, { target: { value: "/hando" } })
    expect(document.querySelector('[data-input-backdrop]')).toBeNull()
  })

  test('TextArea 文本在 high-light 模式下变为透明 (textarea fill-color: transparent)', async () => {
    // 验证 styles.textarea 注入确实生效 — backdrop 接管可见文本,
    // textarea 仅保留 caret / selection。
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    await loadSlashItemsAndReset(ta)
    fireEvent.change(ta, { target: { value: "/handoff" } })
    await waitFor(() => {
      expect(document.querySelector('[data-input-backdrop]')).not.toBeNull()
    })
    // styles.textarea.color === 'transparent' 由 antd 内联 style 应用到
    // 原生 textarea 元素。直接读 DOM 上的 style 属性。
    const innerTa = document.querySelector('textarea') as HTMLTextAreaElement
    expect(innerTa.style.color).toBe('transparent')
    expect(innerTa.style.caretColor).toBeTruthy()
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

  test('有 v2 任务时状态行显示 1/3 任务', () => {
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
    // 修复: 状态行不再展示"进行中"/"待开始"分项, 用户点摘要看 TodoDropdown 详情.
    expect(summary).not.toHaveTextContent('进行中');
    expect(summary).not.toHaveTextContent('待开始');
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
    expect(summary).not.toHaveTextContent('待开始');
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
    expect(summary).not.toHaveTextContent('进行中');
    expect(summary).not.toHaveTextContent('待开始');
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

  it('streaming 中带图片发送: 拦截不提交(图片不排队, 避免双显)', async () => {
    useAgentStore.setState({ status: 'streaming', messages: [], sendSeq: 0 })
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
      await waitFor(() => expect(spy).toHaveBeenCalled())
      fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter', shiftKey: false })
      // 拦截: 不调 /agent/prompt, 不写 user.text
      expect(vi.mocked(api.post)).not.toHaveBeenCalledWith(
        '/agent/prompt',
        expect.anything(),
        expect.anything(),
      )
      expect(
        useAgentStore.getState().messages.some(
          (m) => (m as { type?: string }).type === 'user.text',
        ),
      ).toBe(false)
    } finally {
      spy.mockRestore()
      useAgentStore.setState({ status: 'idle' })
    }
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

describe('AgentInputBox — 插入对话 (分屏文件管理 agent-input-insert 事件)', () => {
  const INSERT_TEXT = 'src/index.ts'

  test('事件后把相对路径插入到光标处, 光标落在路径末尾', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'look at now!' } })
    // happy-dom 20.10.6 未实现 textarea selection API(selectionStart 读出
    // undefined → 生产代码会退化为追加末尾),用实例访问器模拟「光标在
    // 'look at ' 与 'now!' 之间 (index 8)」,语义与真实浏览器一致。若
    // happy-dom 自带 setSelectionRange,它只更新内部槽、绕不开访问器,
    // 需一并覆盖,让生产代码两条设光标路径都落进同一个 sel。
    let sel = 8
    Object.defineProperty(ta, 'selectionStart', {
      configurable: true,
      get: () => sel,
      set: (v: number) => { sel = v },
    })
    Object.defineProperty(ta, 'selectionEnd', {
      configurable: true,
      get: () => sel,
      set: (v: number) => { sel = v },
    })
    ta.setSelectionRange = (start: number, end: number) => { sel = end }
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: INSERT_TEXT } }),
        )
      })
      await waitFor(() => expect(ta.value).toBe('look at src/index.tsnow!'))
      // rAF 后光标应落在插入文本末尾
      await waitFor(() => expect(ta.selectionStart).toBe(8 + INSERT_TEXT.length))
    } finally {
      Reflect.deleteProperty(ta, 'selectionStart')
      Reflect.deleteProperty(ta, 'selectionEnd')
    }
  })

  test('空输入框时插入相对路径', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: INSERT_TEXT } }),
      )
    })
    await waitFor(() => expect(ta.value).toBe(INSERT_TEXT))
  })

  test('已有内容且 selection API 缺失时退化为追加到末尾', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'look at now!' } })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: INSERT_TEXT } }),
      )
    })
    await waitFor(() => expect(ta.value).toBe('look at now!src/index.ts'))
  })

  test('detail 缺 text 时不写入输入框', async () => {
    render(<AgentInputBox />)
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: {} }))
    })
    expect(ta.value).toBe('')
  })
})

describe('AgentInputBox — 拖拽文件: 图片入附件, 其他文件上传副本并插入地址', () => {
  beforeAll(() => {
    if (typeof (URL as any).createObjectURL !== 'function') {
      ;(URL as any).createObjectURL = vi.fn(() => 'blob:mock')
    }
    if (typeof (URL as any).revokeObjectURL !== 'function') {
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })

  const uploadOk = (absPath: string) =>
    new Response(JSON.stringify({ ok: true, absPath }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  // fetch 分支: /api/fs/upload → 上传响应;其余(挂载时 /api/slash)→ 空 items。
  const stubFetch = (onUpload: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/fs/upload')) return onUpload(url, init)
        return new Response(JSON.stringify({ items: [] }), { status: 200 })
      }),
    )
  }

  const dropFiles = (files: File[]) => {
    const dropZone = document.querySelector('[data-testid="agent-input-drop-zone"]')!
    fireEvent.drop(dropZone, {
      dataTransfer: { files, items: files, types: ['Files'] } as unknown as DataTransfer,
    })
  }

  test('拖入非图片文件: 不触发浏览器下载, 上传副本并把绝对路径插入输入框', async () => {
    const uploadCalls: Array<{ url: string; body: { name: string; data: string } }> = []
    stubFetch((url, init) => {
      uploadCalls.push({ url, body: JSON.parse(String(init?.body)) })
      return uploadOk('/Users/u/code/proj/.zai/uploads/notes.txt')
    })
    try {
      render(<AgentInputBox />)
      const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
      dropFiles([new File(['hello world'], 'notes.txt', { type: 'text/plain' })])
      await waitFor(() => expect(uploadCalls.length).toBe(1))
      expect(uploadCalls[0]!.body.name).toBe('notes.txt')
      expect(uploadCalls[0]!.body.data.length).toBeGreaterThan(0) // base64 内容已附上
      await waitFor(() =>
        expect(ta.value).toContain('/Users/u/code/proj/.zai/uploads/notes.txt'),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('拖入多个非图片文件: 路径逐行插入', async () => {
    const absPaths = [
      '/Users/u/code/proj/.zai/uploads/notes.txt',
      '/Users/u/code/proj/.zai/uploads/data-1.csv',
    ]
    let i = 0
    stubFetch(() => uploadOk(absPaths[i++]!))
    try {
      render(<AgentInputBox />)
      const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
      dropFiles([
        new File(['a'], 'notes.txt', { type: 'text/plain' }),
        new File(['b'], 'data.csv', { type: 'text/csv' }),
      ])
      await waitFor(() => expect(ta.value).toContain('data-1.csv'))
      expect(ta.value).toBe(`${absPaths[0]}\n${absPaths[1]}`)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('拖入图片: 走附件插入, 不上传', async () => {
    stubFetch(() => uploadOk('/never'))
    const imageReader = await import('../lib/imageReader.js')
    const spy = vi.spyOn(imageReader, 'readImageAsBase64').mockResolvedValue({
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
      size: 1024,
      filename: 'shot.png',
    })
    try {
      render(<AgentInputBox />)
      const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
      dropFiles([new File(['x'], 'shot.png', { type: 'image/png' })])
      await waitFor(() => expect(spy).toHaveBeenCalled())
      // 图片走附件条, 输入框保持为空, 不插入路径文本
      expect(ta.value).toBe('')
    } finally {
      spy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  test('上传失败: 报错且不往输入框插入路径', async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ ok: false, error: '文件过大' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      render(<AgentInputBox />)
      const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
      dropFiles([new File(['x'], 'big.bin', { type: 'application/octet-stream' })])
      // 等上传 promise 落定:输入框不出现任何路径
      await new Promise((r) => setTimeout(r, 20))
      await waitFor(() => expect(ta.value).toBe(''))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
