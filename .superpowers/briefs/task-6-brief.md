# Task 6 Brief

## Task 6: 写 `TodoDropdown` 单元测试



**Files:**
- Create: `packages/zai/src/web/src/components/TodoDropdown.test.tsx`

- [ ] **Step 1: 写测试**

`packages/zai/src/web/src/components/TodoDropdown.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import TodoDropdown from "./TodoDropdown.js";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({
  content, status, activeForm: content,
});

const v2 = (id: string, subject: string, status: V2TaskItem["status"], extra: Partial<V2TaskItem> = {}): V2TaskItem => ({
  id, subject, status, blocks: [], blockedBy: [], updatedAt: 0, ...extra,
});

describe("TodoDropdown", () => {
  test("空 todos + 空 v2 渲染 empty 提示", () => {
    render(<TodoDropdown todos={[]} v2Tasks={[]} />);
    expect(screen.getByTestId("todo-dropdown-empty")).toHaveTextContent("暂无任务或 TODO");
    expect(screen.queryByTestId("todo-dropdown")).toBeNull();
  });

  test("仅 todos 时显示 N/M 完成进度 + 三个 data-testid", () => {
    const todos: TodoItem[] = [
      todo("分析需求", "completed"),
      todo("写代码", "in_progress"),
      todo("写测试", "pending"),
    ];
    render(<TodoDropdown todos={todos} v2Tasks={[]} />);
    expect(screen.getByTestId("todo-dropdown")).toBeInTheDocument();
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("1/3 完成");
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("1 进行中");
    expect(screen.getByTestId("todo-dropdown-item-completed")).toHaveTextContent("分析需求");
    expect(screen.getByTestId("todo-dropdown-item-in_progress")).toHaveTextContent("写代码");
    expect(screen.getByTestId("todo-dropdown-item-pending")).toHaveTextContent("写测试");
  });

  test("同时含 todos + v2 时渲染两段", () => {
    render(
      <TodoDropdown
        todos={[todo("老 todo", "in_progress")]}
        v2Tasks={[v2("v1", "V2 任务 A", "pending"), v2("v2", "V2 任务 B", "completed")]}
      />,
    );
    expect(screen.getByTestId("todo-dropdown-item-in_progress")).toHaveTextContent("老 todo");
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("V2 任务 A");
    expect(screen.getByTestId("v2-task-dropdown-item-completed")).toHaveTextContent("V2 任务 B");
    expect(screen.getByTestId("todo-dropdown")).toHaveTextContent("V2 任务清单");
  });

  test("v2 task 含 blockedBy 时显示依赖数量", () => {
    render(
      <TodoDropdown
        todos={[]}
        v2Tasks={[v2("v1", "blocked", "pending", { blockedBy: ["a", "b"] })]}
      />,
    );
    expect(screen.getByTestId("v2-task-dropdown-item-pending")).toHaveTextContent("依赖 2");
  });

  test("v2 task deleted 状态显示 ✗ 删除线", () => {
    render(
      <TodoDropdown todos={[]} v2Tasks={[v2("v1", "deleted one", "deleted")]} />,
    );
    expect(screen.getByTestId("v2-task-dropdown-item-deleted")).toHaveTextContent("deleted one");
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @zn-ai/zai test -- TodoDropdown`
Expected: 5 passed

如果失败：
- `Cannot find module './TodoDropdown.js'` → 检查 import 后缀，本仓库 TSX 测试用 `.js` 后缀（参照 `TaskDrawer.test.tsx:3`）
- `toHaveTextContent` 报错 → 检查是否所有中文中间夹了多余空白

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/TodoDropdown.test.tsx
git commit -m "test(zai-web): cover TodoDropdown empty / progress / V2 / blocked-by / deleted"
```

---
