// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { MessageListView } from "./MessageListView.js"
import type { AgentMessage } from "../../store/useAgentStore.js"

// MessageListView 从 useAgentStore 读 transcriptCollapsed 与 status —— mock 掉。
// transcriptCollapsed 现在的语义是「工具运行段是否自动展开」, 不再切换渲染器。
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

function userText(id: string, text: string, turnIndex = 0): AgentMessage {
  return { eventId: id, sessionId: "sess-1", ts: 1, turnIndex, type: "user.text", text }
}

function assistantText(id: string, text: string, turnIndex = 0): AgentMessage {
  return { eventId: id, sessionId: "sess-1", ts: 2, turnIndex, type: "assistant.text", text }
}

describe("MessageListView — Agent 工具卡过滤", () => {
  test("Agent 工具调用不进入转录, 其它工具照常成段", () => {
    render(
      <MessageListView
        messages={[
          userText("u1", "hello"),
          toolMsg("tool_use:start", "tu-agent", "Agent", {
            subagent_type: "general-purpose",
            description: "list files",
            prompt: "list /tmp",
          }),
          toolMsg("tool_use:done", "tu-bash", "Bash", { command: "ls /tmp" }),
        ]}
      />,
    )
    expect(screen.queryByText(/general-purpose \(agent\)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/list files/)).not.toBeInTheDocument()
    // Agent 已被摘掉, 运行段里只剩 Bash 一条 → 「已执行 1 条命令」
    expect(screen.getByText("已执行 1 条命令")).toBeInTheDocument()
  })

  test("纯文本对话不受影响", () => {
    render(<MessageListView messages={[userText("u1", "hi"), assistantText("a1", "hello back")]} />)
    expect(screen.getByText("hi")).toBeInTheDocument()
    expect(screen.getByText("hello back")).toBeInTheDocument()
  })

  test("新消息 append 到同一 text bucket 不重挂载已渲染的消息", () => {
    // 回归: 包裹层 key 一旦随节点长度变化, 新消息并入同一 text node 就会
    // 整棵子树卸载重挂载 → 子组件内部展开态丢失.
    const { rerender } = render(
      <MessageListView messages={[userText("u1", "hi"), assistantText("a1", "long answer")]} />,
    )
    const before = screen.getByText("long answer")
    rerender(
      <MessageListView
        messages={[
          userText("u1", "hi"),
          assistantText("a1", "long answer"),
          userText("u2", "again", 1),
          assistantText("a2", "second reply", 1),
        ]}
      />,
    )
    expect(screen.getByText("long answer")).toBe(before)
    expect(screen.getByText("second reply")).toBeInTheDocument()
  })
})

describe("MessageListView — 工具运行段摘要", () => {
  test("连续工具调用合并成一行分类计数摘要", () => {
    render(
      <MessageListView
        messages={[
          userText("u1", "go"),
          toolMsg("tool_use:done", "tu-bash", "Bash", { command: "ls" }),
          toolMsg("tool_use:done", "tu-bash2", "Bash", { command: "pwd" }),
          toolMsg("tool_use:done", "tu-read", "Read", { file_path: "/a.ts" }),
          toolMsg("tool_use:done", "tu-task", "TaskUpdate", { taskId: "1" }),
        ]}
      />,
    )
    // 一个运行段, 一行摘要, 按段内首次出现顺序拼接
    expect(screen.getAllByTestId("tool-run-group")).toHaveLength(1)
    expect(screen.getByText("已执行 2 条命令，已读取 1 个文件，已更新待办")).toBeInTheDocument()
  })

  test("中间夹了正文就断成两段", () => {
    render(
      <MessageListView
        messages={[
          toolMsg("tool_use:done", "tu-b1", "Bash", { command: "ls" }),
          assistantText("a1", "中间说句话"),
          toolMsg("tool_use:done", "tu-b2", "Bash", { command: "pwd" }),
        ]}
      />,
    )
    expect(screen.getAllByTestId("tool-run-group")).toHaveLength(2)
    expect(screen.getByText("中间说句话")).toBeInTheDocument()
  })

  test("折叠时 (transcriptCollapsed=true) 运行中的段也不自动展开", () => {
    collapsed.value = true
    render(<MessageListView messages={[toolMsg("tool_use:start", "tu-b1", "Bash", { command: "ls" })]} />)
    expect(screen.getByText("正在执行命令")).toBeInTheDocument()
    // 明细行不出现 → 运行段保持折叠
    expect(screen.queryByTestId("tool-run-row")).not.toBeInTheDocument()
  })
})

describe("MessageListView — skipOuterGroup 路由", () => {
  // presentFileRenderer.skipOuterGroup=true → 不进工具运行段外壳, 直接把
  // 自包含的文件卡渲染出来. Bash 等未标记的工具继续走运行段. 混合 /
  // pending / error 状态回退带壳。

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

  test("PresentFile 跳过运行段外壳, 直接渲染文件卡", () => {
    render(<MessageListView messages={[presentFileDone("tu-pf-1")]} />)
    expect(screen.queryByTestId("tool-run-group")).not.toBeInTheDocument()
    expect(screen.getByTestId("present-file-card")).toBeInTheDocument()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
  })

  test("Bash 仍渲染工具运行段", () => {
    render(<MessageListView messages={[toolMsg("tool_use:done", "tu-bash-1", "Bash", { command: "ls" })]} />)
    expect(screen.getByTestId("tool-run-group")).toBeInTheDocument()
    expect(screen.getByText("已执行 1 条命令")).toBeInTheDocument()
  })

  test("PresentFile + Bash 混合被拆成「运行段 + 文件卡」", () => {
    render(
      <MessageListView
        messages={[
          toolMsg("tool_use:done", "tu-bash-1", "Bash", { command: "ls" }),
          presentFileDone("tu-pf-1"),
        ]}
      />,
    )
    // 运行段只数 Bash 一条 → 证明 PresentFile 已被摘出
    expect(screen.getByText("已执行 1 条命令")).toBeInTheDocument()
    expect(screen.getByTestId("present-file-card")).toBeInTheDocument()
  })

  test("pending PresentFile 仍进运行段 (状态优先)", () => {
    render(
      <MessageListView messages={[toolMsg("tool_use:start", "tu-pf-1", "PresentFile", { path: "/a.ts" })]} />,
    )
    expect(screen.getByTestId("tool-run-group")).toBeInTheDocument()
    expect(screen.queryByTestId("present-file-card")).toBeNull()
  })
})

// ── 本轮产物块 ────────────────────────────────────────────────────────────
// 语料:两轮对话,各自改过文件。产物块锚定在每轮最后一条消息之后。
function artifactMessages(): AgentMessage[] {
  return [
    userText("u1", "first"),
    toolMsg("tool_use:start", "tu-w1", "Write", { file_path: "/abs/one.ts" }),
    toolMsg("tool_use:done", "tu-w1", "Write", undefined, "File created successfully"),
    assistantText("a1", "done1"),
    userText("u2", "second", 1),
    toolMsg("tool_use:start", "tu-e1", "Edit", { file_path: "/abs/two.ts" }),
    toolMsg("tool_use:done", "tu-e1", "Edit", undefined, "ok"),
    assistantText("a2", "done2", 1),
  ]
}

describe("MessageListView — 本轮产物块", () => {
  test("每轮末尾各渲染一个产物块", () => {
    render(<MessageListView messages={artifactMessages()} />)
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(2)
    expect(screen.getByText("one.ts")).toBeInTheDocument()
    expect(screen.getByText("two.ts")).toBeInTheDocument()
  })

  test("collapsed 态同样插入两个产物块", () => {
    collapsed.value = true
    render(<MessageListView messages={artifactMessages()} />)
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(2)
  })

  test("流式中的最后一轮不出产物块,已结束的上一轮仍有", () => {
    status.value = "streaming"
    render(
      <MessageListView
        messages={[
          userText("u1", "first"),
          toolMsg("tool_use:start", "tu-w1", "Write", { file_path: "/abs/one.ts" }),
          userText("u2", "second", 1),
          toolMsg("tool_use:start", "tu-e1", "Edit", { file_path: "/abs/two.ts" }),
        ]}
      />,
    )
    expect(screen.getAllByTestId("turn-artifacts-block")).toHaveLength(1)
    expect(screen.getByText("one.ts")).toBeInTheDocument()
    expect(screen.queryByText("two.ts")).not.toBeInTheDocument()
  })

  test("无文件改动的轮次不渲染产物块", () => {
    render(<MessageListView messages={[userText("u1", "hi"), assistantText("a1", "hello back")]} />)
    expect(screen.queryByTestId("turn-artifacts-block")).not.toBeInTheDocument()
  })
})

describe("MessageListView — thinking live 判定", () => {
  // 思考块的流式动画在 MessageBubble.ThinkingBlock 内 (useEffect 往 head 注入
  // <style>), happy-dom 抓不到注入的 style, 所以 mock MessageBubble 直接断言
  // 传下去的 streaming prop —— 这是最稳的回归断言。
  const bubbleProps: Array<{ streaming?: boolean; msg: AgentMessage }> = []
  const MockMessageBubble = (props: { msg: AgentMessage; streaming?: boolean }) => {
    bubbleProps.push(props)
    return <div data-testid="bubble" />
  }
  const MockToolRunGroup = () => <div data-testid="tool-run" />

  beforeEach(() => {
    bubbleProps.length = 0
    vi.resetModules()
  })

  async function renderWithMockedBubble(props: {
    streaming?: boolean
    messages: AgentMessage[]
  }) {
    vi.doMock("./MessageBubble.js", () => ({ MessageBubble: MockMessageBubble }))
    vi.doMock("./ToolRunGroup.js", () => ({ ToolRunGroup: MockToolRunGroup }))
    const { MessageListView: MLV } = await import("./MessageListView.js")
    render(<MLV streaming={props.streaming} messages={props.messages} />)
  }

  const thinkingMsg = {
    eventId: "t1",
    sessionId: "s1",
    ts: 2,
    turnIndex: 0,
    type: "assistant.thinking",
    thinking: "reasoning",
  } as unknown as AgentMessage

  test("thinking 在 text 之前 → MessageBubble streaming={true}", async () => {
    await renderWithMockedBubble({ messages: [userText("u1", "hi"), thinkingMsg] })
    expect(bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.thinking")?.streaming).toBe(true)
  })

  test("thinking 之后出现 text → thinking 失活, text 转 live", async () => {
    await renderWithMockedBubble({
      streaming: true,
      messages: [
        userText("u1", "hi"),
        thinkingMsg,
        { ...assistantText("a1", "reply"), sessionId: "s1" } as AgentMessage,
      ],
    })
    expect(bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.thinking")?.streaming).toBe(false)
    expect(bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.text")?.streaming).toBe(true)
  })

  test("历史回放 [thinking, text] (无 streaming) → thinking streaming={false}", async () => {
    await renderWithMockedBubble({
      messages: [
        userText("u1", "hi"),
        thinkingMsg,
        { ...assistantText("a1", "reply"), sessionId: "s1" } as AgentMessage,
      ],
    })
    expect(bubbleProps.find((p) => (p.msg as { type?: string }).type === "assistant.thinking")?.streaming).toBe(false)
  })
})