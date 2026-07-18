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

  // 修复: 任务全部为空时完全不渲染 (不展示"暂无任务"占位行).
  // 留空让 UI 更紧凑, 状态行的职责下放给 AgentInputBox 的"● 就绪"行.
  if (total === 0) {
    return null;
  }

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
        title={`点击查看${label}详情`}
        placement="top"
      >
        {trigger}
      </Tooltip>
    </Popover>
  );
}