// @vitest-environment happy-dom
import { describe, expect, test } from "vitest"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { MessageBubble } from "./MessageBubble.js"

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
