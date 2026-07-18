// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom";

// 让 mock 工厂在每次 render 读取同一份可变 state — 模拟 "任务从无到有" 的过渡,
// 触发 React #310 (Rendered fewer hooks than expected) 如果组件把 hook 放在
// 条件 return 之后.
const state = vi.hoisted(() => ({
  runningTasks: [] as Array<{ taskId: string; status: string; prompt: string }>,
  recentTasks: [] as Array<{ taskId: string; status: string; prompt: string }>,
  bashTasks: [] as Array<{ taskId: string; status: string; command: string; description: string; startedAt: number }>,
}));

vi.mock("../hooks/useBackgroundTasks.js", () => ({
  useBackgroundTasks: () => ({
    runningTasks: state.runningTasks,
    recentTasks: state.recentTasks,
  }),
}));
vi.mock("../hooks/useBashBackgroundTasks.js", () => ({
  useBashBackgroundTasks: () => ({ tasks: state.bashTasks }),
}));

import { TaskDock } from "./TaskDock.js";

describe("TaskDock — 空态", () => {
  test("无 running / recent / bash 任务时, TaskDock 不渲染任何东西", () => {
    state.runningTasks = [];
    state.recentTasks = [];
    state.bashTasks = [];

    const { container } = render(<TaskDock onSelect={() => {}} />);
    // 修复: 空态隐藏 dock, 不展示"暂无后台任务"占位. 让底栏清爽.
    expect(container.firstChild).toBeNull();
    // 不出现任何 antd Badge / Popover 残留
    expect(screen.queryByText("后台任务")).toBeNull();
  });
});

describe("TaskDock — hooks 顺序稳定 (回归 React #310)", () => {
  test("从空态切到有任务不抛 'Rendered fewer hooks than expected'", () => {
    // 先空
    state.runningTasks = [];
    state.recentTasks = [];
    state.bashTasks = [];
    const { rerender } = render(<TaskDock onSelect={() => {}} />);
    expect(screen.queryByText("后台任务")).toBeNull();

    // 再有任务 — 如果 useMemo / 其他 hook 被错误地放在 early return 之后,
    // 这一步会触发 React #310.
    expect(() => {
      state.runningTasks = [
        { taskId: "t1", status: "running", prompt: "echo hello" },
      ];
      rerender(<TaskDock onSelect={() => {}} />);
    }).not.toThrow();

    // 现在能看到 dock 渲染
    expect(screen.queryByText("后台任务")).not.toBeNull();
  });

  test("从有任务切回空态不抛 React #310", () => {
    state.runningTasks = [{ taskId: "t1", status: "running", prompt: "echo" }];
    state.recentTasks = [];
    state.bashTasks = [];
    const { rerender, container } = render(<TaskDock onSelect={() => {}} />);
    expect(screen.queryByText("后台任务")).not.toBeNull();

    expect(() => {
      state.runningTasks = [];
      state.recentTasks = [];
      state.bashTasks = [];
      rerender(<TaskDock onSelect={() => {}} />);
    }).not.toThrow();

    expect(container.firstChild).toBeNull();
  });
});