// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom";

// mock 掉 hook: TaskDock 在空态下应不渲染任何东西 (包括 "暂无后台任务")
vi.mock("../hooks/useBackgroundTasks.js", () => ({
  useBackgroundTasks: () => ({
    runningTasks: [],
    recentTasks: [],
  }),
}))
vi.mock("../hooks/useBashBackgroundTasks.js", () => ({
  useBashBackgroundTasks: () => ({ tasks: [] }),
}))

import { TaskDock } from "./TaskDock.js";

describe("TaskDock — 空态", () => {
  test("无 running / recent / bash 任务时, TaskDock 不渲染任何东西", () => {
    const { container } = render(<TaskDock onSelect={() => {}} />);
    // 修复: 空态隐藏 dock, 不展示"暂无后台任务"占位. 让底栏清爽.
    expect(container.firstChild).toBeNull();
    // 不出现任何 antd Badge / Popover 残留
    expect(screen.queryByText("后台任务")).toBeNull();
  });
});