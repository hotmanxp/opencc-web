// @vitest-environment happy-dom
// @-mention 文件补全的组件级测试。
//
// 输入面已经是 Lexical contenteditable(不再是受控 textarea),因此「打字」
// 走编辑器的 insertText、「按键」走真实 keydown → Lexical 命令分发,
// chip 断言读可见 DOM。草稿内容一律用 detect 投影核对(chip = 1 个 U+FFFC),
// 与应用层 token 探测用的是同一份坐标文本。
import { describe, expect, test, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAgentStore, type V2TaskItem } from "../store/useAgentStore.js";
import { useAppStore } from "../store/useAppStore.js";
import { api } from "../lib/api.js";
import { AGENT_INPUT_INSERT_EVENT } from "../lib/agentInputEvents.js";
import {
  detectTextOf,
  editorRoot,
  pressEditorKey,
  setDraftText,
  tokenMarkOf,
} from "./input/editor/testDriver.js";

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

describe("AgentInputBox — @-mention 文件补全", () => {
  test("敲 @ → 弹出文件候选 popup", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "@");
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
    const ed = editorRoot();
    setDraftText(ed, "foo@bar.com");
    expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
  });

  test("行中段 @src 触发 popup(query 含 / 走 dir-scoped)", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "看一下 @src/foo");
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    });
    // 等防抖 + fetch 完成 → items 渲染
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-row-src/foo.ts")).toBeInTheDocument();
    });
  });

  test("鼠标点击 file 候选 → draft 变为 chip 占位 + 尾随空格", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    setDraftText(ed, "@");
    const row = await screen.findByTestId("file-mention-row-src/foo.ts");
    // mousedown 而非 click:测试用 fireEvent.mouseDown 模拟
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    // chip 在 detect 投影里恰好占 1 个 U+FFFC + 尾随空格
    await waitFor(() => {
      expect(detectTextOf(ed)).toBe("￼ ");
    });
    // 编辑器里渲染真实 chip(path / type 正确)
    await waitFor(() => {
      const chip = container.querySelector(
        '[data-testid="mention-chip"][data-mention-path="src/foo.ts"]',
      );
      expect(chip).not.toBeNull();
      expect(chip?.getAttribute("data-mention-type")).toBe("file");
    });
  });

  test("点击目录 → 下钻:token 变为 @src/ 纯文本,不落 chip", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    setDraftText(ed, "@");
    const row = await screen.findByTestId("file-mention-row-src");
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    // dir 选择改为下钻:token 替换为 `@src/` 文本,不生成 chip
    await waitFor(() => {
      expect(detectTextOf(ed)).toBe("@src/");
    });
    expect(
      container.querySelector('[data-testid="mention-chip"]'),
    ).toBeNull();
  });

  test("选中目录后弹层保持打开,继续列子条目", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "@");
    await screen.findByTestId("file-mention-row-src");
    fireEvent.mouseDown(screen.getByTestId("file-mention-row-src"), {
      preventDefault: () => {},
    });
    // 新语义:选目录 = 下钻,popup 不关闭,以 `src/` 为查询路径重新拉取
    await waitFor(() => {
      expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    });
    await screen.findByTestId("file-mention-row-src/foo.ts");
  });

  test("键盘 ↑↓ + Enter 选中候选", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "@");
    await screen.findByTestId("file-mention-popover");
    // 等 items 加载完
    await screen.findByTestId("file-mention-row-src");
    // 默认 activeIndex=0 (src)。按 ArrowDown → 切到 README.md。
    pressEditorKey(ed, "ArrowDown");
    pressEditorKey(ed, "Enter");
    await waitFor(() => {
      expect(detectTextOf(ed)).toBe("￼ ");
    });
  });

  test("Escape 关闭 popup 并删除 @ token", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "hello @");
    expect(screen.getByTestId("file-mention-popover")).toBeInTheDocument();
    pressEditorKey(ed, "Escape");
    await waitFor(() => {
      expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
    });
    expect(detectTextOf(ed)).toBe("hello ");
  });

  test("外层 mousedown(点输入面外)关闭 popup", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "@");
    await screen.findByTestId("file-mention-popover");
    // 模拟在 document body 某处 mousedown(popover 容器外)
    fireEvent.mouseDown(document.body);
    await waitFor(() => {
      expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
    });
    // 输入框文本应只剩去掉 @ token 后的部分
    expect(detectTextOf(ed)).toBe("");
  });

  test("@ 与 / slash 互斥:输入以 / 开头时不显示 @ popup", async () => {
    render(<AgentInputBox />);
    const ed = editorRoot();
    setDraftText(ed, "/foo");
    // slashItems 为空数组,所以 slash popup 不挂载,这部分只验证 at 也不挂。
    expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
  });

  test("激活的 @-token 段被染成命令色", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    setDraftText(ed, "hello @foo");
    // token 高亮现在是 TextNode 的行内样式(--cmd-token-color),不再是
    // backdrop 里的装饰 span
    await waitFor(() => {
      const mark = tokenMarkOf(container);
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe("@foo");
    });
  });

  test("选中 file 候选后 → 渲染 MentionChip(basename 展示,不显示全路径)", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    setDraftText(ed, "@");
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
    // chip 只展示 basename(用户原意:不在输入框里把全路径放出来)
    expect(chip?.textContent).toContain("foo.ts");
    expect(chip?.textContent).not.toContain("src/");
    // detect 投影里是占位符(发给 LLM 时再展开为 @path)
    expect(detectTextOf(ed)).toBe("￼ ");
  });

  test("目录 → 子文件连选:先点 src 下钻,再点 foo.ts 落为最终 chip", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    setDraftText(ed, "@");
    const row = await screen.findByTestId("file-mention-row-src");
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    await waitFor(() => {
      expect(detectTextOf(ed)).toBe("@src/");
    });
    // 子文件选中才是最终选择:token 替换为 chip,popup 关闭
    const child = await screen.findByTestId("file-mention-row-src/foo.ts");
    fireEvent.mouseDown(child, { preventDefault: () => {} });
    await waitFor(() => {
      expect(detectTextOf(ed)).toBe("￼ ");
    });
    const chip = container.querySelector(
      '[data-testid="mention-chip"][data-mention-path="src/foo.ts"]',
    );
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-mention-type")).toBe("file");
    await waitFor(() => {
      expect(screen.queryByTestId("file-mention-popover")).not.toBeInTheDocument();
    });
  });

  test("选中候选后输入面不重建(combo 模式:同一个 DOM 元素继续持有焦点)", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    ed.focus();
    setDraftText(ed, "@");
    const row = await screen.findByTestId("file-mention-row-src/foo.ts");
    fireEvent.mouseDown(row, { preventDefault: () => {} });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="mention-chip"]')).not.toBeNull();
    });
    // 选完 chip 之后还是同一个元素(没有 remount 掉焦点)
    expect(editorRoot(container)).toBe(ed);
  });

  // AGENT_INPUT_INSERT_EVENT 仍然有效(分屏插入对话 → 现在插入为 @引用 chip)
  test("AGENT_INPUT_INSERT_EVENT 把路径插入为 chip,不影响后续 at-token", async () => {
    const { container } = render(<AgentInputBox />);
    const ed = editorRoot(container);
    setDraftText(ed, "@fo");
    await screen.findByTestId("file-mention-popover");
    // 模拟分屏插入一段路径:光标在 "o" 之后 → 前置空格分隔 + chip + 尾随空格
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_INPUT_INSERT_EVENT, { detail: { text: "/path/to" } }),
      );
    });
    await waitFor(() => {
      expect(detectTextOf(ed)).toBe("@fo ￼ ");
    });
    const chip = container.querySelector('[data-testid="mention-chip"]');
    expect(chip?.getAttribute("data-mention-path")).toBe("/path/to");
  });
});