# Task 8 Brief

## Task 8: 写 `BottomStatusBar` 单元测试



**Files:**
- Create: `packages/zai/src/web/src/components/BottomStatusBar.test.tsx`

- [ ] **Step 1: 写测试**

`packages/zai/src/web/src/components/BottomStatusBar.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
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
    expect(summary).toHaveTextContent("2 待开始"); // 1 老 + 1 v2 pending
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
    expect(greenSpan?.style.color).toBe("rgb(82, 196, 26)") // #52c41a
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
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @zn-ai/zai test -- BottomStatusBar`
Expected: 5 passed

常见失败：
- `findByTestId` 超时 → 改 `await waitFor(() => screen.getByTestId(...))`
- antd Popover 触发需 click 在 data-testid 节点上（已挂在 div 上 ✓）

- [ ] **Step 3: 全量回归**

Run: `pnpm --filter @zn-ai/zai test`
Expected: 全部通过（含已有的 `TaskDrawer.test.tsx`、`useBackgroundTasks.test.ts`、`useAgentStore.test.ts`、`TodoDropdown.test.tsx`、`BottomStatusBar.test.tsx` 等）

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/components/BottomStatusBar.test.tsx
git commit -m "test(zai-web): cover BottomStatusBar empty / merged / green-complete / popover"
```

---
