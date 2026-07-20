// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest"
import "@testing-library/jest-dom"
import { render, screen, fireEvent } from "@testing-library/react"
import { MessageBubble, MessageCopyButton } from "./MessageBubble.js"

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
    expect(screen.getByText("Hello alice")).toBeInTheDocument()
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
