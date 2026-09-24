// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { MessageListView } from "./MessageListView.js"
import type { AgentMessage } from "../../store/useAgentStore.js"

// MessageListView 从 useAgentStore 读 transcriptCollapsed 与 status —— mock 掉,
// 让测试分别驱动 expanded (false) / collapsed (true) 两条渲染路径与产物块结算。
const collapsed = vi.hoisted(() => ({ value: false }))
const status = vi.hoisted(() => ({ value: "idle" as string }))
vi.mock("../../store/useAgentStore.js", () => ({
  useAgentStore: <T,>(
    selector: (s: { transcriptCollapsed: boolean; status: string }) => T,
  ): T => selector({ transcriptCollapsed: collapsed.value, status: status.value }),
  useAgentStoreOrCtx: <T,>(
    selector: (s: { transcriptCollapsed: boolean; status: string }) => T,
  ): T => selector({ transcriptCollapsed: collapsed.value, status: status.value }),
}))

beforeEach(() => {
  collapsed.value = false
  status.value = "idle"
})

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

describe("MessageListView — skipOuterGroup 路由", () => {
  // presentFileRenderer.skipOuterGroup=true → collapsed 视图下跳过
  // ToolGroupCard 外壳, 直接渲染 MessageBubble 列表. Bash 等未标记的
  // 工具继续走 ToolGroupCard. 混合 / pending / error 状态回退带壳.

  function presentFileDone(toolUseId: string): AgentMessage {
    return toolMsg(
      "tool_use:done",
      toolUseId,
      "PresentFile",
      { path: "/a.ts" },
      JSON.stringify({
        content: [
          {
            type: "json",
            json: {
              file: { path: "/a.ts", name: "a.ts", size: 100, mtime: 0, kind: "text" },
              caption: "刚生成的产物",
            },
          },
        ],
      }),
    )
  }

  test("collapsed: PresentFile toolGroup 跳过 ToolGroupCard 外壳, 直接渲染文件卡", () => {
    collapsed.value = true
    const { container } = render(<MessageListView messages={[presentFileDone("tu-pf-1")]} />)
    // ToolGroupCard 的 ant-card-head 不出现 → 外壳已跳过
    expect(container.querySelector(".ant-card-head")).not.toBeInTheDocument()
    expect(screen.queryByText(/个工具调用/)).not.toBeInTheDocument()
    // 文件卡渲染
    expect(screen.getByTestId("present-file-card")).toBeInTheDocument()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
  })

  test("collapsed: Bash 工具仍渲染 ToolGroupCard (未标记 skipOuterGroup)", () => {
    collapsed.value = true
    const { container } = render(
      <MessageListView
        messages={[
          toolMsg("tool_use:start", "tu-bash-1", "Bash", { command: "ls" }),
          toolMsg("tool_use:done", "tu-bash-1", "Bash", undefined, "ok"),
        ]}
      />,
    )
    expect(container.querySelector(".ant-card-head")).toBeInTheDocument()
    expect(screen.getByText(/个工具调用/)).toBeInTheDocument()
    expect(screen.getByText(/·\s*Bash/)).toBeInTheDocument()
  })

  test("collapsed: PresentFile + Bash 混合 toolGroup 被拆成「组卡 + 文件卡」", () => {
    collapsed.value = true
    const { container } = render(
      <MessageListView
        messages={[
          toolMsg("tool_use:start", "tu-bash-1", "Bash", { command: "ls" }),
          toolMsg("tool_use:done", "tu-bash-1", "Bash", undefined, "ok"),
          presentFileDone("tu-pf-1"),
        ]}
      />,
    )
    // Bash 仍进组卡(start+done 两条 message → 2 entries),文件卡独立内联;
    // 计数是 2 而非 3,证明 PresentFile 已被摘出组卡。
    expect(container.querySelector(".ant-card-head")).toBeInTheDocument()
    expect(screen.getByText(/2 个工具调用/)).toBeInTheDocument()
    expect(screen.getByTestId("present-file-card")).toBeInTheDocument()
  })

  test("collapsed: pending PresentFile 仍渲染 ToolGroupCard (状态优先)", () => {
    // pending / error / invalid / denied 状态保留外壳, 让用户看到
    // 「工具调用中…」或红色「N 个失败」Tag 状态提示.
    collapsed.value = true
    const { container } = render(
      <MessageListView
        messages={[toolMsg("tool_use:start", "tu-pf-1", "PresentFile", { path: "/a.ts" })]}
      />,
    )
    expect(container.querySelector(".ant-card-head")).toBeInTheDocument()
    expect(screen.getByText(/个工具调用/)).toBeInTheDocument()
    expect(screen.queryByTestId("present-file-card")).toBeNull()
  })
})

// ── 本轮产物块 ────────────────────────────────────────────────────────────
// 语料:两轮对话,各自改过文件。产物块锚定在每轮最后一条消息之后。
function artifactMessages(): AgentMessage[] {
  return [
    { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "first" },
    toolMsg("tool_use:start", "tu-w1", "Write", { file_path: "/abs/one.ts" }),
    toolMsg("tool_use:done", "tu-w1", "Write", undefined, "File created successfully"),
    { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "done1" },
    { eventId: "u2", sessionId: "sess-1", ts: 3, turnIndex: 1, type: "user.text", text: "second" },
    toolMsg("tool_use:start", "tu-e1", "Edit", { file_path: "/abs/two.ts" }),
    toolMsg("tool_use:done", "tu-e1", "Edit", undefined, "ok"),
    { eventId: "a2", sessionId: "sess-1", ts: 4, turnIndex: 1, type: "assistant.text", text: "done2" },
  ]
}

describe("MessageListView — 本轮产物块", () => {
  test("expanded 视图:每轮末尾各渲染一个产物块", () => {
    collapsed.value = false
    status.value = "idle"
    render(<MessageListView messages={artifactMessages()} />)
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(2)
    expect(screen.getByText("one.ts")).toBeInTheDocument()
    expect(screen.getByText("two.ts")).toBeInTheDocument()
  })

  test("collapsed 视图:同样插入两个产物块", () => {
    collapsed.value = true
    status.value = "idle"
    render(<MessageListView messages={artifactMessages()} />)
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(2)
  })

  test("流式中的最后一轮不出产物块,已结束的上一轮仍有", () => {
    collapsed.value = false
    status.value = "streaming"
    render(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "first" },
          toolMsg("tool_use:start", "tu-w1", "Write", { file_path: "/abs/one.ts" }),
          { eventId: "u2", sessionId: "sess-1", ts: 2, turnIndex: 1, type: "user.text", text: "second" },
          toolMsg("tool_use:start", "tu-e1", "Edit", { file_path: "/abs/two.ts" }),
        ]}
      />,
    )
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(1)
    expect(screen.getByText("one.ts")).toBeInTheDocument()
    expect(screen.queryByText("two.ts")).not.toBeInTheDocument()
  })

  test("无文件改动的轮次不渲染产物块", () => {
    collapsed.value = false
    status.value = "idle"
    render(
      <MessageListView
        messages={[
          { eventId: "u1", sessionId: "sess-1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" },
          { eventId: "a1", sessionId: "sess-1", ts: 2, turnIndex: 0, type: "assistant.text", text: "hello back" },
        ]}
      />,
    )
    expect(screen.queryByTestId("turn-artifacts-block")).not.toBeInTheDocument()
  })
})

describe("MessageListView — thinking live 判定", () => {
  // 紫色"思考"pill 的流式动画在 MessageBubble.ThinkingBlock 内, 由 <style id="zai-think-glow-style">
  // 注入到 document.head 控制. 我们这里不直接断言 DOM (RTL 在 happy-dom 下
  // 抓不到 useEffect 注入的 <style>), 而是通过 MessageBubble 组件 spy: render
  // 时给 ThinkingBlock 传 streaming={true/false} 的差别是 className (pill-active
  // / dot-* 类) 与 useEffect 的 cleanup 时机. 用 mock MessageBubble 抓 props
  // 是最稳的回归断言.
  const bubbleProps: Array<{ streaming?: boolean; msg: AgentMessage }> = []
  const MockMessageBubble = (props: { msg: AgentMessage; streaming?: boolean }) => {
    bubbleProps.push(props)
    return <div data-testid="bubble" />
  }
  const MockCollapsed = () => <div data-testid="collapsed" />
  const MockToolGroup = () => <div data-testid="tool-group" />

  beforeEach(() => {
    bubbleProps.length = 0
    vi.resetModules()
  })

  test("expanded: thinking 在 text 之前 → MessageBubble streaming={true}", async () => {
    collapsed.value = false
    vi.doMock("./MessageBubble.js", () => ({ MessageBubble: MockMessageBubble }))
    vi.doMock("./CollapsedMessageBubble.js", () => ({ CollapsedMessageBubble: MockCollapsed }))
    vi.doMock("./ToolGroupCard.js", () => ({ ToolGroupCard: MockToolGroup }))
    const { MessageListView: MLV } = await import("./MessageListView.js")
    render(
      <MLV
        messages={[
          { eventId: "u1", sessionId: "s1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" } as unknown as AgentMessage,
          { eventId: "t1", sessionId: "s1", ts: 2, turnIndex: 0, type: "assistant.thinking", thinking: "reasoning" } as unknown as AgentMessage,
        ]}
      />,
    )
    const thinkingProp = bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.thinking")
    expect(thinkingProp?.streaming).toBe(true)
  })

  test("expanded: thinking 之后出现 text → MessageBubble streaming={false}", async () => {
    collapsed.value = false
    vi.doMock("./MessageBubble.js", () => ({ MessageBubble: MockMessageBubble }))
    vi.doMock("./CollapsedMessageBubble.js", () => ({ CollapsedMessageBubble: MockCollapsed }))
    vi.doMock("./ToolGroupCard.js", () => ({ ToolGroupCard: MockToolGroup }))
    const { MessageListView: MLV } = await import("./MessageListView.js")
    render(
      <MLV
        streaming={true}
        messages={[
          { eventId: "u1", sessionId: "s1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" } as unknown as AgentMessage,
          { eventId: "t1", sessionId: "s1", ts: 2, turnIndex: 0, type: "assistant.thinking", thinking: "reasoning" } as unknown as AgentMessage,
          { eventId: "a1", sessionId: "s1", ts: 3, turnIndex: 0, type: "assistant.text", text: "reply" } as unknown as AgentMessage,
        ]}
      />,
    )
    const thinkingProp = bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.thinking")
    expect(thinkingProp?.streaming).toBe(false)
    const textProp = bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.text")
    expect(textProp?.streaming).toBe(true) // 最后一条 text + streaming=true
  })

  test("expanded: 历史回放 [thinking, text] → thinking streaming={false}", async () => {
    collapsed.value = false
    vi.doMock("./MessageBubble.js", () => ({ MessageBubble: MockMessageBubble }))
    vi.doMock("./CollapsedMessageBubble.js", () => ({ CollapsedMessageBubble: MockCollapsed }))
    vi.doMock("./ToolGroupCard.js", () => ({ ToolGroupCard: MockToolGroup }))
    const { MessageListView: MLV } = await import("./MessageListView.js")
    render(
      <MLV
        messages={[
          { eventId: "u1", sessionId: "s1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" } as unknown as AgentMessage,
          { eventId: "t1", sessionId: "s1", ts: 2, turnIndex: 0, type: "assistant.thinking", thinking: "reasoning" } as unknown as AgentMessage,
          { eventId: "a1", sessionId: "s1", ts: 3, turnIndex: 0, type: "assistant.text", text: "reply" } as unknown as AgentMessage,
        ]}
      />,
    )
    const thinkingProp = bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.thinking")
    expect(thinkingProp?.streaming).toBe(false)
  })

  test("collapsed: thinking 在 text 之前 → CollapsedMessageBubble streaming={false}", async () => {
    // assistant.thinking 走 text bucket (deriveTranscriptNodes 只把 legacy
    // 'assistant' + thinking 字段提为 kind:'thinking' 节点); 因此 collapsed
    // 视图下通过 CollapsedMessageBubble 渲染. 这里 spy 它的 props.
    const collapsedProps: Array<{ streaming?: boolean; message: AgentMessage }> = []
    const MockCollapsedSpy = (props: { message: AgentMessage; streaming?: boolean }) => {
      collapsedProps.push(props)
      return <div data-testid="collapsed-spy" />
    }
    collapsed.value = true
    vi.doMock("./MessageBubble.js", () => ({ MessageBubble: MockMessageBubble }))
    vi.doMock("./CollapsedMessageBubble.js", () => ({ CollapsedMessageBubble: MockCollapsedSpy }))
    vi.doMock("./ToolGroupCard.js", () => ({ ToolGroupCard: MockToolGroup }))
    const { MessageListView: MLV } = await import("./MessageListView.js")
    render(
      <MLV
        streaming={true}
        messages={[
          { eventId: "u1", sessionId: "s1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" } as unknown as AgentMessage,
          { eventId: "t1", sessionId: "s1", ts: 2, turnIndex: 0, type: "assistant.thinking", thinking: "reasoning" } as unknown as AgentMessage,
          { eventId: "a1", sessionId: "s1", ts: 3, turnIndex: 0, type: "assistant.text", text: "reply" } as unknown as AgentMessage,
        ]}
      />,
    )
    const thinkingProp = collapsedProps.find((p) => (p.message as { type?: string }).type === "assistant.thinking")
    // text 已经切到 (最后一条是 assistant.text) → thinking 不再 live
    expect(thinkingProp?.streaming).toBe(false)
  })

  test("collapsed: thinking 之后无 text (即尾部) → CollapsedMessageBubble streaming={true}", async () => {
    const collapsedProps: Array<{ streaming?: boolean; message: AgentMessage }> = []
    const MockCollapsedSpy = (props: { message: AgentMessage; streaming?: boolean }) => {
      collapsedProps.push(props)
      return <div data-testid="collapsed-spy" />
    }
    collapsed.value = true
    vi.doMock("./MessageBubble.js", () => ({ MessageBubble: MockMessageBubble }))
    vi.doMock("./CollapsedMessageBubble.js", () => ({ CollapsedMessageBubble: MockCollapsedSpy }))
    vi.doMock("./ToolGroupCard.js", () => ({ ToolGroupCard: MockToolGroup }))
    const { MessageListView: MLV } = await import("./MessageListView.js")
    render(
      <MLV
        streaming={true}
        messages={[
          { eventId: "u1", sessionId: "s1", ts: 1, turnIndex: 0, type: "user.text", text: "hi" } as unknown as AgentMessage,
          { eventId: "t1", sessionId: "s1", ts: 2, turnIndex: 0, type: "assistant.thinking", thinking: "reasoning" } as unknown as AgentMessage,
        ]}
      />,
    )
    const thinkingProp = collapsedProps.find((p) => (p.message as { type?: string }).type === "assistant.thinking")
    // text 还没切到 → thinking 块 live (走 isThinkingLive)
    expect(thinkingProp?.streaming).toBe(true)
  })
})
