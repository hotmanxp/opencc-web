// @vitest-environment happy-dom
// 移动端 /m 路由下的 @-mention 流程。
//
// 设计:zai 的 MobileAgent.tsx 渲染 <AgentConversation />,后者挂载 <AgentInputBox />,
// 而 AgentInputBox 从 useAppStore.isMobile 读取移动端判断 —— 它会自然响应
// isMobile 切换。本文件验证 useAppStore.isMobile=true 时:
//
//   - 文件补全 popup 正常显示(位置/键盘交互一致)
//   - 移动端"停止"按钮等专属控件存在不影响 at-mention 路径
//
// 不需要直接渲染 MobileAgent.tsx(它会拉取 sessions + 自动建会话,测试会拖慢)。
import { describe, expect, test, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentStore, type V2TaskItem } from "../store/useAgentStore.js";
import { useAppStore } from "../store/useAppStore.js";

const v2 = (id: string, subject: string, status: V2TaskItem["status"]): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0,
});

import AgentInputBox from "./AgentInputBox.js";

vi.mock("../components/ConversationInfoButton.js", () => ({
  default: () => null,
}));

vi.mock("../lib/api.js", () => ({
  api: {
    post: vi.fn(async () => ({})),
  },
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    if (typeof url === "string" && url.startsWith("/api/slash")) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (typeof url === "string" && url.startsWith("/api/fs/search")) {
      return new Response(
        JSON.stringify({
          ok: true,
          entries: [
            { path: "src/foo.ts", name: "foo.ts", type: "file", score: 10 },
            { path: "src", name: "src", type: "dir", score: 5 },
          ],
          truncated: false,
          durationMs: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }),
);

beforeEach(() => {
  useAgentStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionId: null,
    status: "idle",
    pendingAsk: null,
    queuedPrompts: [],
    v2TasksBySession: {},
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    messages: [],
  });
  // 关键:isMobile=true 模拟移动端路由。
  useAppStore.setState({
    isMobile: true,
    streamState: "connected",
    streamAttempt: 0,
    transcriptCollapsed: false,
    quickDrawerOpen: false,
    outputStyle: "default",
  });
});

async function typeText(ta: HTMLTextAreaElement, text: string) {
  fireEvent.change(ta, { target: { value: text, selectionStart: text.length } });
}

describe("AgentInputBox — 移动端 @-mention 流程", () => {
  test("isMobile=true 时 @-mention popup 仍然弹出", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src")).toBeInTheDocument();
    });
  });

  test("移动端:键盘 Enter 选中候选同样工作", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@src/foo");
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src/foo.ts")).toBeInTheDocument();
    });
    // 第一项是 src/foo.ts(score 最高),选中后 draft 变为占位符 chip
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(ta.value).toBe("\ufffc ");
    });
  });

  test("移动端:选中目录 → 也插入 chip(dir 类型)", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src")).toBeInTheDocument();
    });
    // 移动端无鼠标,通过键盘选中:ArrowDown 移到 src(它在初始顺序里是第几?)
    // mock 返回:src/foo.ts, src. 排序后 src/foo.ts (score 10) > src (score 5)。
    // atMenuIdx=0 是 src/foo.ts,选目录需要 ArrowDown 移到 src。
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "Enter" });
    // dir 引用也落为 chip(draft 只留占位符)
    await waitFor(() => {
      expect(ta.value).toBe("\ufffc ");
    });
  });
});