// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import TodoDropdown from "./TodoDropdown.js";
import type { V2TaskItem } from "../store/useAgentStore.js";

const v2 = (id: string, subject: string, status: V2TaskItem["status"], extra: Partial<V2TaskItem> = {}): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0, ...extra,
});

describe("TodoDropdown", () => {
  test("空 v2 渲染 empty 提示", () => {
    render(<TodoDropdown v2Tasks={[]} />);
    expect(screen.getByTestId("todo-dropdown-empty")).toHaveTextContent("暂无任务");
    expect(screen.queryByTestId("todo-dropdown")).toBeNull();
  });

  test("v2 task 含 blockedBy 时显示依赖数量", () => {
    render(
      <TodoDropdown
        v2Tasks={[v2("v1", "blocked", "pending", { blockedBy: ["a", "b"] })]}
      />,
    );
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("依赖 2");
  });

  test("v2 task deleted 状态显示 ✗ 删除线", () => {
    render(
      <TodoDropdown v2Tasks={[v2("v1", "deleted one", "deleted")]} />,
    );
    expect(screen.getByTestId("v2-task-dropdown-item-deleted")).toHaveTextContent("deleted one");
  });

  test("v2 任务列表渲染 N/M 完成 · K 进行中 摘要", () => {
    render(
      <TodoDropdown
        v2Tasks={[
          v2("v1", "分析需求", "completed"),
          v2("v2", "写代码", "in_progress"),
          v2("v3", "写测试", "pending"),
        ]}
      />,
    );
    expect(screen.getByTestId("todo-dropdown")).toBeInTheDocument();
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("1/3 完成");
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("1 进行中");
    expect(screen.getByTestId("v2-task-dropdown-item-completed")).toHaveTextContent("分析需求");
    expect(screen.getByTestId("v2-task-dropdown-item-in_progress")).toHaveTextContent("写代码");
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("写测试");
  });
});
