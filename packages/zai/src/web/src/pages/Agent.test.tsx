// @vitest-environment happy-dom
// @ts-nocheck
import { describe, expect, test, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

// 把 Agent.tsx 内部会触发的副作用全部 mock 掉, 只关注"页面是否还渲染
// BottomStatusBar" — 修复后, 任务 dock 已合并到 AgentInputBox 状态行,
// 顶层不再需要 BottomStatusBar 这条独立行.
vi.mock("../store/useAppStore.js", () => ({
  useAppStore: () => ({
    instanceContext: { cwdName: '~', branch: 'master' },
    toasts: [],
    jobs: {},
    setInstanceContext: vi.fn(),
  }),
}))
vi.mock("../hooks/useSessionCwd.js", () => ({
  useSessionCwd: () => undefined,  // SessionCwdBridge 内部 hook:no-op for tests
}))
// 把整个 SessionCwdBridge mock 掉,因为它的 useEffect 链在 Agent 测试
// 关心不到,提前让它什么都不渲染
vi.mock("../components/SessionCwdBridge.js", () => ({
  SessionCwdBridge: () => null,
}))
vi.mock("../components/TaskDrawer.js", () => ({
  TaskDrawer: () => null,
}))
vi.mock("../components/QuestionCard.jsx", () => ({
  default: () => null,
}))
vi.mock("../components/DiffBlock.js", () => ({
  default: () => null,
}))
vi.mock("../components/AttachmentStrip.js", () => ({
  AttachmentStrip: () => null,
}))
vi.mock("../components/ConfigStatusBar.js", () => ({
  default: () => null,
}))
vi.mock("../components/ModeStatusButton.js", () => ({
  default: () => null,
  MODE_CYCLE_ORDER: [],
}))
vi.mock("../components/TodoZone.jsx", () => ({
  default: () => null,
}))
vi.mock("../components/AgentInputBox.js", () => ({
  default: () => null,
}))
// BottomStatusBar mock: 如果 Agent 还在用它, 会渲染 test-id; 不再被调用就拿不到.
vi.mock("../components/BottomStatusBar.js", () => ({
  BottomStatusBar: () => <div data-testid="bottom-status-trigger">SHOULD NOT BE USED</div>,
}))
vi.mock("../lib/v2TaskApi.js", () => ({
  fetchV2Tasks: vi.fn(async () => []),
}))
vi.mock("../lib/imageReader.js", () => ({
  readImageAsBase64: vi.fn(),
  ImageReadError: class extends Error {},
}))

beforeEach(async () => {
  // 引入 store, 重置初态
  const mod = await import("../store/useAgentStore.js")
  mod.useAgentStore.setState({
    sessionId: null,
    sessions: [],
    messages: [],
    status: 'idle',
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    todosBySession: {},
    v2TasksBySession: {},
  })
})

describe("Agent.tsx — 不再渲染 BottomStatusBar (任务已合并到 AgentInputBox)", () => {
  test("Agent 顶层不再调用 BottomStatusBar", async () => {
    const { default: Agent } = await import("./Agent.jsx")
    const { queryByTestId } = render(<Agent />)
    // 修复: 任务 dock 已合并到 AgentInputBox 内的状态行, 顶层不该再渲染
    // BottomStatusBar 单独一行, 让 UI 更紧凑.
    expect(queryByTestId("bottom-status-trigger")).toBeNull();
    // 既然任务行不在了, todosBySession / v2TasksBySession 这两个变量在 Agent.tsx
    // 也变成了 dead code — 这个测试只关心渲染层面.
  })
})