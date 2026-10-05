// @vitest-environment happy-dom
import { describe, expect, test } from "vitest"
import "@testing-library/jest-dom"
import { fireEvent, render, screen } from "@testing-library/react"
import { ToolRunGroup } from "./ToolRunGroup.js"
import type { ToolGroupEntry, ToolGroupStatus } from "./deriveTranscriptNodes.js"
import type { AgentMessage } from "../../store/useAgentStore.js"

function entry(
  toolUseId: string,
  name: string,
  status: ToolGroupStatus,
  input?: Record<string, unknown>,
  output?: string,
): ToolGroupEntry {
  const type =
    status === "done"
      ? "tool_use:done"
      : status === "pending"
        ? "tool_use:start"
        : "tool_use:error"
  return {
    index: 0,
    status,
    message: {
      eventId: `evt-${toolUseId}`,
      sessionId: "sess-1",
      ts: 1,
      turnIndex: 0,
      type,
      name,
      toolUseId,
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    } as unknown as AgentMessage,
  }
}

describe("ToolRunGroup — 折叠摘要", () => {
  test("按分类计数拼接, 逗号连接", () => {
    render(
      <ToolRunGroup
        entries={[
          entry("t1", "Bash", "done", { command: "ls" }),
          entry("t2", "Bash", "done", { command: "pwd" }),
          entry("t3", "Read", "done", { file_path: "/a.ts" }),
          entry("t4", "TaskUpdate", "done", { taskId: "1" }),
        ]}
      />,
    )
    expect(screen.getByText("已执行 2 条命令，已读取 1 个文件，已更新待办")).toBeInTheDocument()
  })

  test("未知工具落 other 桶", () => {
    render(<ToolRunGroup entries={[entry("t1", "SomeVendorTool", "done", { a: 1 })]} />)
    expect(screen.getByText("已调用 1 次工具")).toBeInTheDocument()
  })

  test("MCP 工具按前缀归 mcpCall 桶", () => {
    render(<ToolRunGroup entries={[entry("t1", "mcp_github_create_issue", "done", { a: 1 })]} />)
    expect(screen.getByText("已调用 1 次 MCP")).toBeInTheDocument()
  })

  test("失败条目在摘要行显示失败计数", () => {
    render(
      <ToolRunGroup
        entries={[
          entry("t1", "Bash", "done", { command: "ls" }),
          entry("t2", "Bash", "error", { command: "boom" }),
          entry("t3", "Bash", "denied", { command: "nope" }),
        ]}
      />,
    )
    expect(screen.getByText("已执行 3 条命令")).toBeInTheDocument()
    expect(screen.getByText("2 个失败")).toBeInTheDocument()
  })

  test("有在跑的条目时该类显示进行中文案", () => {
    render(
      <ToolRunGroup
        entries={[
          entry("t1", "Bash", "done", { command: "ls" }),
          entry("t2", "Read", "pending", { file_path: "/a.ts" }),
        ]}
      />,
    )
    expect(screen.getByText("已执行 1 条命令，正在读取文件")).toBeInTheDocument()
  })
})

describe("ToolRunGroup — 展开行为", () => {
  const pendingEntries = [entry("t1", "Bash", "pending", { command: "ls /tmp" })]

  test("运行中的段默认展开成明细行", () => {
    render(<ToolRunGroup entries={pendingEntries} autoExpandRunning />)
    expect(screen.getByTestId("tool-run-row")).toBeInTheDocument()
    // 段头摘要与明细行各自带一份「正在执行命令」文案
    expect(screen.getAllByText("正在执行命令")).toHaveLength(2)
    expect(screen.getByTestId("tool-row-toggle")).toBeInTheDocument()
  })

  test("autoExpandRunning=false 时运行中的段保持折叠", () => {
    render(<ToolRunGroup entries={pendingEntries} autoExpandRunning={false} />)
    expect(screen.queryByTestId("tool-run-row")).not.toBeInTheDocument()
  })

  test("已完成的段默认折叠", () => {
    render(<ToolRunGroup entries={[entry("t1", "Bash", "done", { command: "ls" })]} />)
    expect(screen.queryByTestId("tool-run-row")).not.toBeInTheDocument()
  })

  test("手动收起后, 运行中段的自动展开不再把它顶开", () => {
    const { rerender } = render(<ToolRunGroup entries={pendingEntries} autoExpandRunning />)
    expect(screen.getByTestId("tool-run-row")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tool-run-toggle"))
    expect(screen.queryByTestId("tool-run-row")).not.toBeInTheDocument()
    // 重渲 (流式追加会触发) 后仍然保持用户的收起选择
    rerender(<ToolRunGroup entries={pendingEntries} autoExpandRunning />)
    expect(screen.queryByTestId("tool-run-row")).not.toBeInTheDocument()
  })
})

describe("ToolRunGroup — 明细行展开详情", () => {
  test("点开明细行走该工具自己的输入渲染 (Read → 「文件」标签)", () => {
    render(
      <ToolRunGroup
        entries={[entry("t1", "Read", "done", { file_path: "/a.ts" }, "文件内容")]}
      />,
    )
    expect(screen.queryByText("结果")).not.toBeInTheDocument()
    // 已完成的段默认折叠, 先展开段头再展开明细行
    fireEvent.click(screen.getByTestId("tool-run-toggle"))
    fireEvent.click(screen.getByTestId("tool-row-toggle"))
    expect(screen.getByText("文件")).toBeInTheDocument()
    // 路径在折叠态的预览行与展开后的参数块里各出现一次
    expect(screen.getAllByText("/a.ts").length).toBeGreaterThan(0)
    expect(screen.getByText("结果")).toBeInTheDocument()
    expect(screen.getByText(/文件内容/)).toBeInTheDocument()
  })

  test("未注册工具回退到 generic 参数 JSON", () => {
    render(
      <ToolRunGroup
        entries={[entry("t1", "SomeVendorTool", "done", { alpha: "beta" })]}
      />,
    )
    fireEvent.click(screen.getByTestId("tool-run-toggle"))
    fireEvent.click(screen.getByTestId("tool-row-toggle"))
    expect(screen.getByText("参数")).toBeInTheDocument()
    expect(screen.getByText(/"alpha": "beta"/)).toBeInTheDocument()
  })

  test("失败条目在明细行标红并展开错误段", () => {
    const e = entry("t1", "Bash", "error", { command: "boom" })
    e.message.error = "命令不存在"
    render(<ToolRunGroup entries={[e]} />)
    fireEvent.click(screen.getByTestId("tool-run-toggle"))
    fireEvent.click(screen.getByTestId("tool-row-toggle"))
    expect(screen.getByText("失败")).toBeInTheDocument()
    expect(screen.getByText("错误")).toBeInTheDocument()
    expect(screen.getByText(/命令不存在/)).toBeInTheDocument()
  })
})