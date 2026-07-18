// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import "@testing-library/jest-dom";
import { BottomStatusBar } from "./BottomStatusBar.js";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({
  content, status, activeForm: content,
});
const v2 = (id: string, subject: string, status: V2TaskItem["status"]): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0,
});

describe("BottomStatusBar", () => {
  test("空 todos + 空 v2 渲染空态", () => {
    render(<BottomStatusBar todos={[]} v2Tasks={[]} />);
    expect(screen.getByTestId("bottom-status-trigger")).toHaveTextContent("暂无 任务");
    expect(screen.queryByTestId("bottom-status-summary")).toBeNull();
  });

  test("仅 todos 时摘要只算 todo", () => {
    const todos: TodoItem[] = [
      todo("a", "completed"),
      todo("b", "completed"),
      todo("c", "in_progress"),
      todo("d", "pending"),
    ];
    render(<BottomStatusBar todos={todos} v2Tasks={[]} />);
    const summary = screen.getByTestId("bottom-status-summary");
    expect(summary).toHaveTextContent("2/4 任务");
    expect(summary).toHaveTextContent("1 进行中");
    expect(summary).toHaveTextContent("1 待开始");
  });

  test("合并 todos + v2 进度", () => {
    render(
      <BottomStatusBar
        todos={[todo("a", "completed")]}
        v2Tasks={[
          v2("v1", "v2 task", "in_progress"),
          v2("v2", "v2 done", "completed"),
          v2("v3", "v2 pending", "pending"),
        ]}
      />,
    );
    const summary = screen.getByTestId("bottom-status-summary");
    expect(summary).toHaveTextContent("2/4 任务"); // 1 + 3
    expect(summary).toHaveTextContent("1 进行中");
    expect(summary).toHaveTextContent("1 待开始"); // 0 老 pending + 1 v2 pending
  });

  test("全完成时进度数字染绿", () => {
    render(
      <BottomStatusBar
        todos={[todo("a", "completed"), todo("b", "completed")]}
        v2Tasks={[]}
      />,
    );
    const summary = screen.getByTestId("bottom-status-summary");
    const greenSpan = summary.querySelector("span")
    expect(greenSpan?.style.color).toBe("#52c41a") // inline hex preserved by happy-dom
  });

  test("点击 trigger 展开 popover 并渲染合并的 dropdown", async () => {
    render(
      <BottomStatusBar
        todos={[todo("first", "in_progress")]}
        v2Tasks={[v2("v1", "v2 task", "pending")]}
      />,
    );
    fireEvent.click(screen.getByTestId("bottom-status-trigger"))
    await waitFor(() => expect(screen.getByTestId("todo-dropdown")).toBeInTheDocument())
    expect(screen.getByTestId("todo-dropdown-item-in_progress")).toHaveTextContent("first")
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("v2 task")
  });
})