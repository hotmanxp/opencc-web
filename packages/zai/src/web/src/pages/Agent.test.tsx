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
  // 重置 mock appState 的可变字段 (maxVisibleMessages 等)
  setAppState({ maxVisibleMessages: 20 })
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

// Task 8 — visible tail + sticky "显示全部 (N 条隐藏)" pill.
// 当 messages.length > maxVisibleMessages 时, Agent 渲染一个 sticky pill,
// 文案 "显示全部 ({hiddenCount} 条隐藏)". 点击 pill 后 setShowAllMessages(true),
// pill 消失直到 messages 再次超过上限触发 useEffect reset.
describe("Agent.tsx — visibleMessages slice + sticky show-all pill", () => {
  // 构造 100 条 runtime.delta 消息: 模拟一个长对话, 触发 hiddenCount > 0.
  function buildMessages(n: number) {
    const out: any[] = []
    for (let i = 0; i < n; i++) {
      out.push({
        type: 'runtime.delta',
        eventId: `evt-${i}`,
        ts: 1000 + i,
        sessionId: 'sess-1',
        turnIndex: 0,
        delta: `delta-${i}`,
      })
    }
    return out
  }

  test("shows the show-all pill when messages exceed maxVisibleMessages", async () => {
    const mod = await import("../store/useAgentStore.js")
    mod.useAgentStore.setState({ messages: buildMessages(100) } as any)
    setAppState({ maxVisibleMessages: 20 })
    const { default: Agent } = await import("./Agent.jsx")
    const { getByTestId } = render(<Agent />)
    const pill = getByTestId("show-all-messages-pill")
    // 100 - 20 = 80 hidden; pill 文本含 "80 条隐藏".
    expect(pill.textContent).toMatch(/80\s*条隐藏/)
  })

  test("clicking pill shows all messages (pill disappears)", async () => {
    const mod = await import("../store/useAgentStore.js")
    mod.useAgentStore.setState({ messages: buildMessages(100) } as any)
    setAppState({ maxVisibleMessages: 20 })
    const { default: Agent } = await import("./Agent.jsx")
    const { getByTestId, queryByTestId } = render(<Agent />)
    const pill = getByTestId("show-all-messages-pill")
    fireEvent.click(pill)
    // showAllMessages=true → pill 不再渲染.
    expect(queryByTestId("show-all-messages-pill")).toBeNull()
  })
})

// Task: compact 模式 — 最后一条 LLM 文本消息 (type === 'assistant.text')
// 即使落在折叠区, 也必须展示出来. Regression: 旧实现判 messages[i].role
// 但 RuntimeEvent 没有 role 字段, 导致整个 compact 分支永远不命中.
describe("Agent.tsx — compact 输出模式:最后一条 LLM 文本保持可见", () => {
  // 构造 total 条消息, 在 assistantIdx 处放一条 assistant.text,
  // 其余 user.text / tool_use:start. 这种 raw 消息会被 upsertStreamBlock
  // 等 reducer 进一步 merge; 我们直接观察 visibleMessages.slice 的结果,
  // 即 pill 中 hiddenCount 文案.
  function buildCompactMessages(total: number, assistantIdx: number): any[] {
    const out: any[] = []
    for (let i = 0; i < total; i++) {
      if (i === assistantIdx) {
        out.push({
          type: 'assistant.text',
          eventId: `assistant-${i}`,
          ts: 1000 + i,
          sessionId: 'sess-1',
          turnIndex: 0,
          text: 'assistant reply',
        })
      } else {
        out.push({
          type: i % 2 === 0 ? 'user.text' : 'tool_use:start',
          eventId: `evt-${i}`,
          ts: 1000 + i,
          sessionId: 'sess-1',
          turnIndex: 0,
          text: i % 2 === 0 ? `user-${i}` : undefined,
          toolUseId: i % 2 === 1 ? `tu-${i}` : undefined,
          name: i % 2 === 1 ? 'Bash' : undefined,
          input: i % 2 === 1 ? {} : undefined,
        })
      }
    }
    return out
  }

  test("compact 模式:hiddenCount 收紧到最后一条 assistant.text 的索引", async () => {
    // 30 条消息, assistant 在 idx=5 (会被默认 hc=20 折叠).
    // compact 分支: 5 < hc=20, 收紧 hiddenCount = 5.
    setAppState({ maxVisibleMessages: 10, outputStyle: 'compact' })
    const mod = await import("../store/useAgentStore.js")
    mod.useAgentStore.setState({
      messages: buildCompactMessages(30, 5),
    } as any)
    const { default: Agent } = await import("./Agent.jsx")
    const { getByTestId } = render(<Agent />)
    const pill = getByTestId("show-all-messages-pill")
    expect(pill.textContent).toMatch(/5\s*条隐藏/)
  })

  test("compact 模式:assistant 已在 visible 区时不收紧 (走默认 hc)", async () => {
    // 20 条消息, assistant 在 idx=19 (末尾). hc=10, idx=19 >= hc,
    // 不触发 compact 分支, 默认 slice(10) — hiddenCount = 10.
    setAppState({ maxVisibleMessages: 10, outputStyle: 'compact' })
    const mod = await import("../store/useAgentStore.js")
    mod.useAgentStore.setState({
      messages: buildCompactMessages(20, 19),
    } as any)
    const { default: Agent } = await import("./Agent.jsx")
    const { getByTestId } = render(<Agent />)
    const pill = getByTestId("show-all-messages-pill")
    expect(pill.textContent).toMatch(/10\s*条隐藏/)
  })

  test("非 compact 模式:行为保持不变 (default hc = length - limit)", async () => {
    // 30 条消息, assistant 在 idx=5. outputStyle=default, 走旧路径,
    // hiddenCount = 30 - 10 = 20 (与是否含 assistant.text 无关).
    setAppState({ maxVisibleMessages: 10, outputStyle: 'default' })
    const mod = await import("../store/useAgentStore.js")
    mod.useAgentStore.setState({
      messages: buildCompactMessages(30, 5),
    } as any)
    const { default: Agent } = await import("./Agent.jsx")
    const { getByTestId } = render(<Agent />)
    const pill = getByTestId("show-all-messages-pill")
    expect(pill.textContent).toMatch(/20\s*条隐藏/)
  })
})
