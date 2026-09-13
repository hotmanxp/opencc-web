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
      className="flex items-center justify-center gap-2 px-3 py-2 cursor-pointer bg-[var(--bg-faint-04)] border-y border-[var(--border-subtle)] text-xs font-[ui-monospace,SFMono-Regular,Menlo,monospace] select-none"
      style={{
        color: total > 0 ? "var(--text-dim-85)" : "var(--text-dim-45)",
      }}
    >
      <span data-testid="bottom-status-summary">
        <span
          style={{ color: done === total ? "#52c41a" : "var(--text-dim-85)" }}
        >
          {done}/{total} {label}
        </span>
        {inProgress > 0 && (
          <span className="text-[#a78bfa] ml-2">· {inProgress} 进行中</span>
        )}
        {open > 0 && (
          <span className="text-[var(--text-dim-55)] ml-2">· {open} 待开始</span>
        )}
      </span>
      <CaretUpOutlined className="text-[10px] opacity-70" />
    </div>
  );

  return (
    <Popover
      data-testid="bottom-status-popover"
      content={<TodoDropdown todos={todos} v2Tasks={v2Tasks} />}
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyTooltipOnHide
    >
      <Tooltip
        title={`点击查看${label}详情`}
        aria-label={`查看${label}详情提示`}
        placement="top"
      >
        {trigger}
      </Tooltip>
    </Popover>
  );
}