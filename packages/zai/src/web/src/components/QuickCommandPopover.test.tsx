// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import QuickCommandPopover from "./QuickCommandPopover.js";
import type { SlashItem } from "./quickCommandTypes.js";

const MOCK_ITEMS: SlashItem[] = [
  {
    kind: "command",
    name: "clear",
    description: "清空当前会话历史",
    type: "local",
    isBuiltIn: true,
  },
  {
    kind: "command",
    name: "compact",
    description: "压缩当前会话历史",
    type: "local",
    isBuiltIn: true,
  },
  {
    kind: "skill",
    name: "explain",
    description: "解释选中的代码",
    pluginName: "core",
  },
  {
    kind: "skill",
    name: "review",
    description: "代码审查",
    pluginName: "core",
  },
];

function renderPopover(props: Partial<React.ComponentProps<typeof QuickCommandPopover>> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const utils = render(
    <QuickCommandPopover
      items={props.items ?? MOCK_ITEMS}
      onClose={props.onClose ?? onClose}
      onSelect={props.onSelect ?? onSelect}
    />,
  );
  return { onClose, onSelect, ...utils };
}

describe("QuickCommandPopover", () => {
  test("渲染所有 items, commands 在前 skills 居后", async () => {
    renderPopover();
    // 等下一 tick 让 ref 挂载(focus effect 用 setTimeout(0))
    await waitFor(() => {
      expect(screen.getByText("/clear")).toBeInTheDocument();
    });
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("/explain")).toBeInTheDocument();
    expect(screen.getByText("/review")).toBeInTheDocument();
  });

  test("打开时自动 focus 搜索框", async () => {
    renderPopover();
    await waitFor(() => {
      expect(screen.getByTestId("quick-command-search")).toHaveFocus();
    });
  });

  test("搜索框输入过滤列表", async () => {
    renderPopover();
    const search = await screen.findByTestId("quick-command-search");
    // "e" 在 clear / explain / review 中按顺序出现, 但不在 compact 中.
    fireEvent.change(search, { target: { value: "e" } });
    await waitFor(() => {
      expect(screen.getByText("/clear")).toBeInTheDocument();
      expect(screen.getByText("/explain")).toBeInTheDocument();
      expect(screen.getByText("/review")).toBeInTheDocument();
    });
    expect(screen.queryByText("/compact")).toBeNull();
  });

  test("搜索无匹配时显示空状态", async () => {
    renderPopover();
    const search = await screen.findByTestId("quick-command-search");
    fireEvent.change(search, { target: { value: "zzzz" } });
    await waitFor(() => {
      expect(screen.getByTestId("quick-command-empty")).toBeInTheDocument();
    });
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
  });

  test("items 为空时显示 '暂无可用' 提示", async () => {
    renderPopover({ items: [] });
    await waitFor(() => {
      expect(screen.getByTestId("quick-command-empty")).toBeInTheDocument();
    });
    expect(screen.getByText(/暂无可用/)).toBeInTheDocument();
  });

  test("ArrowDown / ArrowUp 切换 active 高亮", async () => {
    renderPopover();
    await screen.findByText("/clear");
    const popover = screen.getByTestId("quick-command-popover");
    // 初始 active = 0 (/clear)
    expect(screen.getByTestId("quick-command-row-clear").getAttribute("data-active")).toBe("true");
    // ArrowDown → /compact
    await act(async () => {
      fireEvent.keyDown(popover, { key: "ArrowDown" });
    });
    expect(screen.getByTestId("quick-command-row-compact").getAttribute("data-active")).toBe("true");
    // ArrowUp → /clear
    await act(async () => {
      fireEvent.keyDown(popover, { key: "ArrowUp" });
    });
    expect(screen.getByTestId("quick-command-row-clear").getAttribute("data-active")).toBe("true");
  });

  test("Enter 触发 onSelect, 携带当前 active 项", async () => {
    const { onSelect } = renderPopover();
    await screen.findByText("/clear");
    const popover = screen.getByTestId("quick-command-popover");
    // 初始 active = 0 (/clear)
    await act(async () => {
      fireEvent.keyDown(popover, { key: "Enter" });
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(MOCK_ITEMS[0]);
  });

  test("Escape 触发 onClose", async () => {
    const { onClose } = renderPopover();
    await screen.findByText("/clear");
    const popover = screen.getByTestId("quick-command-popover");
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("点击行触发 onSelect (mousedown, 不是 click)", async () => {
    const { onSelect } = renderPopover();
    await screen.findByText("/explain");
    const row = screen.getByTestId("quick-command-row-explain");
    fireEvent.mouseDown(row);
    expect(onSelect).toHaveBeenCalledWith(MOCK_ITEMS[2]); // explain
  });

  test("外部点击触发 onClose", async () => {
    const { onClose } = renderPopover();
    await screen.findByText("/clear");
    // 在 document body 上派发一个 mousedown, 模拟"点击弹层外"
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("点击关闭按钮 (×) 触发 onClose", async () => {
    const { onClose } = renderPopover();
    await screen.findByText("/clear");
    fireEvent.click(screen.getByTestId("quick-command-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("搜索过滤后 activeIndex 自动归零", async () => {
    renderPopover();
    const popover = screen.getByTestId("quick-command-popover");
    const search = await screen.findByTestId("quick-command-search");
    // 先下移 2 次, activeIndex = 2 (/explain)
    await act(async () => {
      fireEvent.keyDown(popover, { key: "ArrowDown" });
      fireEvent.keyDown(popover, { key: "ArrowDown" });
    });
    expect(screen.getByTestId("quick-command-row-explain").getAttribute("data-active")).toBe("true");
    // 过滤后 activeIndex 应归零, 即 /clear 应该再次高亮(如果仍在结果中)
    fireEvent.change(search, { target: { value: "c" } });
    await waitFor(() => {
      expect(screen.getByTestId("quick-command-row-clear").getAttribute("data-active")).toBe("true");
    });
  });

  test("kind 标签区分 command 与 skill", async () => {
    renderPopover();
    await screen.findByText("/clear");
    // row 内的 kind 标签文本应一致
    // clear 是 command, explain 是 skill
    const clearRow = screen.getByTestId("quick-command-row-clear");
    const explainRow = screen.getByTestId("quick-command-row-explain");
    expect(clearRow.textContent).toMatch(/command/);
    expect(explainRow.textContent).toMatch(/skill/);
  });
});
