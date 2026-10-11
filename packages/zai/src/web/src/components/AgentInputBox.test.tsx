// @vitest-environment happy-dom
import { describe, expect, test, beforeEach, beforeAll, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useAgentStore, type V2TaskItem } from "../store/useAgentStore.js";
import { useAppStore } from "../store/useAppStore.js";
import { useDesktopAttachmentStore } from "../store/desktopAttachmentStore.js";
import { api } from "../lib/api.js";
import { AGENT_INPUT_INSERT_EVENT } from "../lib/agentInputEvents.js";

const v2 = (id: string, subject: string, status: V2TaskItem["status"]): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0,
});

import {
  detectTextOf,
  editorRoot,
  pressEditorKey,
  setCaretAt,
  setDraftText,
  tokenMarkOf,
} from "./input/editor/testDriver.js";
import AgentInputBox from "./AgentInputBox.js";
import SplitPaneToggleButton from "./splitPane/SplitPaneToggleButton.js";

// 避免 ConversationInfoButton / api 等副作用; 只关注状态行渲染.
vi.mock("../components/ConversationInfoButton.js", () => ({
  default: () => null,
}))
vi.mock("../lib/api.js", () => ({
  api: {
    post: vi.fn(async () => ({ sessionId: 'mock-sess-1' })),
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
    const ed = editorRoot()
    setDraftText(ed, text )
    pressEditorKey(ed, "Enter")
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

  test("粘贴绝对路径不被误判为 slash 命令: 直接 POST /agent/prompt 且写入 transcript", async () => {
    vi.mocked(api.post).mockResolvedValue({ sessionId: "sess-new" } as any)
    render(<AgentInputBox />)
    const ed = editorRoot()
    setDraftText(ed, "/Users/foo/bar.png" )
    pressEditorKey(ed, "Enter")
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/agent/prompt",
        expect.objectContaining({ prompt: "/Users/foo/bar.png" }),
        expect.anything(),
      )
    })
    // 修复前: 任何 `/` 起首文本都先打 /agent/command; 路径文本现在不应触碰它
    expect(
      vi.mocked(api.post).mock.calls.some(([p]) => p === "/agent/command"),
    ).toBe(false)
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      const tail = msgs[msgs.length - 1]
      expect(tail).toMatchObject({
        type: "user.text",
        text: "/Users/foo/bar.png",
      })
    })
  })

  test("/agent/command 抛异常时恢复草稿, 用户输入不被吞掉", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error("network down"))
    render(<AgentInputBox />)
    const ed = editorRoot()
    setDraftText(ed, "/greet alice" )
    pressEditorKey(ed, "Enter")
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        "/agent/command",
        expect.objectContaining({ name: "greet" }),
      ),
    )
    // 修复前: catch 只 toast, draft 已在请求前 clear → 输入消失
    await waitFor(() => expect(detectTextOf(ed)).toBe("/greet alice"))
  })

  test("'/' 触发下拉里出现 handoff builtin 命令", async () => {
    // /api/slash mock (above beforeAll) 已返回 handoff 项.
    // 输入 "/" 后 dropdown 应该列出 handoff 命令.
    render(<AgentInputBox />)
    const ed = editorRoot()
    setDraftText(ed, "/" )
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
  async function loadSlashItemsAndReset(ed: HTMLElement) {
    setDraftText(ed, "/" )
    await waitFor(() => {
      expect(screen.getByText("/handoff")).toBeInTheDocument()
    })
    // 清空,避免影响下一个用例的断言
    setDraftText(ed, "" )
  }

  test('输入开头为已知命令名, 命令 token 染成命令色', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    // 输入 "/handoff some args" 触发高亮
    setDraftText(ed, "/handoff some args")
    // 高亮现在是 TextNode 的行内样式(--cmd-token-color),不再是 backdrop
    // 里的装饰 span;token 只含 "/handoff",不含尾部空格
    const mark = await waitFor(() => {
      const el = tokenMarkOf(document.body)
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(mark.textContent).toBe('/handoff')
    // 整段文本仍在同一个可编辑面里,没有第二个镜像层
    expect(ed.textContent).toBe('/handoff some args')
    expect(document.querySelector('[data-input-backdrop]')).toBeNull()
  })

  test('输入开头为未知命令名, 不渲染 token-mark', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    setDraftText(ed, "/totally-unknown-cmd")
    // 对未知命令短路:不染色
    expect(tokenMarkOf(document.body)).toBeNull()
  })

  test('输入不以 / 起首, 不渲染 token-mark', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    setDraftText(ed, "plain text no slash")
    expect(tokenMarkOf(document.body)).toBeNull()
  })

  test('输入框从命令切回普通文本后, token-mark 立即卸载', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    // 进入高亮态
    setDraftText(ed, "/handoff")
    await waitFor(() => {
      expect(tokenMarkOf(document.body)).not.toBeNull()
    })
    // 切回普通文本 → 染色立即消失
    setDraftText(ed, "no longer a command")
    await waitFor(() => {
      expect(tokenMarkOf(document.body)).toBeNull()
    })
  })

  test('已知命令名前缀匹配 (输入 /hando 但 slashItems 没 /hando 条目), 不渲染 token-mark', async () => {
    // handoff 是完整 name,/hando 是部分匹配 — deriveCommandToken 只在
    // 完整 word match 时返回高亮,避免把"前缀巧合"的输入也染紫。
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    setDraftText(ed, "/hando")
    expect(tokenMarkOf(document.body)).toBeNull()
  })

  test('可见文本只有一个来源: 单一 contenteditable,没有 backdrop / 隐藏镜像层', async () => {
    // 旧结构是「backdrop 画可见文本 + 透明 textarea 只留 caret + 隐藏镜像
    // 层定高」;现在是 Lexical contenteditable 自己渲染文本,那两个层整体
    // 删掉了。这里钉住「不会再退回双层文本」,否则宽度对位类 bug 会复发。
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    setDraftText(ed, "/handoff")
    await waitFor(() => {
      expect(ed.textContent).toBe('/handoff')
    })
    expect(ed.className).toContain('agent-input-editor')
    expect(ed.hasAttribute('contenteditable')).toBe(true)
    expect(document.querySelector('[data-input-backdrop]')).toBeNull()
    expect(document.querySelector('.agent-input-mirror')).toBeNull()
    expect(document.querySelector('textarea[data-testid="agent-input-textarea"]')).toBeNull()
  })
})

// 命令激活(输入开头为已知命令且未输入参数)时,backdrop 行尾追加灰色
// argument-hint 幽灵提示;用户开始敲参数后立即收起。
describe('AgentInputBox — 激活命令后 argument-hint 幽灵提示', () => {
  async function loadSlashItemsAndReset(ed: HTMLElement) {
    setDraftText(ed, "/" )
    await waitFor(() => {
      expect(screen.getByText("/handoff")).toBeInTheDocument()
    })
    setDraftText(ed, "" )
  }

  // 幽灵提示不进文档树(否则会被选中/被发送),而是作为 CSS 自定义属性喂给
  // 末段的生成内容伪元素。断言读这个属性,不去 DOM 里找元素。
  const hintOf = (el: HTMLElement): string | null => {
    const raw = el.style.getPropertyValue('--agent-input-hint');
    return raw === '' ? null : (JSON.parse(raw) as string);
  }

  test('选中命令后 token 后仅有空白 → 挂上 argumentHint', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    // token 后已有一个空格 → hint 直接贴上,不再补分隔空格
    setDraftText(ed, "/handoff ")
    await waitFor(() => {
      expect(hintOf(ed)).not.toBeNull();
    })
    expect(hintOf(ed)).toBe("[--pick <filename>]");
  })

  test('token 后无空格(手敲命令名) → hint 前自动补一个空格分隔', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    setDraftText(ed, "/handoff")
    await waitFor(() => {
      expect(hintOf(ed)).not.toBeNull();
    })
    expect(hintOf(ed)).toBe(" [--pick <filename>]");
  })

  test('开始输入参数后 hint 收起', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    await loadSlashItemsAndReset(ed)
    setDraftText(ed, "/handoff")
    await waitFor(() => {
      expect(hintOf(ed)).not.toBeNull();
    })
    setDraftText(ed, "/handoff --pick x.md")
    await waitFor(() => {
      expect(hintOf(ed)).toBeNull();
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

describe('AgentInputBox — 分屏 toggle 经 toolbarRightSlot 注入', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // 分屏按钮已从 AgentInputBox 内置移除(/desktop、/m 等场景没有 SplitPane),
  // 由 /agent 页面通过右插槽注入 SplitPaneToggleButton。
  test('默认不注入 → 状态行无分屏按钮;修复 transcript 按钮默认也不渲染', () => {
    render(<AgentInputBox />)
    expect(screen.queryByTestId('split-pane-toggle-inputbox')).toBeNull()
    expect(screen.queryByTestId('transcript-repair-button')).toBeNull()
  })

  test('注入 SplitPaneToggleButton 后渲染在状态行, 默认关闭', () => {
    render(<AgentInputBox toolbarRightSlot={<SplitPaneToggleButton />} />)
    const btn = screen.getByTestId('split-pane-toggle-inputbox')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  test('点击翻转并写入 STORAGE_KEYS.open, 再次点击翻回', () => {
    render(<AgentInputBox toolbarRightSlot={<SplitPaneToggleButton />} />)
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
    render(<AgentInputBox toolbarRightSlot={<SplitPaneToggleButton />} />)
    const btn = screen.getByTestId('split-pane-toggle-inputbox')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  test('showTranscriptRepair=true → 修复 transcript 按钮渲染', () => {
    render(<AgentInputBox showTranscriptRepair />)
    expect(screen.getByTestId('transcript-repair-button')).toBeInTheDocument()
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
    const ed = editorRoot()
    expect(editorRoot().hasAttribute("contenteditable")).toBe(true)
  })

  test('streaming 时发送: 后端响应 queued:true → 不 push user.text (消息排队等待)', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      sessionId: 'sess-1',
      queued: true,
      queueLength: 1,
      pending: [{ id: 'q1', text: 'second message' }],
    } as any)
    render(<AgentInputBox />)
    const ed = editorRoot()
    setDraftText(ed, 'second message' )
    pressEditorKey(ed, 'Enter')
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
    const cancelBtn = within(q1).getByRole('button', { name: '取消排队消息' })
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
    fireEvent.click(within(q1).getByRole('button', { name: '取消排队消息' })!)
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

  test('排队消息编辑: 行内编辑框 + 保存 → POST /agent/queue/edit, 执行时以编辑后文本写入 transcript', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as any)
    useAgentStore.setState({
      queuedPrompts: [{ id: 'q1', text: 'original queued' }],
      messages: [],
    })
    render(<AgentInputBox />)
    const q1 = screen.getByTestId('queued-prompt-q1')
    // 进入编辑态: 行内出现编辑框(初值为原文本)
    fireEvent.click(within(q1).getByRole('button', { name: '编辑排队消息' }))
    const editor = screen.getByTestId('queued-edit-input-q1') as HTMLInputElement
    expect(editor.value).toBe('original queued')
    // 修改文本并保存
    fireEvent.change(editor, { target: { value: 'edited queued' } })
    fireEvent.click(within(q1).getByRole('button', { name: '保存排队消息' }))
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/agent/queue/edit',
        expect.objectContaining({ sessionId: 'sess-1', promptId: 'q1', text: 'edited queued' }),
      ),
    )
    // 本地快照文本同步(避免闪烁)
    expect(
      useAgentStore.getState().queuedPrompts.find((p) => p.id === 'q1')?.text,
    ).toBe('edited queued')
    // 模拟该条被消费开始执行 → transcript 写入的是编辑后的文本
    act(() => {
      useAgentStore.setState({ queuedPrompts: [] })
    })
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      expect(
        msgs.some(
          (m) => (m as { type?: string }).type === 'user.text' && (m as { text?: string }).text === 'edited queued',
        ),
      ).toBe(true)
      expect(
        msgs.some((m) => (m as { text?: string }).text === 'original queued'),
      ).toBe(false)
    })
  })

  test('排队消息编辑: Escape 取消不提交', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as any)
    useAgentStore.setState({
      queuedPrompts: [{ id: 'q1', text: 'original queued' }],
      messages: [],
    })
    render(<AgentInputBox />)
    const q1 = screen.getByTestId('queued-prompt-q1')
    fireEvent.click(within(q1).getByRole('button', { name: '编辑排队消息' }))
    const editor = screen.getByTestId('queued-edit-input-q1') as HTMLInputElement
    fireEvent.change(editor, { target: { value: 'edited queued' } })
    fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape' })
    // 退出编辑态: 编辑框消失, 原文本回显, 未调用 /agent/queue/edit
    expect(screen.queryByTestId('queued-edit-input-q1')).toBeNull()
    expect(vi.mocked(api.post).mock.calls.some((c) => c[0] === '/agent/queue/edit')).toBe(false)
    expect(
      useAgentStore.getState().queuedPrompts.find((p) => p.id === 'q1')?.text,
    ).toBe('original queued')
  })

  test('插话发送: streaming 时可用, 点击 → POST /agent/queue/steer, 离开预览时写入 transcript', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as any)
    useAgentStore.setState({
      status: 'streaming',
      queuedPrompts: [{ id: 'q1', text: 'steer me' }],
      messages: [],
    })
    render(<AgentInputBox />)
    const q1 = screen.getByTestId('queued-prompt-q1')
    const steerBtn = within(q1).getByRole('button', { name: '插入提示' })
    expect((steerBtn as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(steerBtn)
    await waitFor(() =>
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/agent/queue/steer',
        expect.objectContaining({ sessionId: 'sess-1', promptId: 'q1' }),
      ),
    )
    // 本地立即移除(消息已插话, 退出预览)
    expect(
      useAgentStore.getState().queuedPrompts.map((p) => p.id),
    ).not.toContain('q1')
    // 模拟 queue.changed 确认: 消息"插入会话" → transcript 出现用户消息
    act(() => {
      useAgentStore.setState({ queuedPrompts: [] })
    })
    await waitFor(() => {
      expect(
        useAgentStore.getState().messages.some(
          (m) => (m as { type?: string }).type === 'user.text' && (m as { text?: string }).text === 'steer me',
        ),
      ).toBe(true)
    })
  })

  test('插话发送: idle(非 streaming)时按钮禁用', async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as any)
    useAgentStore.setState({
      status: 'idle',
      queuedPrompts: [{ id: 'q1', text: 'steer me' }],
      messages: [],
    })
    render(<AgentInputBox />)
    const q1 = screen.getByTestId('queued-prompt-q1')
    const steerBtn = within(q1).getByRole('button', { name: '插入提示' })
    expect((steerBtn as HTMLButtonElement).disabled).toBe(true)
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
      const ed = editorRoot()
      setDraftText(ed, 'describe this' )
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['fake-bytes'], 'pasted.png', { type: 'image/png' })
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fireEvent.change(fileInput)
      await waitFor(() => expect(spy).toHaveBeenCalled())
      pressEditorKey(ed, 'Enter')
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
      const ed = editorRoot()
      setDraftText(ed, 'describe this' )

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['fake-bytes'], 'pasted.png', { type: 'image/png' })
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fireEvent.change(fileInput)

      // 等 spy 至少被调一次 + addAttachments 内部 setState 把状态切到 ready.
      await waitFor(() => expect(spy).toHaveBeenCalled())

      // 点发送
      pressEditorKey(ed, 'Enter')

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
      const ed = editorRoot()

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['fake-bytes'], 'pasted.png', { type: 'image/png' })
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fireEvent.change(fileInput)

      await waitFor(() => expect(spy).toHaveBeenCalled())

      pressEditorKey(ed, 'Enter')

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

describe('AgentInputBox — 插入对话 (分屏文件管理 agent-input-insert 事件 → @引用 chip)', () => {
  const INSERT_TEXT = 'src/index.ts'

  test('事件后把相对路径插入为 chip, 光标落在 chip 之后', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    setDraftText(ed, 'look at now!')
    // 光标落在 'look at ' 与 'now!' 之间(detect 下标 8)
    setCaretAt(ed, 8)
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: INSERT_TEXT } }),
      )
    })
    // chip 化插入:detect 投影里是 1 个 U+FFFC 占位 + 尾随空格
    await waitFor(() => expect(detectTextOf(ed)).toBe('look at \ufffc now!'))
    // 编辑器里渲染 chip(路径/类型正确)
    const chip = document.querySelector('[data-testid="mention-chip"]')
    expect(chip?.getAttribute('data-mention-path')).toBe(INSERT_TEXT)
  })

  test('空输入框时插入相对路径 → chip + 尾随空格', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: INSERT_TEXT } }),
      )
    })
    await waitFor(() => expect(detectTextOf(ed)).toBe('\ufffc '))
    await waitFor(() => expect(document.querySelector('[data-testid="mention-chip"]')).not.toBeNull())
  })

  test('已有内容且 selection API 缺失时退化为追加到末尾(仍是 chip)', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    setDraftText(ed, 'look at now!' )
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: INSERT_TEXT } }),
      )
    })
    // 追加在末尾时,前导空格补在上一个词之后,再插 chip + 尾随空格
    await waitFor(() => expect(detectTextOf(ed)).toBe('look at now! \ufffc '))
  })

  test('detail 带 kind=dir 时插入目录 chip', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: 'src', kind: 'dir' } }),
      )
    })
    await waitFor(() => {
      const chip = document.querySelector('[data-testid="mention-chip"]')
      expect(chip?.getAttribute('data-mention-path')).toBe('src/')
      expect(chip?.getAttribute('data-mention-type')).toBe('dir')
    })
  })

  test('detail 缺 text 时不写入输入框', async () => {
    render(<AgentInputBox />)
    const ed = editorRoot()
    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: {} }))
    })
    expect(detectTextOf(ed)).toBe('')
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
      const ed = editorRoot()
      dropFiles([new File(['hello world'], 'notes.txt', { type: 'text/plain' })])
      await waitFor(() => expect(uploadCalls.length).toBe(1))
      expect(uploadCalls[0]!.body.name).toBe('notes.txt')
      expect(uploadCalls[0]!.body.data.length).toBeGreaterThan(0) // base64 内容已附上
      await waitFor(() =>
        expect(detectTextOf(ed)).toContain('/Users/u/code/proj/.zai/uploads/notes.txt'),
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
      const ed = editorRoot()
      dropFiles([
        new File(['a'], 'notes.txt', { type: 'text/plain' }),
        new File(['b'], 'data.csv', { type: 'text/csv' }),
      ])
      await waitFor(() => expect(detectTextOf(ed)).toContain('data-1.csv'))
      expect(detectTextOf(ed)).toBe(`${absPaths[0]}\n${absPaths[1]}`)
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
      const ed = editorRoot()
      dropFiles([new File(['x'], 'shot.png', { type: 'image/png' })])
      await waitFor(() => expect(spy).toHaveBeenCalled())
      // 图片走附件条, 输入框保持为空, 不插入路径文本
      expect(detectTextOf(ed)).toBe('')
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
      const ed = editorRoot()
      dropFiles([new File(['x'], 'big.bin', { type: 'application/octet-stream' })])
      // 等上传 promise 落定:输入框不出现任何路径
      await new Promise((r) => setTimeout(r, 20))
      await waitFor(() => expect(detectTextOf(ed)).toBe(''))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('AgentInputBox — 桌面附件自动附带', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
    useDesktopAttachmentStore.setState({ refs: [], mergedIds: [] })
  })

  async function doSend(text: string) {
    const ed = editorRoot()
    setDraftText(ed, text)
    pressEditorKey(ed, "Enter")
  }

  test('桌面页 (/desktop): 未并入附件自动前置为 @path; 同附件仅附带一次', async () => {
    window.history.replaceState({}, '', '/desktop')
    useDesktopAttachmentStore
      .getState()
      .addRef({ id: 'r-/a/b.md', path: '/a/b.md', name: 'b.md', kind: 'file' })
    render(<AgentInputBox />)
    editorRoot()

    await doSend('读一下')
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/agent/prompt',
        expect.objectContaining({ prompt: '@/a/b.md\n读一下' }),
        expect.anything(),
      )
    })
    // 附件区保留(merged 标记), 第二次发送不再附带
    vi.mocked(api.post).mockClear()
    await doSend('继续')
    await waitFor(() => {
      const calls = vi
        .mocked(api.post)
        .mock.calls.filter(([p]) => p === '/agent/prompt')
      expect(calls[calls.length - 1]![1]).toMatchObject({ prompt: '继续' })
    })
  })

  test('非桌面页 (/agent): 不附带附件, prompt 保持原文', async () => {
    window.history.replaceState({}, '', '/agent')
    useDesktopAttachmentStore
      .getState()
      .addRef({ id: 'r-/a/b.md', path: '/a/b.md', name: 'b.md', kind: 'file' })
    render(<AgentInputBox />)
    editorRoot()

    await doSend('读一下')
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledWith(
        '/agent/prompt',
        expect.objectContaining({ prompt: '读一下' }),
        expect.anything(),
      )
    })
  })
})
