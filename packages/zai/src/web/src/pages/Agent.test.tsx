// @vitest-environment happy-dom
// @ts-nocheck
import { describe, expect, test, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { fireEvent, render } from "@testing-library/react";

// useAppStore mock: 同时支持 selector 形式 useAppStore((s) => s.x) 和
// 无参形式 useAppStore() (Agent.tsx 顶层解构 instanceContext 用).
// 闭包持有 appState 引用, 测试可通过 setAppState({ ... }) 注入字段;
// 渲染前必须先 setAppState, 因为 mock 第一次调用会读 appState.
const appState: any = {
  instanceContext: { cwdName: '~', branch: 'master' },
  toasts: [],
  jobs: {},
  setInstanceContext: vi.fn(),
  maxVisibleMessages: 20,
}
function setAppState(patch: Record<string, any>) {
  Object.assign(appState, patch)
}
vi.mock("../store/useAppStore.js", () => ({
  useAppStore: (selector?: any) => (selector ? selector(appState) : appState),
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
vi.mock("./AgentConversation", () => ({
  // AgentConversation 内部从 useAppStore.isMobile 读移动端判断, 不再接 props.
  // mock 只暴露一个 data-testid 节点, 让测试断言 "AgentConversation 是否被渲染".
  default: () => <div data-testid="agent-conv" />,
}))

// (2026-07-31: BottomStatusBar 组件已删除, 顶层不再需要 mock.)
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
    v2TasksBySession: {},
  })
  // 重置 mock appState 的可变字段 (maxVisibleMessages 等)
  setAppState({ maxVisibleMessages: 20 })
})

describe("Agent.tsx — 顶层结构", () => {
  test("Agent 顶层不渲染已被删除的 BottomStatusBar 行", async () => {
    const { default: Agent } = await import("./Agent.jsx")
    const { queryByTestId } = render(<Agent />)
    // 修复: 任务 dock 已合并到 AgentInputBox 内的状态行, 顶层不该再渲染
    // BottomStatusBar 单独一行, 让 UI 更紧凑 (2026-07-31: 整组件已移除).
    expect(queryByTestId("bottom-status-trigger")).toBeNull();
  }, 30_000)
})
