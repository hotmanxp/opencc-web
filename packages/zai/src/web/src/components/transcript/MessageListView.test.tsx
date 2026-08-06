// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { MessageListView } from "./MessageListView.js"
import type { AgentMessage } from "../../store/useAgentStore.js"

// MessageListView 只从 useAgentStore 读 transcriptCollapsed —— mock 掉,
// 让测试分别驱动 expanded (false) / collapsed (true) 两条渲染路径.
const collapsed = vi.hoisted(() => ({ value: false }))
vi.mock("../../store/useAgentStore.js", () => ({
  useAgentStore: <T,>(selector: (s: { transcriptCollapsed: boolean }) => T): T =>
    selector({ transcriptCollapsed: collapsed.value }),
}))

function toolMsg(
  type: string,
  toolUseId: string,
  name: string,
  input?: Record<string, unknown>,
  output?: string,
): AgentMessage {
  return {
    eventId: `evt-${toolUseId}-${type}`,
    sessionId: "sess-1",
    ts: 1,
    turnIndex: 0,
    type,
    name,
    toolUseId,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  } as unknown as AgentMessage
}

function messages(): AgentMessage[] {
  return [
    { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "hello" },
    toolMsg("tool_use:start", "tu-agent", "Agent", {
      subagent_type: "general-purpose",
      description: "list files",
      prompt: "list /tmp",
    }),
    toolMsg("tool_use:done", "tu-agent", "Agent", undefined, "Done (3 tool uses)"),
    toolMsg("tool_use:start", "tu-bash", "Bash", { command: "ls /tmp" }),
    toolMsg("tool_use:done", "tu-bash", "Bash", undefined, "file1 file2"),
    { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "done" },
  ]
}

describe("MessageListView — Agent 工具卡过滤", () => {
  test("expanded 视图不渲染 Agent 内联工具卡, 其它工具保留", () => {
    collapsed.value = false
    render(<MessageListView messages={messages()} />)
    // Agent 工具卡 (displayName = "general-purpose (agent)") 被过滤掉
    expect(screen.queryByText(/general-purpose \(agent\)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/list files/)).not.toBeInTheDocument()
    // Bash 工具卡保留 (start + done 各渲染一个 pill)
    expect(screen.getAllByText("Bash").length).toBeGreaterThan(0)
  })

  test("collapsed 视图工具组不含 Agent, 组摘要不列 Agent", () => {
    collapsed.value = true
    render(<MessageListView messages={messages()} />)
    expect(screen.queryByText(/general-purpose \(agent\)/)).not.toBeInTheDocument()
    // 组摘要只剩 Bash (原为 "Agent, Bash"), 不再出现 Agent
    expect(screen.queryByText(/·\s*Agent/)).not.toBeInTheDocument()
    expect(screen.getByText(/2 个工具调用/)).toBeInTheDocument()
    expect(screen.getByText(/·\s*Bash/)).toBeInTheDocument()
  })

  test("纯文本对话不受影响", () => {
    collapsed.value = false
    render(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" },
          { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "hello back" },
        ]}
      />,
    )
    expect(screen.getByText("hi")).toBeInTheDocument()
    expect(screen.getByText("hello back")).toBeInTheDocument()
  })

  test("collapsed 视图: 新消息 append 到同一 text bucket 不重挂载已渲染的消息", () => {
    // 回归: 旧实现用 `txt-${startIndex}-${endIndex}-${i}` 作包裹 div key,
    // 新消息并入同一 text node 会让 endIndex 变大 → key 变化 → 整棵子树
    // 卸载重挂载 → CollapsedMessageBubble / AssistantTextBody 内部展开态丢失.
    collapsed.value = true
    const { rerender } = render(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" },
          { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "long answer" },
        ]}
      />,
    )
    // forceExpanded 让 "long answer" 直接渲染, getByText 返回承载该文本的 DOM 节点.
    const before = screen.getByText("long answer")
    // 新 turn: 用户再发一条 + 助手回复, 全部并入同一 text bucket (无工具边界).
    rerender(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" },
          { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "long answer" },
          { eventId: "u2", sessionId: "sess-1", ts: 3, turnIndex: 1, type: "user.text", text: "again" },
          { eventId: "a2", sessionId: "sess-1", ts: 4, turnIndex: 1, type: "assistant.text", text: "second reply" },
        ]}
      />,
    )
    // 同一 DOM 节点 → 未被重挂载, 内部状态保留.
    expect(screen.getByText("long answer")).toBe(before)
    expect(screen.getByText("second reply")).toBeInTheDocument()
  })
})
