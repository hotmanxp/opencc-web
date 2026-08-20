// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentStore, type V2TaskItem } from "../store/useAgentStore.js";
import { useAppStore } from "../store/useAppStore.js";
import { api } from "../lib/api.js";
import { AGENT_INPUT_INSERT_EVENT } from "../lib/agentInputEvents.js";

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

// /api/slash 的固定 stub(让 AgentInputBox 首挂载正常拉到空数组,不抛错即可)
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
      // 默认返回 cwd 顶层条目(空 query 的行为)
      // 嵌套条目用于验证选目录后继续展开子内容
      return new Response(
        JSON.stringify({
          ok: true,
          entries: [
            { path: "src", name: "src", type: "dir", score: 0 },
            { path: "README.md", name: "README.md", type: "file", score: 0 },
            { path: "src/foo.ts", name: "foo.ts", type: "file", score: 5 },
            { path: "src/bar.ts", name: "bar.ts", type: "file", score: 3 },
            { path: "src/cli", name: "cli", type: "dir", score: 0 },
            { path: "src/server", name: "server", type: "dir", score: 0 },
            { path: "src/cli/one.ts", name: "one.ts", type: "file", score: 5 },
            { path: "src/cli/two.ts", name: "two.ts", type: "file", score: 3 },
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
  vi.mocked(api.post).mockReset();
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
  useAppStore.setState({
    streamState: "connected",
    streamAttempt: 0,
    transcriptCollapsed: false,
    isMobile: false,
    quickDrawerOpen: false,
    outputStyle: "default",
  });
});

async function typeText(ta: HTMLTextAreaElement, text: string) {
  // 用 fireEvent.change 模拟受控 textarea;同时手动同步 cursor state(组件在 onChange 里改)。
  fireEvent.change(ta, { target: { value: text, selectionStart: text.length } });
}

describe("AgentInputBox — @-mention 文件补全", () => {
  test("敲 @ → 弹出文件候选 popup", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    });
    // 等 hook 的 150ms 防抖 + fetch 完成 → items 渲染。
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src")).toBeInTheDocument();
    });
    expect(screen.getByTestId("file-mention-row-README.md")).toBeInTheDocument();
  });

  test("邮箱 foo@bar.com 不触发 popup", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "foo@bar.com");
    expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
  });

  test("行中段 @src 触发 popup(query 含 / 走 dir-scoped)", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "看一下 @src/foo");
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    });
    // 等防抖 + fetch 完成 → items 渲染
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src/foo.ts")).toBeInTheDocument();
    });
  });

  test("鼠标点击 file 候选 → 输入框文本替换为 @<path> + 空格", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    const row = await screen.findByTestId("file-mention-row-src/foo.ts");
    // mousedown 而非 click:测试用 fireEvent.mouseDown 模拟
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    // 注:fireEvent.mouseDown 不会自动调用 preventDefault;真实环境里组件的
    // onMouseDown 内部就调 preventDefault。这里直接验证 setInput 之后的 ta.value。
    await waitFor(() => {
      expect(ta.value).toMatch(/^@src\/foo\.ts $/);
    });
  });

  test("选中目录 → 文本变成 @dir/(尾随 /,cursor 仍在 token 末尾 — popover 继续展开)", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    const row = await screen.findByTestId("file-mention-row-src");
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    // dir 选择不加尾随空格,让 cursor 留在 token 末尾,grammar 继续
    // 视作 active 触发 dir-scoped 搜索
    await waitFor(() => {
      expect(ta.value).toBe("@src/");
    });
  });

  test("选中目录后弹层不关闭,继续展示该目录子内容", async () => {
    // 修复需求:用户选目录后应该看到子内容,而不是被切断
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    await screen.findByTestId("file-mention-row-src");
    fireEvent.mouseDown(screen.getByTestId("file-mention-row-src"), {
      preventDefault: () => {},
    });
    // 弹层应该保持打开
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    });
    // 同时新 query = "src/" 触发 listDirectoryForSearch:展示 src/ 的内容
    // 等待防抖 + fetch,然后断言新行 src/cli, src/server 等出现
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src/cli")).toBeInTheDocument();
    });
    // 用户可以接着选 src/ 下的条目
    expect(screen.getByTestId("file-mention-row-src/server")).toBeInTheDocument();
  });

  test("键盘 ↑↓ + Enter 选中候选", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    await screen.findByTestId("file-mention-popover");
    // 等 items 加载完
    await screen.findByTestId("file-mention-row-src");
    // 默认 activeIndex=0 (src)。按 ArrowDown → 切到 README.md。
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(ta.value).toMatch(/^@README\.md $/);
    });
  });

  test("Escape 关闭 popup 并删除 @ token", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "hello @");
    expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
    });
    expect(ta.value).toBe("hello ");
  });

  test("外层 mousedown(点 textarea 外)关闭 popup", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    await screen.findByTestId("file-mention-popover");
    // 模拟在 document body 某处 mousedown(popover 容器外)
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
    });
    // 输入框文本应只剩去掉 @ token 后的部分
    expect(ta.value).toBe("");
  });

  test("@ 与 / slash 互斥:输入以 / 开头时不显示 @ popup", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "/foo");
    // slashItems 为空数组,所以 slash popup 不挂载,这部分只验证 at 也不挂。
    expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
  });

  test("mirror-backdrop 把 active @-token 段染紫", async () => {
    const { container } = render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "hello @foo");
    // active atToken 段渲染为 span[data-decoration=token-mark],CSS
    // 把它染紫(.agent-input-cmd-token 选择器)
    await waitFor(() => {
      const mark = container.querySelector('[data-decoration="token-mark"]');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe("@foo");
    });
  });

  test("选中 file 候选后 → backdrop 渲染 MentionChip(整段染色,只显示 basename)", async () => {
    const { container } = render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    const row = await screen.findByTestId("file-mention-row-src/foo.ts");
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="mention-chip"]'),
      ).not.toBeNull();
    });
    const chip = container.querySelector(
      '[data-testid="mention-chip"][data-mention-path="src/foo.ts"]',
    ) as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-mention-type")).toBe("file");
    // chip visible 只显示 basename(用户原意:不在输入框里把全路径放出来)
    const visibleSpans = chip?.querySelectorAll('span:not([style*="visibility: hidden"])') ?? [];
    const visibleText = Array.from(visibleSpans).map(s => s.textContent ?? "").join("|");
    expect(visibleText).toContain("foo.ts");
    expect(visibleText).not.toContain("src/");
    // chip 整段宽度由 placeholder 撑开(避免后续文本贴边)
    const placeholder = chip?.querySelector('span[style*="visibility: hidden"]') as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    // textarea 拿到的还是全路径(给 LLM 看)
    expect(ta.value).toContain("@src/foo.ts");
  });

  test("选中 dir 候选后 → 不渲染 chip(让 popover 继续展开,dir 仍在 active 状态)", async () => {
    const { container } = render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@");
    const row = await screen.findByTestId("file-mention-row-src");
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    // dir 选完后 input 应该没有 chip(因为 cursor 还在 atToken 末尾,atToken
    // 仍是 active 状态,grammatically 让弹层继续展示子目录)
    await waitFor(() => {
      expect(ta.value).toBe("@src/");
    });
    // 此时没有 chip(因为 atToken 是 active)
    const chip = container.querySelector('[data-testid="mention-chip"]');
    expect(chip).toBeNull();
    // 弹层继续展示 src/ 的子内容(测试 选中目录后弹层不关闭 已经覆盖)
  });

  test("typing 后输入框值正确,textarea 仍持有焦点(combobox 模式)", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    ta.focus();
    await typeText(ta, "@");
    // selectAtEntry 不卸载 textarea,focus 仍在 textarea。
    await screen.findByTestId("file-mention-popover");
    expect(document.activeElement).toBe(ta);
  });

  // AGENT_INPUT_INSERT_EVENT 仍然有效(分屏插入对话测试)
  test("AGENT_INPUT_INSERT_EVENT 把文本插入到光标处不影响 at-token 检测", async () => {
    render(<AgentInputBox />);
    const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement;
    await typeText(ta, "@fo");
    await screen.findByTestId("file-mention-popover");
    // 模拟分屏插入一段文字到 textarea
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: "/path/to" } }),
      );
    });
    await waitFor(() => {
      expect(ta.value).toMatch(/@fo\/path\/to/);
    });
  });
});