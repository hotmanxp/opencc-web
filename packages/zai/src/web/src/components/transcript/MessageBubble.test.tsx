// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest"
import "@testing-library/jest-dom"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { MessageBubble, MessageCopyButton } from "./MessageBubble.js"
import { useAppStore } from "../../store/useAppStore.js"

const msgMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }))
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>()
  return { ...actual, message: msgMock }
})

// happy-dom 20.10.6 does not define document.execCommand, but vi.spyOn requires
// the property to exist before it can replace it. Install a no-op stub so the
// existing spyOn calls work without touching vitest.config.ts.
if (!("execCommand" in document)) {
  ;(document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = () => false
}

describe("MessageBubble — isRenderedPrompt rendering", () => {
  test("renders muted follow-up line when isRenderedPrompt is true", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "user-1-r",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "Hello alice",
          isRenderedPrompt: true,
        }}
      />,
    )
    expect(screen.getByText(/^渲染后$/)).toBeInTheDocument()
    expect(screen.getAllByText("Hello alice")).toHaveLength(2)
    expect(screen.getByTestId("user-text-rendered-prompt")).toBeInTheDocument()
  })

  test("does not render muted line for ordinary user.text", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "user-2",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "Hello",
        }}
      />,
    )
    expect(screen.queryByText(/^渲染后$/)).toBeNull()
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })
})

describe("MessageCopyButton", () => {
  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
  })

  test("渲染默认 Copy 按钮, aria-label 区分 ai/user", () => {
    render(<MessageCopyButton text="hello" variant="ai" />)
    expect(screen.getByLabelText("复制助手回答")).toBeInTheDocument()
    render(<MessageCopyButton text="hi" variant="user" />)
    expect(screen.getByLabelText("复制用户消息")).toBeInTheDocument()
  })

  test("点击复制成功: 调用 writeText, 弹 message.success, 不弹 warning", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    render(<MessageCopyButton text="markdown body" variant="ai" />)
    fireEvent.click(screen.getByLabelText("复制助手回答"))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("markdown body")
      expect(msgMock.success).toHaveBeenCalledWith("已复制")
    })
    expect(msgMock.warning).not.toHaveBeenCalled()
  })

  test("复制成功后按钮不卸载 (aria-label 仍可定位)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    render(<MessageCopyButton text="x" variant="user" />)
    fireEvent.click(screen.getByLabelText("复制用户消息"))
    await vi.waitFor(() => {
      expect(msgMock.success).toHaveBeenCalled()
    })
    expect(screen.getByLabelText("复制用户消息")).toBeInTheDocument()
  })

  test("复制失败时弹 message.warning, 不弹 success", async () => {
    vi.stubGlobal("navigator", {})
    vi.spyOn(document, "execCommand").mockReturnValue(false)
    render(<MessageCopyButton text="x" variant="ai" />)
    fireEvent.click(screen.getByLabelText("复制助手回答"))
    await vi.waitFor(() => {
      expect(msgMock.warning).toHaveBeenCalledWith("复制失败, 请手动选中")
    })
    expect(msgMock.success).not.toHaveBeenCalled()
  })

  test("点击不冒泡 (e.stopPropagation 调用过)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <MessageCopyButton text="x" variant="ai" />
      </div>,
    )
    fireEvent.click(screen.getByLabelText("复制助手回答"))
    expect(parentClick).not.toHaveBeenCalled()
  })
})

describe("MessageBubble — copy button integration", () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    writeText.mockClear()
  })

  test("assistant.text 气泡渲染 Copy 按钮", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "a-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "assistant.text",
          text: "AI reply",
        }}
      />,
    )
    expect(screen.getByLabelText("复制助手回答")).toBeInTheDocument()
  })

  test("user.text 气泡渲染 Copy 按钮", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "u-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "user msg",
        }}
      />,
    )
    expect(screen.getByLabelText("复制用户消息")).toBeInTheDocument()
  })

  test("assistant.thinking 路径不渲染 Copy 按钮", () => {
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: "t-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "assistant.thinking",
          text: "thinking content",
        }}
      />,
    )
    expect(container.querySelector('[aria-label="复制助手回答"]')).toBeNull()
    expect(container.querySelector('[aria-label="复制用户消息"]')).toBeNull()
  })

  test("tool_use:start 路径不渲染 Copy 按钮", () => {
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: "tool-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "tool_use:start",
          toolUseId: "tu-1",
          name: "Bash",
          input: { command: "ls" },
        }}
      />,
    )
    expect(container.querySelector('[aria-label="复制助手回答"]')).toBeNull()
    expect(container.querySelector('[aria-label="复制用户消息"]')).toBeNull()
  })

  test("点击 assistant Copy 按钮复制 msg.text", async () => {
    render(
      <MessageBubble
        msg={{
          eventId: "a-2",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "assistant.text",
          text: "```ts\nconst x = 1\n```",
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText("复制助手回答"))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("```ts\nconst x = 1\n```")
    })
  })

  test("点击 user Copy 按钮复制 visibleText, 不含 isRenderedPrompt 第二行", async () => {
    render(
      <MessageBubble
        msg={{
          eventId: "u-2",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "原始问题",
          isRenderedPrompt: true,
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText("复制用户消息"))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("原始问题")
    })
    const calledWith = writeText.mock.calls[0]?.[0] ?? ""
    expect(calledWith).not.toContain("渲染后")
  })
})

describe("MessageBubble — Skill tool pill", () => {
  test("Skill tool_use:start pill surfaces the full skill name (not truncated generic preview)", () => {
    // Regression: SkillTool falls through genericRenderer because registry has
    // no "Skill" key. The generic preview truncates Object.values(input)[0]
    // to 80 chars, so users with long skill names like
    // "plugin:superpowers:writing-plans" need to read the name in the pill.
    render(
      <MessageBubble
        msg={{
          eventId: "tool-skill-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "tool_use:start",
          toolUseId: "call-skill-1",
          name: "Skill",
          input: { name: "plugin:superpowers:writing-plans" },
        }}
      />,
    )
    // 技能名同时出现在 ToolUsePill 与 preview, 用 getAllByText 替代 getByText.
    const matches = screen.getAllByText("plugin:superpowers:writing-plans")
    expect(matches.length).toBeGreaterThan(0)
  })

  test("Skill tool_use:done pill surfaces the skill name + done status tag", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "tool-skill-2",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "tool_use:done",
          toolUseId: "call-skill-2",
          name: "Skill",
          input: { name: "plugin:superpowers:systematic-debugging" },
          output: "<skill_invocation>...</skill_invocation>",
        }}
      />,
    )
    const matches = screen.getAllByText("plugin:superpowers:systematic-debugging")
    expect(matches.length).toBeGreaterThan(0)
    expect(screen.getByText("已完成")).toBeInTheDocument()
  })
})

describe("MessageBubble — thinking_delta streaming 透传", () => {
  test("content_block_delta + thinking_delta, 外层 streaming=true → 动画 className 挂上", () => {
    // 透传外层 streaming (由 MessageListView 决定: thinking 是 messages
    // 末尾时为 true). 这里验证 streaming=true 时 .zai-thinking-pill-active
    // 挂上 + 三个点渲染.
    const { container } = render(
      <MessageBubble
        streaming={true}
        msg={{
          eventId: "d-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "trace..." },
        }}
      />,
    )
    expect(container.querySelector(".zai-thinking-pill-active")).not.toBeNull()
    expect(container.querySelector(".zai-think-dot-1")).not.toBeNull()
    expect(container.querySelector(".zai-think-dot-2")).not.toBeNull()
    expect(container.querySelector(".zai-think-dot-3")).not.toBeNull()
  })

  test("content_block_delta + thinking_delta, 外层 streaming=false → 不挂动画 className", () => {
    // text 已经切到, MessageListView 给外层 streaming=false → thinking_delta
    // 路径也不应有动画.
    const { container } = render(
      <MessageBubble
        streaming={false}
        msg={{
          eventId: "d-1",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "trace..." },
        }}
      />,
    )
    expect(container.querySelector(".zai-thinking-pill-active")).toBeNull()
    expect(container.querySelector(".zai-think-dot-1")).toBeNull()
  })
})

describe("MessageBubble — user bubble maxWidth", () => {
  const SPLIT_PANE_KEY = "zai.splitPane.open"

  // 读 ant-card 节点上挂的 inline maxWidth. antd Card 把 style 透传到最外层
  // .ant-card 节点 (不是 .ant-card-body). happy-dom 下 inline style 是 string,
  // 这里直接断言百分比是否一致 — 不依赖 getComputedStyle.
  const userBubbleMaxWidth = (container: HTMLElement): string | null => {
    const wrap = container.querySelector('[data-testid="user-bubble-container"]')
    if (!wrap) return null
    const card = wrap.querySelector(".ant-card") as HTMLElement | null
    return card ? (card.style.maxWidth || null) : null
  }

  beforeEach(() => {
    // 隔离每个用例的 store + localStorage 状态, 避免跨用例泄漏.
    useAppStore.setState({ isMobile: false })
    window.localStorage.removeItem(SPLIT_PANE_KEY)
  })

  afterEach(() => {
    useAppStore.setState({ isMobile: false })
    window.localStorage.removeItem(SPLIT_PANE_KEY)
  })

  test("桌面端无分屏: user 气泡 maxWidth 保持 70%", () => {
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: "u-desktop",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "hello",
        }}
      />,
    )
    expect(userBubbleMaxWidth(container)).toBe("70%")
  })

  test("isMobile=true (移动端): user 气泡 maxWidth 撑满 100%", () => {
    act(() => {
      useAppStore.getState().setIsMobile(true)
    })
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: "u-mobile",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "hello",
        }}
      />,
    )
    expect(userBubbleMaxWidth(container)).toBe("100%")
  })

  test("分屏开启 (splitPaneOpen=true): user 气泡 maxWidth 撑满 100%", () => {
    // 在 mount 之前写入 localStorage, 让 MessageBubble 的 lazy initializer
    // 读到 true, 避免依赖 storage 事件时序 (happy-dom 下不同浏览器行为差异).
    window.localStorage.setItem(SPLIT_PANE_KEY, JSON.stringify(true))
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: "u-split",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "hello",
        }}
      />,
    )
    expect(userBubbleMaxWidth(container)).toBe("100%")
  })

  test("分屏开启 → 关闭: 切回 70% (响应 zai-localstorage-sync)", () => {
    window.localStorage.setItem(SPLIT_PANE_KEY, JSON.stringify(true))
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: "u-split-toggle",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "hello",
        }}
      />,
    )
    expect(userBubbleMaxWidth(container)).toBe("100%")
    // 模拟 SplitPane / Agent.tsx 同 tab 内把 localStorage 翻成 false, 通过
    // zai-localstorage-sync 通知同 tab siblings. MessageBubble 的 listener
    // 应在收到事件后 setState, 下一帧 maxWidth 回落到 70%.
    window.localStorage.setItem(SPLIT_PANE_KEY, JSON.stringify(false))
    act(() => {
      window.dispatchEvent(
        new CustomEvent("zai-localstorage-sync", {
          detail: { key: SPLIT_PANE_KEY, value: JSON.stringify(false) },
        }),
      )
    })
    expect(userBubbleMaxWidth(container)).toBe("70%")
  })
})
