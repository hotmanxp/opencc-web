# Task 7 Brief

## Task 7: 新增 `BottomStatusBar` 组件（红框位置）



**Files:**
- Create: `packages/zai/src/web/src/components/BottomStatusBar.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

- [ ] **Step 1: 实现组件**

`packages/zai/src/web/src/components/BottomStatusBar.tsx`:

```tsx
import { Popover, Tooltip } from "antd";
import { CaretUpOutlined } from "@ant-design/icons";
import TodoDropdown from "./TodoDropdown.js";
import type { TodoItem, V2TaskItem } from "../store/useAgentStore.js";

type Props = {
  todos: TodoItem[];
  v2Tasks: V2TaskItem[];
  /** 触发按钮文字，默认 "任务"。 */
  label?: string;
};

export function BottomStatusBar({ todos, v2Tasks, label = "任务" }: Props) {
  // 老 TODO (会话内) 与 V2 (跨会话持久) 各自统计
  const todoTotal = todos.length;
  const todoDone = todos.filter((t) => t.status === "completed").length;
  const todoInProgress = todos.filter((t) => t.status === "in_progress").length;
  const todoOpen = todoTotal - todoDone - todoInProgress;

  const v2Total = v2Tasks.length;
  const v2Done = v2Tasks.filter((t) => t.status === "completed").length;
  const v2InProgress = v2Tasks.filter((t) => t.status === "in_progress").length;

  const total = todoTotal + v2Total;
  const done = todoDone + v2Done;
  const inProgress = todoInProgress + v2InProgress;
  const open = todoOpen + (v2Total - v2Done - v2InProgress);

  // 触发器: `N/M 任务 · K 进行中 · J 待开始` + 向上 caret
  const trigger = (
    <div
      data-testid="bottom-status-trigger"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "8px 12px",
        cursor: "pointer",
        background: "rgba(255,255,255,0.04)",
        borderTop: "1px solid rgba(255,255,255,0.10)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        color: total > 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.45)",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        userSelect: "none",
      }}
    >
      {total === 0 ? (
        <span>暂无 {label}</span>
      ) : (
        <span data-testid="bottom-status-summary">
          <span style={{ color: done === total ? "#52c41a" : "rgba(255,255,255,0.85)" }}>
            {done}/{total} {label}
          </span>
          {inProgress > 0 && (
            <span style={{ color: "#a78bfa", marginLeft: 8 }}>
              · {inProgress} 进行中
            </span>
          )}
          {open > 0 && (
            <span style={{ color: "rgba(255,255,255,0.55)", marginLeft: 8 }}>
              · {open} 待开始
            </span>
          )}
        </span>
      )}
      <CaretUpOutlined style={{ fontSize: 10, opacity: 0.7 }} />
    </div>
  );

  return (
    <Popover
      data-testid="bottom-status-popover"
      content={<TodoDropdown todos={todos} v2Tasks={v2Tasks} />}
      trigger="click"
      placement="topRight"
      arrow={false}
      destroyTooltipOnHide
    >
      <Tooltip
        title={total === 0 ? `暂无${label},点击查看历史` : `点击查看${label}详情`}
        placement="top"
      >
        {trigger}
      </Tooltip>
    </Popover>
  );
}
```

- [ ] **Step 2: 在 Agent.tsx 接线**

`packages/zai/src/web/src/pages/Agent.tsx`:

1. 新增 import：

```tsx
import { BottomStatusBar } from "../components/BottomStatusBar";
```

2. 在 Agent 函数体顶部、`todosForCurrentSession` 紧下方追加 v2 任务派生：

```tsx
  const v2TasksForCurrentSession: V2TaskItem[] =
    sessionId != null ? (v2TasksBySession[sessionId] ?? []) : [];
```

并且在组件顶部 useAgentStore 选择器区补一行（与 `todosBySession` 同位置）：

```tsx
  const v2TasksBySession = useAgentStore((s) => s.v2TasksBySession);
```

3. 在 `<div className="bottom-stack">` **内部、`<AgentInputBox />` 之前**插入新组件：

```tsx
        <BottomStatusBar todos={todosForCurrentSession} v2Tasks={v2TasksForCurrentSession} />

        <div className="bottom-stack">
          <AgentInputBox />
```

- [ ] **Step 3: typecheck 验证**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: 通过

- [ ] **Step 4: 浏览器目测**

Run: `pnpm --filter @zn-ai/zai dev`，浏览器打开 `/agent`

预期：
1. 空状态：看到一行 `暂无 任务` + caret
2. 当前会话已发过 TodoWrite 工具：摘要 `X/Y 任务 · K 进行中`
3. 同时有 V2 任务：摘要 `N/M 任务` 合并两条线
4. 点击触发条 → 上方弹出 360px 宽面板：上半 TODO、下半 V2

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/BottomStatusBar.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): add BottomStatusBar above input box for merged TODO + V2 task summary"
```

---
