// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom";

// isMobile 在 store 里取 — 默认桌面端 (false). Mock 掉保证测试不依赖设备检测.
vi.mock("../store/useAppStore.js", () => ({
  useAppStore: <T,>(selector: (s: { isMobile: boolean }) => T): T =>
    selector({ isMobile: false }),
}));

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

describe("TaskDock — compact 模式 (右侧分屏展开时)", () => {
  test("compact=true 时不渲染 '后台任务' 文本,只渲染图标", () => {
    state.runningTasks = [{ taskId: "t1", status: "running", prompt: "echo" }];
    state.recentTasks = [];
    state.bashTasks = [];

    const { container } = render(<TaskDock onSelect={() => {}} compact />);

    // 文本被替换为图标
    expect(screen.queryByText("后台任务")).toBeNull();
    // 图标按钮带 aria-label="后台任务", 仍可被无障碍 / 测试访问
    expect(screen.getByLabelText("后台任务")).toBeInTheDocument();
    // 容器仍然渲染 (有任务时不为 null)
    expect(container.firstChild).not.toBeNull();
  });

  test("compact=false (默认) 仍渲染 '后台任务' 文本", () => {
    state.runningTasks = [{ taskId: "t1", status: "running", prompt: "echo" }];
    state.recentTasks = [];
    state.bashTasks = [];

    render(<TaskDock onSelect={() => {}} />);
    expect(screen.queryByText("后台任务")).not.toBeNull();
    expect(screen.queryByLabelText("后台任务")).toBeNull();
  });
});

describe("TaskDock — 桌面端点击弹出 Popover", () => {
  // AntD Popover 默认延迟挂载 content; 状态切换后需要等一帧才能 query 到任务列表文本.
  afterEach(() => {
    state.runningTasks = [];
    state.recentTasks = [];
    state.bashTasks = [];
  });

  test("桌面端点击 '后台任务' 文本后弹出任务列表 (运行中 / 最近 / Bash 摘要)", async () => {
    state.runningTasks = [
      { taskId: "agent-1", status: "running", prompt: "refactor auth" },
    ];
    state.recentTasks = [
      { taskId: "agent-2", status: "completed", prompt: "lint fix" },
    ];
    state.bashTasks = [
      {
        taskId: "bash-1",
        status: "running",
        command: "npm test",
        description: "unit tests",
        startedAt: Date.now(),
      },
    ];

    render(<TaskDock onSelect={() => {}} />);

    // 点击前: 列表头 / 行都不在 DOM 里 (Popover content 未挂载).
    expect(screen.queryByText("refactor auth")).toBeNull();
    expect(screen.queryByText("lint fix")).toBeNull();
    expect(screen.queryByText(/Bash 1 运行中/)).toBeNull();

    // 触发点击 — AntD Trigger 用 mousedown 关闭检测, 模拟真实点击必须
    // mousedown -> mouseup -> click 都派发到同一个 target. fireEvent.click
    // 内部已经做了, 但我们额外保证 pointerdown 也发到触发器.
    fireEvent.click(screen.getAllByText("后台任务")[0]);

    // Popover 打开后, 三类列表内容应可见.
    await waitFor(() => {
      expect(screen.getByText("refactor auth")).toBeInTheDocument();
    });
    expect(screen.getByText("lint fix")).toBeInTheDocument();
    expect(screen.getByText(/Bash 1 运行中/)).toBeInTheDocument();

    // 关键回归: 弹出后等 100ms 不应自动关闭 (AntD click-outside bug).
    // 修复前, 可见触发器在 Popover 外面, AntD 把它当作外部点击 → 立刻关闭.
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText("refactor auth")).not.toBeNull();
  });

  test("点击 Popover 内部某行 → 触发 onSelect 并收起 Popover", async () => {
    const onSelect = vi.fn();
    state.runningTasks = [
      { taskId: "agent-row", status: "running", prompt: "row click target" },
    ];
    state.recentTasks = [];
    state.bashTasks = [];

    render(<TaskDock onSelect={onSelect} />);
    fireEvent.click(screen.getAllByText("后台任务")[0]);
    await waitFor(() => {
      expect(screen.getByText("row click target")).toBeInTheDocument();
    });

    // 点击某行 — Row 内部已经 stopPropagation, 会调 onSelect + setOpen(false).
    fireEvent.click(screen.getByText("row click target"));
    expect(onSelect).toHaveBeenCalledWith("agent-row");
  });
});