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
      data-testid="config-status-bar"
      style={{
        background: "var(--bg-card-hover)",
        borderTop: "1px solid var(--border-subtle)",
        padding: "6px 10px",
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        color: "var(--text-tertiary)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {/* ModeStatusButton 内部从 useAppStore.isMobile 自动判断移动端.
          splitPaneOpen 是分屏局部状态, 仍以 prop 形式传入. */}
      <ModeStatusButton compact={splitPaneOpen} />
      <span style={{ color: "#eab308" }}>{displayName}</span>
      <span style={{ color: "var(--text-tertiary)" }}>·</span>
      <span style={{ color: "var(--success)" }}>{branch}</span>
      <span style={{ color: "var(--text-tertiary)" }}>·</span>
      <span style={{ color: "var(--accent-start)" }}>
        <ModelStatusButton compact={splitPaneOpen} />
      </span>
      <span style={{ color: "var(--text-tertiary)" }}>·</span>
      <TaskDock onSelect={onTaskSelect} compact={splitPaneOpen} />
    </div>
  );
}