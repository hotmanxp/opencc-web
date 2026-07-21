import ModelStatusButton from "./ModelStatusButton";
import ModeStatusButton from "./ModeStatusButton";
import { TaskDock } from "./TaskDock";

type Props = {
  cwdName: string;
  /** Per-session cwd (overrides cwdName when provided; e.g., "/Users/me/proj/sub" → renders "sub"). */
  sessionCwd?: string;
  branch: string;
  onTaskSelect: (taskId: string) => void;
  /**
   * 右侧分屏是否展开. 展开时按钮文本做精简(权限模式去掉 (shift+tab) 提示,
   * 后台任务只显示图标),给窄屏幕 / 分屏态腾出横向空间. 默认 false(收起).
   */
  splitPaneOpen?: boolean;
};

export default function ConfigStatusBar({
  cwdName,
  sessionCwd,
  branch,
  onTaskSelect,
  splitPaneOpen = false,
}: Props) {
  // When sessionCwd is provided, show its basename; otherwise fall back to the static cwdName.
  // Browser side has no node:path, so use string split. Empty parts (from leading "/") are filtered.
  const displayName = sessionCwd
    ? sessionCwd.split('/').filter(Boolean).pop() || sessionCwd
    : cwdName

  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.10)",
        padding: "6px 10px",
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        color: "rgba(255,255,255,0.45)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <ModeStatusButton compact={splitPaneOpen} />
      <span style={{ color: "#eab308" }}>{displayName}</span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <span style={{ color: "#22c55e" }}>{branch}</span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <span style={{ color: "#f97316" }}>
        <ModelStatusButton />
      </span>
      <span style={{ color: "rgba(255,255,255,0.25)" }}>·</span>
      <TaskDock onSelect={onTaskSelect} compact={splitPaneOpen} />
    </div>
  );
}